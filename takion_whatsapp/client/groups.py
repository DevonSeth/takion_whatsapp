"""WhatsApp Groups API (Entrega 12) -- Meta's Business Platform Groups surface, a
separate API from regular messaging: create/edit a group, manage participants and
join requests, and route the 4 group-lifecycle webhook types frappe_whatsapp has
no concept of at all (grep-confirmed against frappe_whatsapp/utils/webhook.py:
it only ever branches on "messages" being present or field ==
"message_template_status_update" -- any of the 4 group event types fall straight
into a silent no-op today, same failure class as the wamid-dedup and ctwa_clid
findings from Entregas 3/8, one layer higher: not "wrong endpoint", but "wrong
payload shape within the same endpoint").

Requires the business number to be an Official Business Account (OBA) -- none of
Takion's numbers have this yet (see takion_whatsapp_grupos_decisions memory), so
none of the real HTTP calls below have been exercised against Meta. Built and
documented anyway per that decision; client/sandbox.py's simulate_group_webhook
is the only way to exercise the webhook-handling half of this module until a real
OBA exists.

Design note on the 4 webhook types: only the dispatch-by-field-name and the
top-level `value["groups"]` array shape were independently re-confirmed this
session (a direct WebFetch of Meta's own group-webhooks reference page came back
as an unrendered JS shell, unlike the earlier grounded pass that produced
takion_whatsapp_grupos_design_2026_07_30's other findings) -- so per-event field
names (exact participant-action shape, request_id's precise location) are NOT
trusted blindly. Every webhook is treated as a "something changed, go re-fetch
this group" nudge rather than a source of truth for its own payload fields:
reconcile_group() below re-derives real state from GET /<GROUP_ID> (whose
response shape WAS confirmed by the original research: subject, description,
participants, join_approval_mode, suspended, total_participant_count), and
reconcile_pending_groups() (the scheduled safety net, same 5-minute cron as
Entrega 9) falls back to LIST + match-by-subject for a group still stuck
Pendente, which needs no webhook payload at all. If a future session gets a real
payload sample (from Meta once an OBA lands, or a captured example from the
user), tighten the per-field webhook parsing then -- don't guess further now.

Outbound sending needs NO new function here: once a group's WhatsApp Conversation
exists (wa_id = the group_id, see _ensure_group_conversation), client/inbox.py's
existing send_message/send_media_message/send_audio_message already work
unmodified -- they only ever depend on conversation.wa_id and reference_name.
The one real gap (recipient_type: "group" missing from the outbound payload) is
patched separately, via a WhatsAppMessageGroupSendMixin on notify() (see
hooks.py's extend_doctype_class) -- not duplicated here.
"""
import json

import frappe
import requests
from frappe import _
from frappe.model.document import Document

from takion_whatsapp.client import contacts
from takion_whatsapp.utils import normalize_phone_number

# Real cap on the Groups API itself (independent of, and coincidentally equal to,
# the batch size DELETE .../participants accepts per call) -- NOT the regular
# WhatsApp 1024-member group cap. Informational only: no endpoint exists for us
# to add participants ourselves (the only way anyone joins is the invite link).
MAX_PARTICIPANTS = 8

SUBJECT_MAX_LENGTH = 128
DESCRIPTION_MAX_LENGTH = 2048

GROUP_WEBHOOK_FIELDS = (
	"group_lifecycle_update",
	"group_participants_update",
	"group_settings_update",
	"group_status_update",
)

GROUP_INFO_FIELDS = "subject,description,join_approval_mode,participants,suspended,total_participant_count"

# Webhook confirmation should land in seconds; this is only the safety-net sweep
# (client/groups.py::reconcile_pending_groups, same 5-minute cron as Entrega 9)
# kicking in for a group whose webhook never arrived.
RECONCILE_PENDING_AFTER_MINUTES = 30


def _account_for_channel(channel):
	whatsapp_account = frappe.db.get_value("WhatsApp Channel", channel, "whatsapp_account")
	if not whatsapp_account:
		frappe.throw(_("Canal sem WhatsApp Account configurada."))
	return frappe.get_doc("WhatsApp Account", whatsapp_account)


def _graph_url(account, *segments):
	return "/".join([f"{account.url}/{account.version}"] + [str(s) for s in segments])


def _graph_call(account, method, url, **kwargs):
	headers = {"Authorization": f"Bearer {account.get_password('token')}"}
	try:
		response = requests.request(method, url, headers=headers, timeout=30, **kwargs)
	except requests.RequestException as e:
		frappe.throw(_("Falha de rede ao chamar a API de Grupos do WhatsApp: {0}").format(str(e)))

	if response.status_code >= 400:
		frappe.log_error(title="WhatsApp Groups API error", message=f"{method} {url}\n{response.text}")
		frappe.throw(_extract_error(response), title=_("Erro na API de Grupos do WhatsApp"))
	return response.json() if response.content else {}


def _extract_error(response):
	try:
		return response.json().get("error", {}).get("message") or response.text
	except ValueError:
		return response.text


@frappe.whitelist()
def create_group(channel, subject, description=None, join_approval_mode="auto_approve"):
	"""Creation is ASYNCHRONOUS on Meta's side -- this only records the intent
	(status Pendente) and stashes the request_id Meta returns; the real
	confirmation (group_id + invite_link, or a failure) arrives later via
	group_lifecycle_update (handle_group_webhook) or, if that never lands,
	reconcile_pending_groups' periodic sweep.
	"""
	if len(subject) > SUBJECT_MAX_LENGTH:
		frappe.throw(_("Assunto do grupo excede {0} caracteres.").format(SUBJECT_MAX_LENGTH))
	if description and len(description) > DESCRIPTION_MAX_LENGTH:
		frappe.throw(_("Descrição do grupo excede {0} caracteres.").format(DESCRIPTION_MAX_LENGTH))

	account = _account_for_channel(channel)
	payload = {"subject": subject, "join_approval_mode": join_approval_mode}
	if description:
		payload["description"] = description

	response = _graph_call(account, "POST", _graph_url(account, account.phone_id, "groups"), json=payload)

	doc = frappe.new_doc("WhatsApp Group")
	doc.channel = channel
	doc.subject = subject
	doc.description = description
	doc.join_approval_mode = join_approval_mode
	doc.status = "Pendente"
	doc.pending_request_id = response.get("request_id") or response.get("id") or ""
	doc.insert(ignore_permissions=True)
	return doc.name


@frappe.whitelist()
def update_group(name, subject=None, description=None):
	"""Editing is ALSO asynchronous (group_settings_update, same pattern as
	creation) -- subject/description are applied optimistically here so the
	operator isn't looking at stale text while confirmation is pending, then
	overwritten again (idempotently) whenever reconcile_group runs for real.
	join_approval_mode is deliberately not editable here -- Meta's own update
	endpoint doesn't accept it, it's fixed at creation time.
	"""
	doc = frappe.get_doc("WhatsApp Group", name)
	if not doc.group_id:
		frappe.throw(_("Grupo ainda pendente de confirmação -- aguarde antes de editar."))
	if subject and len(subject) > SUBJECT_MAX_LENGTH:
		frappe.throw(_("Assunto do grupo excede {0} caracteres.").format(SUBJECT_MAX_LENGTH))
	if description and len(description) > DESCRIPTION_MAX_LENGTH:
		frappe.throw(_("Descrição do grupo excede {0} caracteres.").format(DESCRIPTION_MAX_LENGTH))

	payload = {}
	if subject:
		payload["subject"] = subject
	if description is not None:
		payload["description"] = description
	if not payload:
		return doc.name

	account = _account_for_channel(doc.channel)
	response = _graph_call(account, "POST", _graph_url(account, doc.group_id), json=payload)

	updates = {"pending_update_request_id": response.get("request_id") or ""}
	if subject:
		updates["subject"] = subject
	if description is not None:
		updates["description"] = description
	doc.db_set(updates, update_modified=False)
	return doc.name


@frappe.whitelist()
def delete_group(name):
	doc = frappe.get_doc("WhatsApp Group", name)
	if not doc.group_id:
		frappe.throw(_("Grupo ainda pendente de confirmação."))
	account = _account_for_channel(doc.channel)
	_graph_call(account, "DELETE", _graph_url(account, doc.group_id))
	doc.db_set("status", "Excluído", update_modified=False)


@frappe.whitelist()
def reset_invite_link(name):
	doc = frappe.get_doc("WhatsApp Group", name)
	if not doc.group_id:
		frappe.throw(_("Grupo ainda pendente de confirmação."))
	account = _account_for_channel(doc.channel)
	response = _graph_call(account, "POST", _graph_url(account, doc.group_id, "invite_link"))
	invite_link = response.get("invite_link") or response.get("link")
	doc.db_set("invite_link", invite_link, update_modified=False)
	return invite_link


@frappe.whitelist()
def remove_participants(name, wa_ids):
	"""wa_ids: list (or JSON-encoded list) of up to MAX_PARTICIPANTS entries --
	Meta's own DELETE .../participants batch cap, which coincidentally matches
	the group's own total member cap.
	"""
	if isinstance(wa_ids, str):
		wa_ids = frappe.parse_json(wa_ids)
	if len(wa_ids) > MAX_PARTICIPANTS:
		frappe.throw(_("No máximo {0} participantes por chamada.").format(MAX_PARTICIPANTS))

	doc = frappe.get_doc("WhatsApp Group", name)
	if not doc.group_id:
		frappe.throw(_("Grupo ainda pendente de confirmação."))

	account = _account_for_channel(doc.channel)
	_graph_call(account, "DELETE", _graph_url(account, doc.group_id, "participants"), json={"participants": wa_ids})

	doc.participants = [row for row in doc.participants if row.wa_id not in wa_ids]
	doc.total_participant_count = len(doc.participants)
	doc.save(ignore_permissions=True)


@frappe.whitelist()
def list_join_requests(name):
	doc = frappe.get_doc("WhatsApp Group", name)
	if not doc.group_id:
		return []
	account = _account_for_channel(doc.channel)
	response = _graph_call(account, "GET", _graph_url(account, doc.group_id, "join_requests"))
	return response.get("data") or response.get("join_requests") or []


@frappe.whitelist()
def approve_join_requests(name, join_request_ids):
	return _resolve_join_requests(name, join_request_ids, approve=True)


@frappe.whitelist()
def reject_join_requests(name, join_request_ids):
	return _resolve_join_requests(name, join_request_ids, approve=False)


def _resolve_join_requests(name, join_request_ids, approve):
	if isinstance(join_request_ids, str):
		join_request_ids = frappe.parse_json(join_request_ids)
	doc = frappe.get_doc("WhatsApp Group", name)
	if not doc.group_id:
		frappe.throw(_("Grupo ainda pendente de confirmação."))
	account = _account_for_channel(doc.channel)
	method = "POST" if approve else "DELETE"
	_graph_call(
		account, method, _graph_url(account, doc.group_id, "join_requests"),
		json={"join_request_ids": join_request_ids},
	)


@frappe.whitelist()
def refresh_group(name):
	"""Manual "Atualizar" action for the operator -- forces the same GET-based
	resync the webhook/scheduler would eventually trigger, without waiting.
	"""
	doc = frappe.get_doc("WhatsApp Group", name)
	if not doc.group_id:
		frappe.throw(_("Ainda aguardando a confirmação da criação -- não há nada pra atualizar."))
	reconcile_group(name)


@frappe.whitelist()
def get_group_panel_data(conversation):
	"""Feeds the inbox's "Dados do grupo" panel (replaces "Dados do contato" when
	conversation.whatsapp_group is set)."""
	group_name = frappe.db.get_value("WhatsApp Conversation", conversation, "whatsapp_group")
	if not group_name:
		return None

	doc = frappe.get_doc("WhatsApp Group", group_name)
	join_requests = (
		list_join_requests(group_name) if doc.group_id and doc.join_approval_mode == "approval_required" else []
	)
	return {
		"name": doc.name,
		"subject": doc.subject,
		"description": doc.description,
		"join_approval_mode": doc.join_approval_mode,
		"invite_link": doc.invite_link,
		"total_participant_count": doc.total_participant_count,
		"max_participants": MAX_PARTICIPANTS,
		"status": doc.status,
		"error_message": doc.error_message,
		"participants": [
			{
				"wa_id": p.wa_id,
				"phone_number": p.phone_number,
				"profile_name": p.profile_name,
				"contact": p.contact,
			}
			for p in doc.participants
		],
		"join_requests": join_requests,
	}


def reconcile_group(name, info=None):
	"""Re-derives real group state from GET /<GROUP_ID> (confirmed response shape)
	-- called from handle_group_webhook (as a nudge-triggered resync) and from
	refresh_group (operator-triggered). Never guesses from a webhook's own
	payload fields, see module docstring.

	`info` lets a caller supply an already-fetched response instead of hitting
	the real Graph API -- the ONLY consumer of this is client/sandbox.py, which
	has no live Meta group to GET but still wants to exercise this exact
	state-mutation code (participant sync, status, conversation creation) end
	to end.
	"""
	doc = frappe.get_doc("WhatsApp Group", name)
	if not doc.group_id:
		return
	if info is None:
		account = _account_for_channel(doc.channel)
		info = _graph_call(account, "GET", _graph_url(account, doc.group_id), params={"fields": GROUP_INFO_FIELDS})

	participants = info.get("participants") or []
	doc.subject = info.get("subject") or doc.subject
	doc.description = info.get("description")
	doc.total_participant_count = info.get("total_participant_count") or len(participants)
	doc.status = "Suspenso" if info.get("suspended") else "Ativo"
	doc.pending_update_request_id = ""
	doc.last_reconciled_at = frappe.utils.now_datetime()
	_sync_participants(doc, participants)
	doc.save(ignore_permissions=True)

	_ensure_group_conversation(doc)


def _sync_participants(doc, participants):
	"""Mutates doc.participants in place -- GET's participants list is
	authoritative: anyone Meta no longer reports is dropped (left/removed),
	anyone new is appended, resolved through the same Contact-dedup pipeline
	1:1 conversations use (client/contacts.py) so a group member who's already
	a Contact resolves onto the SAME record.
	"""
	existing_wa_ids = {row.wa_id for row in doc.participants if row.wa_id}
	reported_wa_ids = set()

	for p in participants:
		wa_id = p.get("wa_id") or p.get("id")
		if not wa_id:
			continue
		reported_wa_ids.add(wa_id)
		if wa_id in existing_wa_ids:
			continue
		doc.append("participants", {
			"wa_id": wa_id,
			"phone_number": normalize_phone_number(wa_id),
			"profile_name": (p.get("profile") or {}).get("name"),
			"contact": contacts.resolve_or_create_contact(wa_id),
			"joined_at": frappe.utils.now_datetime(),
		})

	doc.participants = [row for row in doc.participants if not row.wa_id or row.wa_id in reported_wa_ids]


def _ensure_group_conversation(doc):
	"""Creates (or re-links wa_id on) the WhatsApp Conversation this group's
	thread lives in -- only possible once group_id is known. wa_id is set to
	the group_id itself so client/inbox.py's existing send_message/
	send_media_message/send_audio_message work completely unmodified for a
	group conversation (they only ever read conversation.wa_id + reference_name).
	"""
	if not doc.group_id:
		return

	existing = frappe.db.get_value("WhatsApp Conversation", {"whatsapp_group": doc.name})
	if existing:
		if frappe.db.get_value("WhatsApp Conversation", existing, "wa_id") != doc.group_id:
			frappe.db.set_value("WhatsApp Conversation", existing, "wa_id", doc.group_id, update_modified=False)
		return

	conversation = frappe.new_doc("WhatsApp Conversation")
	conversation.channel = doc.channel
	conversation.whatsapp_group = doc.name
	conversation.wa_id = doc.group_id
	conversation.phone_number_display = doc.subject
	conversation.insert(ignore_permissions=True)

	frappe.publish_realtime("whatsapp_inbox_update", {"conversation": conversation.name}, after_commit=True)


def handle_group_webhook(field, value):
	"""Dispatched from client/internal_webhook.py::receive() when changes[].field
	is one of GROUP_WEBHOOK_FIELDS -- frappe_whatsapp's own webhook() handler is
	never called for these (see module docstring). Every raw payload is logged
	(same "WhatsApp Notification Log" doctype frappe_whatsapp's own webhook.py
	logs every delivery to) before any parsing, so nothing is silently lost even
	if the parsing below misses a field this session couldn't independently
	confirm.
	"""
	frappe.get_doc({
		"doctype": "WhatsApp Notification Log",
		"template": f"Webhook (Groups: {field})",
		"meta_data": json.dumps(value),
	}).insert(ignore_permissions=True)

	for group_event in value.get("groups") or []:
		group_id = group_event.get("group_id") or group_event.get("id")
		request_id = group_event.get("request_id")

		doc_name = frappe.db.get_value("WhatsApp Group", {"group_id": group_id}) if group_id else None

		if not doc_name and field == "group_lifecycle_update":
			doc_name = _resolve_pending_create(request_id, group_event)
			continue  # _resolve_pending_create already reconciles on success

		if doc_name:
			reconcile_group(doc_name)


def _resolve_pending_create(request_id, group_event):
	"""Correlates a group_lifecycle_update (type group_create) confirmation back
	to the WhatsApp Group that requested it, via the request_id create_group()
	stashed. If Meta's exact success/error shape here doesn't match what's
	guessed below, reconcile_pending_groups' LIST+match-by-subject sweep is the
	fallback that still gets this group out of Pendente eventually.
	"""
	if not request_id:
		return None
	doc_name = frappe.db.get_value("WhatsApp Group", {"pending_request_id": request_id, "status": "Pendente"})
	if not doc_name:
		return None

	group_id = group_event.get("group_id") or group_event.get("id")
	error = group_event.get("error") or group_event.get("errors")

	if error or not group_id:
		frappe.db.set_value("WhatsApp Group", doc_name, {
			"status": "Falhou",
			"error_message": json.dumps(error) if error else _("Meta não retornou um group_id para esta criação."),
			"pending_request_id": "",
		}, update_modified=False)
		return doc_name

	frappe.db.set_value("WhatsApp Group", doc_name, {"group_id": group_id, "pending_request_id": ""}, update_modified=False)
	reconcile_group(doc_name)
	return doc_name


def reconcile_pending_groups():
	"""Scheduled safety net (folded into Entrega 9's existing 5-minute cron, see
	hooks.py) for a group whose create-confirmation webhook never arrived within
	RECONCILE_PENDING_AFTER_MINUTES. Falls back to LIST /<PHONE_NUMBER_ID>/groups
	+ match-by-subject, which needs no webhook payload shape at all -- only the
	confirmed LIST/create request/response fields.
	"""
	threshold = frappe.utils.add_to_date(frappe.utils.now_datetime(), minutes=-RECONCILE_PENDING_AFTER_MINUTES)
	stragglers = frappe.get_all(
		"WhatsApp Group",
		filters={"status": "Pendente", "creation": ["<", threshold]},
		fields=["name", "channel", "subject"],
	)
	for group in stragglers:
		try:
			_reconcile_via_list(group)
		except Exception:
			frappe.log_error(title=f"WhatsApp Groups reconciliation failed: {group.name}")


def _reconcile_via_list(group):
	account = _account_for_channel(group.channel)
	response = _graph_call(account, "GET", _graph_url(account, account.phone_id, "groups"))
	all_groups = response.get("data") or response.get("groups") or []

	candidates = [
		g for g in all_groups
		if g.get("subject") == group.subject
		and not frappe.db.exists("WhatsApp Group", {"group_id": g.get("id") or g.get("group_id")})
	]
	if len(candidates) != 1:
		# Ambiguous (no unclaimed match, or more than one group shares this
		# subject) -- leave Pendente for a human to resolve rather than guess.
		return

	group_id = candidates[0].get("id") or candidates[0].get("group_id")
	frappe.db.set_value("WhatsApp Group", group.name, {"group_id": group_id, "pending_request_id": ""}, update_modified=False)
	reconcile_group(group.name)


class WhatsAppMessageGroupSendMixin(Document):
	"""extend_doctype_class mixin (see hooks.py) -- the one real gap in reusing
	frappe_whatsapp's WhatsAppMessage.send_outgoing()/notify() completely
	unmodified for a group send: it never sets `recipient_type`, which Meta
	requires as "group" (instead of the implicit default "individual") whenever
	`to` is a group_id rather than a phone number.

	notify(self, data) is the surgical override point -- send_outgoing() already
	builds the full payload and calls self.notify(data) right before the actual
	POST, so this only injects one key rather than re-implementing any of
	send_outgoing()'s own content-type branching. reference_name is already set
	by the time this runs (before_insert): every outgoing-send call site in this
	app (client/inbox.py::send_message/send_media_message,
	client/audio.py::convert_and_send) sets reference_doctype/reference_name
	before .insert(), same as any other outgoing message.
	"""
	def notify(self, data):
		if self.reference_doctype == "WhatsApp Conversation" and self.reference_name:
			if frappe.db.get_value("WhatsApp Conversation", self.reference_name, "whatsapp_group"):
				data["recipient_type"] = "group"
		super().notify(data)
