"""Groups frappe_whatsapp's "WhatsApp Message" documents into a "WhatsApp Conversation"
per (channel, phone number), resolving or creating the linked Contact.

Wired via hooks.py doc_events on "WhatsApp Message" (after_insert), alongside — not
instead of — takion_whatsapp.client.pricing.capture_pricing. Sets the message's own
reference_doctype/reference_name fields (already present on frappe_whatsapp's doctype,
same mechanism as frappe/helpdesk#3525) — no fork, no custom field.

Only ever runs on a client site — frappe_whatsapp's "WhatsApp Message" doctype doesn't
exist on the gateway site.

Numbers are normalized before being used as the conversation key (see
takion_whatsapp.utils.normalize_phone_number) so Brazilian mobile numbers reported with
and without the ambiguous 9th digit always resolve to the SAME conversation instead of
silently splitting into two.

Entrega 12 (Grupos) exception: a group message never fits the phone-number-keyed path
above at all -- an inbound group message's "from" is the SENDING PARTICIPANT's own
number, not the group's, and an outgoing group message's "to" is the group_id itself
(not phone-shaped). See _resolve_group_conversation/_upsert_group_participant below,
which route both directions to the group's own WhatsApp Conversation
(client/groups.py::_ensure_group_conversation) instead.
"""
import frappe

from takion_whatsapp.client import contacts
from takion_whatsapp.utils import extract_messages, format_phone_number_display, normalize_phone_number


def link_message_to_conversation(doc, method=None):
	channel = frappe.db.get_value("WhatsApp Channel", {"whatsapp_account": doc.whatsapp_account})
	if not channel:
		return

	conversation = _resolve_group_conversation(doc)
	if conversation:
		_upsert_group_participant(conversation, doc)
	else:
		raw_number = doc.get("from") if doc.type == "Incoming" else doc.to
		if not raw_number:
			return

		phone_number = normalize_phone_number(raw_number)
		conversation = get_or_create_conversation(channel, phone_number, raw_number, auto_resolve_contact=True)

		# Only trust an inbound message's "from" to update the send-to wa_id — it's
		# Meta's own most recent confirmation of a deliverable ID for this contact.
		# An outgoing "to" is just whatever we already had on file, so it teaches us
		# nothing new. Not saved here — folded into the single save() below.
		if doc.type == "Incoming":
			conversation.wa_id = raw_number

	# WhatsApp Notification (frappe_whatsapp's funnel automation engine) stamps
	# reference_doctype/reference_name onto the triggering document (e.g. a Lead)
	# before this hook runs -- preserved here as origin_doctype/origin_name
	# (custom fields, see client/setup.py) before it gets overwritten below, or
	# the automated message would silently vanish from that Lead's own timeline.
	# Only captured once: a message's origin never changes across repeated saves.
	if (
		doc.reference_doctype
		and doc.reference_doctype != "WhatsApp Conversation"
		and not doc.get("origin_doctype")
	):
		doc.db_set("origin_doctype", doc.reference_doctype, update_modified=False)
		doc.db_set("origin_name", doc.reference_name, update_modified=False)

	if doc.reference_doctype != "WhatsApp Conversation" or doc.reference_name != conversation.name:
		doc.db_set("reference_doctype", "WhatsApp Conversation", update_modified=False)
		doc.db_set("reference_name", conversation.name, update_modified=False)

	_update_conversation_after_message(conversation, doc)


def get_or_create_conversation(channel, phone_number, raw_number, contact=None, auto_resolve_contact=False):
	"""Shared by the inbound-message hook (auto_resolve_contact=True — no operator
	present, resolves/creates a Contact automatically) and client/inbox.py's
	start_conversation (contact passed explicitly, or left None on purpose for a
	"Nova Conversa" against a bare phone number with no Contact yet).
	"""
	name = f"{channel}-{phone_number}"
	if frappe.db.exists("WhatsApp Conversation", name):
		return frappe.get_doc("WhatsApp Conversation", name)

	if contact is None and auto_resolve_contact:
		contact = contacts.resolve_or_create_contact(raw_number)

	conversation = frappe.new_doc("WhatsApp Conversation")
	conversation.channel = channel
	conversation.phone_number = phone_number
	conversation.phone_number_display = format_phone_number_display(phone_number)
	conversation.wa_id = raw_number
	conversation.contact = contact
	conversation.insert(ignore_permissions=True)
	return conversation


def _resolve_group_conversation(doc):
	"""Returns the group's WhatsApp Conversation if `doc` belongs to a group thread,
	None for the normal 1:1 path. Outgoing group messages already carry their target
	conversation via reference_name (set by client/inbox.py before insert, exactly
	like any other outgoing send) -- `to` is the group_id itself there, not
	phone-shaped, so it must never be run through the phone-number path below this.
	Incoming group messages carry group_id as a sibling field inside the raw message
	object (see client/groups.py's module docstring), resolved against the
	already-known WhatsApp Group -- never guessed.
	"""
	if doc.type == "Outgoing":
		if doc.reference_doctype == "WhatsApp Conversation" and doc.reference_name:
			conversation = frappe.get_doc("WhatsApp Conversation", doc.reference_name)
			return conversation if conversation.whatsapp_group else None
		return None

	raw_payload = getattr(frappe.local.flags, "takion_whatsapp_raw_payload", None)
	if not raw_payload:
		return None
	message = next((m for m in extract_messages(raw_payload) if m.get("id") == doc.message_id), None)
	if not message or not message.get("group_id"):
		return None

	group_name = frappe.db.get_value("WhatsApp Group", {"group_id": message["group_id"]})
	if not group_name:
		# A message for a group we don't manage/recognize locally -- Groups are
		# business-initiated only (see client/groups.py's module docstring), so this
		# shouldn't happen; surfaced instead of silently mis-filed as a bogus 1:1.
		frappe.log_error(title=f"WhatsApp group message for unknown group_id: {message['group_id']}")
		return None

	conversation_name = frappe.db.get_value("WhatsApp Conversation", {"whatsapp_group": group_name})
	return frappe.get_doc("WhatsApp Conversation", conversation_name) if conversation_name else None


def _upsert_group_participant(conversation, doc):
	"""Belt-and-suspenders sync for the one participant we know just messaged us,
	in case client/groups.py's reconcile_group (webhook nudge or periodic sweep)
	hasn't caught up yet -- that GET-based path stays authoritative for
	leaves/removals, this only ever appends.
	"""
	if doc.type != "Incoming":
		return
	wa_id = doc.get("from")
	if not wa_id:
		return

	group = frappe.get_doc("WhatsApp Group", conversation.whatsapp_group)
	if any(row.wa_id == wa_id for row in group.participants):
		return

	group.append("participants", {
		"wa_id": wa_id,
		"phone_number": normalize_phone_number(wa_id),
		"profile_name": doc.get("profile_name"),
		"contact": contacts.resolve_or_create_contact(wa_id),
		"joined_at": frappe.utils.now_datetime(),
	})
	group.save(ignore_permissions=True)


def _update_conversation_after_message(conversation, message):
	direction = "Outbound" if message.type == "Outgoing" else "Inbound"

	conversation.last_message_at = frappe.utils.now_datetime()
	conversation.last_message_preview = frappe.utils.strip_html(message.message or "")[:140]
	conversation.last_direction = direction
	if direction == "Inbound":
		if conversation.status == "Resolvido":
			conversation.status = "Em andamento"
		# Entrega 9 (SLA): only set on the inbound-when-empty transition -- NOT
		# reassigned on every inbound message, or a customer sending several
		# messages in a row would keep resetting their own wait clock. Cleared
		# below the moment we reply, so a fresh wait starts on their next message.
		if not conversation.first_unanswered_inbound_at:
			conversation.first_unanswered_inbound_at = conversation.last_message_at
		# Independent of `status` -- an inbound message marks the conversation
		# unread regardless of what stage it's in; cleared by an operator opening
		# it (client/inbox.py::mark_conversation_read) or replying (below).
		conversation.is_unread = 1
	else:
		conversation.first_unanswered_inbound_at = None
		conversation.is_unread = 0
		conversation.sla_state = "OK"
	conversation.save(ignore_permissions=True)

	frappe.publish_realtime(
		"whatsapp_inbox_update",
		{"conversation": conversation.name},
		after_commit=True,
	)
