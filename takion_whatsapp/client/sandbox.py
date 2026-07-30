"""Sandbox de teste manual — cria e gerencia um WhatsApp Account/Channel/Conversation
FICTÍCIOS, claramente rotulados, pra exercitar as funções já construídas (enviar
texto/áudio/imagem/vídeo/documento, receber mensagem, SLA, custo, funil) sem
depender do número real de teste da Meta (WA-1, ver takion_whatsapp_wa1_status
na memória do projeto — ainda pendente).

O WhatsApp Account do sandbox nunca é marcado como default
(is_default_incoming/is_default_outgoing ficam 0) -- não deve interferir
quando uma conta real for configurada depois. Isso também significa que
ENVIAR (Outgoing) a partir da conversa de sandbox continua batendo na mesma
trava real de "nenhuma conta padrão configurada" que qualquer outra conversa
bate hoje -- intencional, é o limite real do sistema, não um bug do sandbox.
Só RECEBER (simulate_incoming) contorna essa trava, porque ali somos nós
mesmos simulando o papel do Meta, e setamos o whatsapp_account explicitamente
em vez de depender do lookup de conta padrão.

Restrito a System Manager: simular uma mensagem recebida insere um WhatsApp
Message "Incoming" de verdade (mesmo caminho de código de um webhook real,
incluindo os hooks de after_insert) -- não deve ficar disponível pra qualquer
operador injetar mensagens fabricadas em conversas de verdade.
"""
import json

import frappe
from frappe import _
from frappe.desk.doctype.tag.tag import add_tag

from takion_whatsapp.client import groups
from takion_whatsapp.client.conversation import get_or_create_conversation

SANDBOX_ACCOUNT_NAME = "Sandbox de Teste (não usar em produção)"
SANDBOX_PHONE_ID = "sandbox-000000000000"
SANDBOX_PHONE_NUMBER = "000000000000"
SANDBOX_DISPLAY_NAME = "🧪 Sandbox de Teste"
SANDBOX_TAG = "WhatsApp Sandbox"

SIMULATABLE_CONTENT_TYPES = ("text", "image", "video", "document", "audio")


@frappe.whitelist()
def ensure_sandbox_conversation():
	"""Idempotent: creates the sandbox account/channel/conversation on first call,
	just returns the existing conversation name on every call after that."""
	frappe.only_for("System Manager")

	if not frappe.db.exists("WhatsApp Account", SANDBOX_ACCOUNT_NAME):
		frappe.get_doc({
			"doctype": "WhatsApp Account",
			"account_name": SANDBOX_ACCOUNT_NAME,
			"phone_id": SANDBOX_PHONE_ID,
			"status": "Inactive",
			"is_default_incoming": 0,
			"is_default_outgoing": 0,
		}).insert(ignore_permissions=True)

	channel_name = frappe.db.get_value("WhatsApp Channel", {"whatsapp_account": SANDBOX_ACCOUNT_NAME}, "name")
	if not channel_name:
		channel_name = frappe.get_doc({
			"doctype": "WhatsApp Channel",
			"whatsapp_account": SANDBOX_ACCOUNT_NAME,
			"phone_number_id": SANDBOX_PHONE_ID,
			"internal_shared_secret": frappe.generate_hash(length=16),
		}).insert(ignore_permissions=True).name

	conv = get_or_create_conversation(channel_name, SANDBOX_PHONE_NUMBER, SANDBOX_PHONE_NUMBER)
	if conv.phone_number_display != SANDBOX_DISPLAY_NAME:
		conv.phone_number_display = SANDBOX_DISPLAY_NAME
		conv.save(ignore_permissions=True)
	if SANDBOX_TAG not in (conv.get("_user_tags") or ""):
		add_tag(SANDBOX_TAG, "WhatsApp Conversation", conv.name)

	return conv.name


@frappe.whitelist()
def simulate_incoming(conversation, content_type, message=None, file_url=None):
	"""Inserts an Incoming WhatsApp Message exactly as the real webhook would
	(same after_insert hooks: conversation linking, pricing, SLA, optout),
	skipping only the "download the file from Meta's servers" step -- file_url
	is whatever the sandbox dialog already uploaded via upload_file, standing
	in for what a real download would have produced.
	"""
	frappe.only_for("System Manager")
	_assert_sandbox_conversation(conversation)

	if content_type not in SIMULATABLE_CONTENT_TYPES:
		frappe.throw(_("Tipo não suportado para simulação: {0}").format(content_type))

	doc = frappe.new_doc("WhatsApp Message")
	doc.type = "Incoming"
	doc.whatsapp_account = SANDBOX_ACCOUNT_NAME  # bypasses the default-account lookup entirely
	doc.content_type = content_type
	doc.set("from", SANDBOX_PHONE_NUMBER)
	doc.message = message
	if file_url:
		doc.attach = file_url
	doc.insert(ignore_permissions=True)
	return doc.name


@frappe.whitelist()
def clear_sandbox_messages(conversation):
	"""Wipes messages so the sandbox conversation can be reused clean, without
	tearing down the account/channel/conversation themselves."""
	frappe.only_for("System Manager")
	_assert_sandbox_conversation(conversation)

	for name in frappe.get_all(
		"WhatsApp Message",
		filters={"reference_doctype": "WhatsApp Conversation", "reference_name": conversation},
		pluck="name",
	):
		frappe.delete_doc("WhatsApp Message", name, ignore_permissions=True, force=True)

	frappe.db.set_value(
		"WhatsApp Conversation",
		conversation,
		{"last_message_preview": "", "last_direction": None, "first_unanswered_inbound_at": None, "sla_state": "OK"},
		update_modified=False,
	)


def _assert_sandbox_conversation(conversation):
	if not frappe.db.exists("WhatsApp Conversation", {"name": conversation, "phone_number": SANDBOX_PHONE_NUMBER}):
		frappe.throw(_("Esta ação só é permitida na conversa de sandbox."))


# Entrega 12 ("Grupos"): a WhatsApp Group has no phone number to key a sandbox
# check off of (unlike the 1:1 conversation above), so sandbox groups are
# recognized by channel instead -- the SAME sandbox WhatsApp Channel
# ensure_sandbox_conversation() already creates/reuses. No OBA exists in any
# Takion environment (see takion_whatsapp_grupos_decisions memory), so none of
# client/groups.py's real Graph API calls (create_group, reconcile_group's
# default path, etc.) are reachable in a sandbox context -- every function
# below drives the exact same state-mutation code those real flows use
# (groups.reconcile_group with a fabricated `info`), just skipping the actual
# HTTP call to Meta, the same "real code path minus the live network call"
# principle simulate_incoming above already applies to messages.

def _sandbox_channel_name():
	return frappe.db.get_value("WhatsApp Channel", {"whatsapp_account": SANDBOX_ACCOUNT_NAME})


def _assert_sandbox_group(doc):
	if doc.channel != _sandbox_channel_name():
		frappe.throw(_("Esta ação só é permitida em um grupo de sandbox."))


@frappe.whitelist()
def get_sandbox_group():
	"""Most recent non-deleted sandbox group, if any -- feeds the "Testar Grupo"
	dialog so it always resumes wherever the last test left off instead of
	forcing a fresh create every time the dialog reopens."""
	frappe.only_for("System Manager")
	channel_name = _sandbox_channel_name()
	if not channel_name:
		return None
	name = frappe.db.get_value(
		"WhatsApp Group", {"channel": channel_name, "status": ["!=", "Excluído"]},
		"name", order_by="creation desc",
	)
	return _group_snapshot(name) if name else None


def _group_snapshot(name):
	doc = frappe.get_doc("WhatsApp Group", name)
	return {
		"name": doc.name,
		"subject": doc.subject,
		"status": doc.status,
		"group_id": doc.group_id,
		"participants": [{"wa_id": p.wa_id, "profile_name": p.profile_name} for p in doc.participants],
	}


@frappe.whitelist()
def create_sandbox_group(subject=None, join_approval_mode="auto_approve"):
	"""Mirrors client/groups.py::create_group's effect (a Pendente WhatsApp Group
	with a fabricated pending_request_id) without the real POST .../groups --
	lets "Novo Grupo" be exercised end to end in the sandbox before confirming
	via simulate_group_created below.
	"""
	frappe.only_for("System Manager")
	ensure_sandbox_conversation()  # idempotent: makes sure the sandbox account/channel exist
	doc = frappe.new_doc("WhatsApp Group")
	doc.channel = _sandbox_channel_name()
	doc.subject = subject or f"Grupo de teste {frappe.utils.now_datetime().strftime('%H:%M:%S')}"
	doc.join_approval_mode = join_approval_mode
	doc.status = "Pendente"
	doc.pending_request_id = f"sandbox-req-{frappe.generate_hash(length=8)}"
	doc.insert(ignore_permissions=True)
	return doc.name


@frappe.whitelist()
def simulate_group_created(group):
	"""Simulates the group_lifecycle_update confirmation for a Pendente sandbox
	group -- fabricates a group_id (no real Meta group exists) and drives
	groups.reconcile_group with a fabricated `info`, the exact same
	state-mutation code (participant sync, status, WhatsApp Conversation
	creation) any real confirmation runs.
	"""
	frappe.only_for("System Manager")
	doc = frappe.get_doc("WhatsApp Group", group)
	_assert_sandbox_group(doc)
	if doc.group_id:
		frappe.throw(_("Este grupo já foi confirmado."))

	frappe.db.set_value(
		"WhatsApp Group", group,
		{"group_id": f"sandbox-group-{frappe.generate_hash(length=10)}", "pending_request_id": ""},
		update_modified=False,
	)
	groups.reconcile_group(group, info={
		"subject": doc.subject, "description": doc.description,
		"participants": [], "suspended": False, "total_participant_count": 0,
	})


@frappe.whitelist()
def simulate_group_participant_join(group, wa_id, profile_name=None):
	frappe.only_for("System Manager")
	doc = frappe.get_doc("WhatsApp Group", group)
	_assert_sandbox_group(doc)
	if not doc.group_id:
		frappe.throw(_("Confirme a criação do grupo primeiro (Simular criação)."))

	participants = [{"wa_id": row.wa_id, "profile": {"name": row.profile_name}} for row in doc.participants]
	participants.append({"wa_id": wa_id, "profile": {"name": profile_name}})
	groups.reconcile_group(group, info={
		"subject": doc.subject, "description": doc.description,
		"participants": participants, "suspended": False, "total_participant_count": len(participants),
	})


@frappe.whitelist()
def simulate_group_participant_leave(group, wa_id):
	frappe.only_for("System Manager")
	doc = frappe.get_doc("WhatsApp Group", group)
	_assert_sandbox_group(doc)
	if not doc.group_id:
		frappe.throw(_("Confirme a criação do grupo primeiro (Simular criação)."))

	participants = [
		{"wa_id": row.wa_id, "profile": {"name": row.profile_name}}
		for row in doc.participants if row.wa_id != wa_id
	]
	groups.reconcile_group(group, info={
		"subject": doc.subject, "description": doc.description,
		"participants": participants, "suspended": False, "total_participant_count": len(participants),
	})


@frappe.whitelist()
def simulate_incoming_group_message(group, wa_id, content_type="text", message=None, file_url=None, profile_name=None):
	"""Group counterpart of simulate_incoming above -- inserts a real Incoming
	WhatsApp Message from a participant of a sandbox group (same after_insert
	hooks fire: conversation linking, now via the group-routing path in
	client/conversation.py, plus pricing/SLA/optout). Stashes a minimal fake
	raw payload on frappe.local.flags so that group-routing path (which reads
	group_id from the raw Meta payload in production) has something to find --
	correlated by message_id, same mechanism a real webhook uses.
	"""
	frappe.only_for("System Manager")
	doc = frappe.get_doc("WhatsApp Group", group)
	_assert_sandbox_group(doc)
	if not doc.group_id:
		frappe.throw(_("Confirme a criação do grupo primeiro (Simular criação)."))
	if content_type not in SIMULATABLE_CONTENT_TYPES:
		frappe.throw(_("Tipo não suportado para simulação: {0}").format(content_type))

	fake_message_id = f"sandbox-msg-{frappe.generate_hash(length=10)}"
	frappe.local.flags.takion_whatsapp_raw_payload = json.dumps({
		"entry": [{"changes": [{"value": {"messages": [{"id": fake_message_id, "group_id": doc.group_id}]}}]}],
	})
	try:
		msg = frappe.new_doc("WhatsApp Message")
		msg.type = "Incoming"
		msg.whatsapp_account = SANDBOX_ACCOUNT_NAME
		msg.content_type = content_type
		msg.message_id = fake_message_id
		msg.set("from", wa_id)
		msg.message = message
		msg.profile_name = profile_name
		if file_url:
			msg.attach = file_url
		msg.insert(ignore_permissions=True)
	finally:
		frappe.local.flags.takion_whatsapp_raw_payload = None
	return msg.name


@frappe.whitelist()
def clear_sandbox_groups():
	"""Full teardown (unlike clear_sandbox_messages' reusable 1:1 conversation) --
	sandbox groups are cheap to recreate via create_sandbox_group, so each test
	pass starts clean rather than accumulating fixture groups over time."""
	frappe.only_for("System Manager")
	channel_name = _sandbox_channel_name()
	if not channel_name:
		return

	for name in frappe.get_all("WhatsApp Group", filters={"channel": channel_name}, pluck="name"):
		conversation = frappe.db.get_value("WhatsApp Conversation", {"whatsapp_group": name})
		if conversation:
			for msg_name in frappe.get_all(
				"WhatsApp Message",
				filters={"reference_doctype": "WhatsApp Conversation", "reference_name": conversation},
				pluck="name",
			):
				frappe.delete_doc("WhatsApp Message", msg_name, ignore_permissions=True, force=True)
			frappe.delete_doc("WhatsApp Conversation", conversation, ignore_permissions=True, force=True)
		frappe.delete_doc("WhatsApp Group", name, ignore_permissions=True, force=True)
