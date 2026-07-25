"""Client-site endpoint: accepts payloads forwarded by the gateway (not Meta directly).

Only ever runs on a client/tenant site (frappe_whatsapp installed here). Verifies the
per-channel internal shared secret set by the gateway, then delegates the raw,
byte-identical Meta payload straight into frappe_whatsapp's own webhook handler —
no fork, no re-serialization, no second network hop.
"""
import hmac

import frappe
from frappe import _
from frappe_whatsapp.utils.webhook import webhook as frappe_whatsapp_webhook

from takion_whatsapp.utils import extract_phone_number_id


@frappe.whitelist(allow_guest=True)
def receive():
	raw_body = frappe.request.get_data()
	_verify_internal_secret(raw_body)

	# Stashed for takion_whatsapp.client.pricing.capture_pricing, invoked synchronously
	# via doc_events while frappe_whatsapp_webhook() below creates/updates WhatsApp Message.
	frappe.local.flags.takion_whatsapp_raw_payload = raw_body

	return frappe_whatsapp_webhook()


def _verify_internal_secret(raw_body):
	provided = frappe.get_request_header("X-Internal-Secret", "")
	phone_number_id = extract_phone_number_id(raw_body)

	channel_name = (
		frappe.db.get_value("WhatsApp Channel", {"phone_number_id": phone_number_id})
		if phone_number_id else None
	)
	if not channel_name:
		frappe.throw(_("Unknown channel"), frappe.PermissionError)

	expected = frappe.utils.password.get_decrypted_password(
		"WhatsApp Channel", channel_name, "internal_shared_secret"
	)
	if not provided or not expected or not hmac.compare_digest(provided, expected):
		frappe.throw(_("Invalid internal secret"), frappe.PermissionError)
