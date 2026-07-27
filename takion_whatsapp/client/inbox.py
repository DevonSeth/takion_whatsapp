"""Whitelisted API consumed by the whatsapp_inbox Page (conversation list, thread,
send reply, starting a new conversation). Read endpoints use frappe.get_list (not
get_all) so results are filtered by the calling user's actual permissions on
WhatsApp Conversation / WhatsApp Message.

Search (in-conversation and global) is deliberately not part of this file yet — tracked
as the next item after this Entrega ships, not this one.
"""
import frappe

from takion_whatsapp.client.conversation import get_or_create_conversation
from takion_whatsapp.utils import normalize_phone_number


@frappe.whitelist()
def get_conversations(status=None, tag=None, assigned_to=None):
	filters = {}
	if status:
		filters["status"] = status
	if tag:
		filters["_user_tags"] = ["like", f"%{tag}%"]
	if assigned_to:
		filters["_assign"] = ["like", f"%{assigned_to}%"]

	return frappe.get_list(
		"WhatsApp Conversation",
		filters=filters,
		fields=[
			"name",
			"phone_number_display",
			"contact",
			"status",
			"last_message_preview",
			"last_direction",
			"last_message_at",
			"_assign",
			"_user_tags",
		],
		order_by="last_message_at desc",
	)


@frappe.whitelist()
def get_thread(conversation):
	return frappe.get_list(
		"WhatsApp Message",
		filters={
			"reference_doctype": "WhatsApp Conversation",
			"reference_name": conversation,
		},
		fields=["name", "type", "content_type", "message", "attach", "message_id", "status", "creation"],
		order_by="creation asc",
	)


@frappe.whitelist()
def send_message(conversation, message):
	conv = frappe.get_doc("WhatsApp Conversation", conversation)

	doc = frappe.new_doc("WhatsApp Message")
	doc.type = "Outgoing"
	doc.content_type = "text"
	doc.to = conv.wa_id
	doc.message = message
	doc.reference_doctype = "WhatsApp Conversation"
	doc.reference_name = conv.name
	doc.insert()  # frappe_whatsapp's before_insert triggers the actual send via send_outgoing()

	return doc.name


@frappe.whitelist()
def list_templates(channel):
	"""Approved templates available to start a new conversation on this channel —
	Meta only allows a business-initiated conversation via one of these (or within
	24h of a customer message, which never applies to "Nova Conversa": starting a
	conversation implies no prior message exists for it in our system yet).
	"""
	whatsapp_account = frappe.db.get_value("WhatsApp Channel", channel, "whatsapp_account")
	return frappe.get_list(
		"WhatsApp Templates",
		filters={"whatsapp_account": whatsapp_account, "status": "APPROVED"},
		fields=["name", "template_name", "language_code"],
	)


@frappe.whitelist()
def start_conversation(channel, phone=None, contact=None, template=None):
	"""Starts a brand-new outbound conversation — either to an existing Contact or
	to a bare phone number with no Contact yet. Registering that number as a real
	Contact later is optional and goes through the same dedup pipeline as "Novo
	Contato" (takion_whatsapp.client.contacts), not through this function.
	"""
	if not template:
		frappe.throw("Selecione um template aprovado para iniciar a conversa.")

	if contact:
		raw_number = _primary_mobile(contact)
		if not raw_number:
			frappe.throw("O contato selecionado não tem telefone cadastrado.")
	elif phone:
		raw_number = phone
	else:
		frappe.throw("Informe um contato ou um número de telefone.")

	phone_number = normalize_phone_number(raw_number)
	conversation = get_or_create_conversation(channel, phone_number, raw_number, contact=contact)

	doc = frappe.new_doc("WhatsApp Message")
	doc.type = "Outgoing"
	doc.content_type = "text"
	doc.to = raw_number
	doc.template = template
	doc.reference_doctype = "WhatsApp Conversation"
	doc.reference_name = conversation.name
	doc.insert()  # doc.template set -> before_insert routes to send_template()

	return conversation.name


def _primary_mobile(contact):
	phones = frappe.get_all(
		"Contact Phone",
		filters={"parent": contact, "parenttype": "Contact"},
		fields=["phone"],
		order_by="is_primary_mobile_no desc",
		limit_page_length=1,
	)
	return phones[0].phone if phones else None
