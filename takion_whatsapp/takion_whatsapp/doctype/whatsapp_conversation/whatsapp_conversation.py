import frappe
from frappe.model.document import Document


class WhatsAppConversation(Document):
	def autoname(self):
		# Group conversations can't use the json's "format:{channel}-{phone_number}"
		# (no single phone_number applies) -- and group_id itself doesn't exist until
		# group creation is confirmed (async, see client/groups.py), so this can only
		# ever run for a conversation created AFTER that confirmation, never at the
		# same time as the WhatsApp Group's own (Pendente) insert.
		if self.whatsapp_group:
			group_id = frappe.db.get_value("WhatsApp Group", self.whatsapp_group, "group_id")
			self.name = f"{self.channel}-group-{group_id}"
		# Otherwise leave self.name unset -- naming.py falls back to the json's
		# "format:{channel}-{phone_number}" for a normal 1:1 conversation.
