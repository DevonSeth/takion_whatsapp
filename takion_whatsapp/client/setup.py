"""Reproducible install-time setup that isn't a plain fixture export --
Custom Fields on a third-party doctype (frappe_whatsapp's "WhatsApp Message")
need frappe's own create_custom_fields() to be created idempotently, since a
naive Custom Field fixture with no live doctype behind it yet has nothing to
attach to on a fresh install. Called from hooks.py's after_migrate; the
fixtures entry in hooks.py then captures the resulting records for a
completely fresh install where after_migrate hasn't run yet either.
"""
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

CUSTOM_FIELDS = {
	"WhatsApp Message": [
		{
			"fieldname": "origin_doctype",
			"fieldtype": "Link",
			"options": "DocType",
			"label": "Origin Doctype",
			"insert_after": "reference_name",
			"read_only": 1,
			"description": (
				"The document that originally triggered this message (e.g. a Lead, via a "
				"WhatsApp Notification) before reference_doctype/reference_name got "
				"repointed to this message's WhatsApp Conversation. See "
				"client/conversation.py::link_message_to_conversation."
			),
		},
		{
			"fieldname": "origin_name",
			"fieldtype": "Dynamic Link",
			"options": "origin_doctype",
			"label": "Origin Name",
			"insert_after": "origin_doctype",
			"read_only": 1,
		},
	]
}


def after_migrate():
	create_custom_fields(CUSTOM_FIELDS)
	frappe.clear_cache(doctype="WhatsApp Message")
