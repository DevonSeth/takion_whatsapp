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
"""
import frappe

from takion_whatsapp.client import contacts
from takion_whatsapp.utils import format_phone_number_display, normalize_phone_number


def link_message_to_conversation(doc, method=None):
	raw_number = doc.get("from") if doc.type == "Incoming" else doc.to
	if not raw_number:
		return

	channel = frappe.db.get_value("WhatsApp Channel", {"whatsapp_account": doc.whatsapp_account})
	if not channel:
		return

	phone_number = normalize_phone_number(raw_number)
	conversation = get_or_create_conversation(channel, phone_number, raw_number, auto_resolve_contact=True)

	# Only trust an inbound message's "from" to update the send-to wa_id — it's Meta's
	# own most recent confirmation of a deliverable ID for this contact. An outgoing
	# "to" is just whatever we already had on file, so it teaches us nothing new.
	# Not saved here — folded into the single save() in _update_conversation_after_message.
	if doc.type == "Incoming":
		conversation.wa_id = raw_number

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


def _update_conversation_after_message(conversation, message):
	direction = "Outbound" if message.type == "Outgoing" else "Inbound"

	conversation.last_message_at = frappe.utils.now_datetime()
	conversation.last_message_preview = frappe.utils.strip_html(message.message or "")[:140]
	conversation.last_direction = direction
	if direction == "Inbound" and conversation.status == "Resolvido":
		conversation.status = "Em andamento"
	conversation.save(ignore_permissions=True)

	frappe.publish_realtime(
		"whatsapp_inbox_update",
		{"conversation": conversation.name},
		after_commit=True,
	)
