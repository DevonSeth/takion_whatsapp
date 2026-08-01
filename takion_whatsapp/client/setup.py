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
from frappe.custom.doctype.property_setter.property_setter import make_property_setter

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

# Entrega 13 ("Figurinhas"): frappe_whatsapp's own WhatsApp Message.content_type
# Select field has no "sticker" option (and never will -- third-party doctype),
# so it's widened via Property Setter instead of a Custom Field (this modifies
# an EXISTING field's property, not adding a new one). attach's depends_on is
# widened too, so the Attach field shows in the desk form for a sticker
# message the same as it already does for image/video/document/audio -- see
# frappe-syntax-doctypes' Property Setter reference for both mechanisms.
PROPERTY_SETTERS = [
	{
		"doctype": "WhatsApp Message",
		"fieldname": "content_type",
		"property": "options",
		"value": "text\ndocument\nimage\nvideo\naudio\nflow\nreaction\nlocation\ncontact\nbutton\ninteractive\norder\nsticker",
		"property_type": "Text",
	},
	{
		"doctype": "WhatsApp Message",
		"fieldname": "attach",
		"property": "depends_on",
		"value": (
			"eval:(doc.content_type=='audio' || doc.content_type=='video' || "
			"doc.content_type=='document' || doc.content_type=='image' || "
			"doc.content_type=='sticker' || doc.message_type=='Template')"
		),
		"property_type": "Small Text",
	},
	# Bugfix 2026-08-01: frappe_whatsapp's own "WhatsApp Account" ships
	# webhook_verify_token as a plain Data field with no explicit `length`,
	# so it inherits Frappe's 140-char varchar default. Meta itself never
	# constrains this value (it's a string the developer picks in the App
	# Dashboard, not something Meta issues), so nothing stops a real access
	# token -- or a much longer verify string -- from being typed in and
	# hitting CharacterLengthExceededError on save. Widened defensively;
	# see also the two description Property Setters below clarifying which
	# field is which (this is where the field got confused with `token`,
	# the actual Meta-issued access token, in practice).
	{
		"doctype": "WhatsApp Account",
		"fieldname": "webhook_verify_token",
		"property": "length",
		"value": "500",
		"property_type": "Int",
	},
	{
		"doctype": "WhatsApp Account",
		"fieldname": "webhook_verify_token",
		"property": "description",
		"value": (
			"String arbitrária que VOCÊ escolhe e digita na configuração de webhook do "
			"App Dashboard da Meta (\"Verify Token\") -- a Meta não emite nem restringe "
			"esse valor. NÃO é o access token; esse vai no campo Token acima."
		),
		"property_type": "Small Text",
	},
	# Bugfix 2026-08-01: phone_id/app_id/business_id are numeric-looking but
	# Meta's own API always represents them as JSON strings (see Graph API
	# webhook payload / phone number examples), specifically so clients don't
	# lose precision or overflow parsing 15-19 digit IDs as native numbers.
	# They are already correctly typed as Data here (not Int) -- these
	# description Property Setters exist only to stop that from being
	# "corrected" to Int/Float/Currency by a future Customize Form edit,
	# which would overflow (int columns) or lose precision (float/currency)
	# on real Meta IDs.
	{
		"doctype": "WhatsApp Account",
		"fieldname": "phone_id",
		"property": "description",
		"value": (
			"phone_number_id da Meta. Parece número mas é sempre string na API da Meta "
			"-- nunca mude o tipo deste campo pra Int/Float/Currency, valores reais "
			"(15-19 dígitos) estouram o range de Int e perdem precisão como Float/Currency."
		),
		"property_type": "Small Text",
	},
	{
		"doctype": "WhatsApp Account",
		"fieldname": "app_id",
		"property": "description",
		"value": (
			"App ID da Meta. Parece número mas é sempre string na API da Meta -- nunca "
			"mude o tipo deste campo pra Int/Float/Currency, ver descrição do phone_id."
		),
		"property_type": "Small Text",
	},
	{
		"doctype": "WhatsApp Account",
		"fieldname": "business_id",
		"property": "description",
		"value": (
			"ID da WhatsApp Business Account (WABA) da Meta. Parece número mas é sempre "
			"string na API da Meta -- nunca mude o tipo deste campo pra Int/Float/"
			"Currency, ver descrição do phone_id."
		),
		"property_type": "Small Text",
	},
]


def _create_property_setters():
	for ps in PROPERTY_SETTERS:
		if frappe.db.exists(
			"Property Setter",
			{"doc_type": ps["doctype"], "field_name": ps["fieldname"], "property": ps["property"]},
		):
			continue
		make_property_setter(ps["doctype"], ps["fieldname"], ps["property"], ps["value"], ps["property_type"])


def after_migrate():
	create_custom_fields(CUSTOM_FIELDS)
	_create_property_setters()
	for doctype in CUSTOM_FIELDS:
		frappe.clear_cache(doctype=doctype)
	frappe.clear_cache(doctype="WhatsApp Message")
	frappe.clear_cache(doctype="WhatsApp Account")
