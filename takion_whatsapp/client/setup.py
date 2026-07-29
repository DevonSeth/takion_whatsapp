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
	],
	# Entrega 10 ("Transmissão Segura"): per-recipient pacing state -- only ever
	# populated by client/broadcast.py's BulkWhatsAppMessageMixin, on the
	# WhatsApp Recipient rows a Bulk WhatsApp Message snapshots onto itself.
	# Rows belonging to a plain WhatsApp Recipient List (the reusable segment
	# definition, not a specific broadcast run) never get this field set.
	"WhatsApp Recipient": [
		{
			"fieldname": "send_status",
			"fieldtype": "Select",
			"options": "\nPending\nSent\nFailed\nOpt-out",
			"label": "Status de Envio",
			"insert_after": "recipient_data",
			"read_only": 1,
			"in_list_view": 1,
		},
	],
	# Entrega 10, item 5: turns a WhatsApp Recipient List into an optionally
	# dynamic segment -- see client/segments.py.
	"WhatsApp Recipient List": [
		{
			"fieldname": "auto_refresh",
			"fieldtype": "Check",
			"label": "Atualização automática (segmento dinâmico)",
			"insert_after": "import_limit",
			"description": (
				"Reaplica periodicamente o mesmo filtro de importação (DocType/campos/filtros "
				"já configurados acima), via o cron de 5 minutos já existente -- pula listas "
				"em uso por uma transmissão em andamento."
			),
		},
		{
			"fieldname": "refresh_frequency_hours",
			"fieldtype": "Int",
			"label": "Frequência de atualização (horas)",
			"default": "24",
			"depends_on": "eval:doc.auto_refresh",
			"insert_after": "auto_refresh",
		},
		{
			"fieldname": "last_refreshed_at",
			"fieldtype": "Datetime",
			"label": "Última atualização automática",
			"read_only": 1,
			"insert_after": "refresh_frequency_hours",
		},
	],
	# Entrega 10, item 4: atributo informativo da transmissão -- não propagado
	# automaticamente para Lead.utm_campaign (fora do escopo desta Entrega).
	"Bulk WhatsApp Message": [
		{
			"fieldname": "utm_campaign",
			"fieldtype": "Link",
			"options": "UTM Campaign",
			"label": "UTM Campaign",
			"insert_after": "recipient_count",
			"description": (
				"Vincula esta transmissão a uma UTM Campaign para relatórios de ROI (ex.: "
				"campaign_efficiency) -- não propagado automaticamente para Leads que "
				"respondam a esta transmissão."
			),
		},
	],
}


def after_migrate():
	create_custom_fields(CUSTOM_FIELDS)
	for doctype in CUSTOM_FIELDS:
		frappe.clear_cache(doctype=doctype)
