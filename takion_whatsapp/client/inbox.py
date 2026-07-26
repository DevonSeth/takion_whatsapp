"""Whitelisted API consumed by the whatsapp_inbox Page (conversation list, thread,
send reply). Read endpoints use frappe.get_list (not get_all) so results are filtered
by the calling user's actual permissions on WhatsApp Conversation / WhatsApp Message.

Search (in-conversation and global) is deliberately not part of this file yet — tracked
as the next item after this Entrega ships, not this one.
"""
import frappe


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
