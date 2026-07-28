import frappe


def execute():
	"""Index frappe_whatsapp's "WhatsApp Message.message_id" -- takion_whatsapp's
	webhook dedup (client/webhook_dedup.py) looks up this field on every inbound
	webhook delivery; without an index it's a full table scan that only gets
	slower as the table grows.
	"""
	if not frappe.db.table_exists("WhatsApp Message"):
		return
	frappe.db.add_index("WhatsApp Message", ["message_id"])
