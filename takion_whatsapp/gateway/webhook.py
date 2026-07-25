"""Gateway inbound webhook: the single Meta callback URL, routed by phone_number_id.

Only ever runs on the gateway site (no frappe_whatsapp installed there). Validates
Meta's signature/handshake and hands off to a background job immediately so a slow
or downed tenant site never delays the HTTP 200 Meta expects.
"""
import hashlib
import hmac

import frappe
from frappe import _
from werkzeug.wrappers import Response

from takion_whatsapp.utils import extract_phone_number_id


@frappe.whitelist(allow_guest=True)
def webhook():
	"""Meta webhook: GET is the verification handshake, POST is an event."""
	if frappe.request.method == "GET":
		return _handshake()
	return _receive()


def _handshake():
	mode = frappe.form_dict.get("hub.mode")
	verify_token = frappe.form_dict.get("hub.verify_token")
	challenge = frappe.form_dict.get("hub.challenge")

	settings = frappe.get_single("WhatsApp Gateway Settings")
	expected_token = settings.get_password("meta_verify_token", raise_exception=False)

	if mode != "subscribe" or not expected_token or verify_token != expected_token:
		frappe.throw(_("Verification token mismatch"), frappe.PermissionError)

	return Response(challenge, status=200)


def _receive():
	raw_body = frappe.request.get_data()
	_verify_signature(raw_body)

	phone_number_id = extract_phone_number_id(raw_body)
	if not phone_number_id:
		# Not every event (e.g. some status callbacks) carries metadata; nothing to route.
		return Response("EVENT_RECEIVED", status=200)

	frappe.enqueue(
		"takion_whatsapp.gateway.jobs.forward_webhook",
		queue="whatsapp_gateway",
		enqueue_after_commit=True,
		raw_payload=raw_body.decode("utf-8"),
		phone_number_id=phone_number_id,
	)
	return Response("EVENT_RECEIVED", status=200)


def _verify_signature(raw_body):
	settings = frappe.get_single("WhatsApp Gateway Settings")
	app_secret = settings.get_password("meta_app_secret", raise_exception=False)
	if not app_secret:
		frappe.throw(_("Gateway is not configured (missing meta_app_secret)"), frappe.ValidationError)

	signature_header = frappe.get_request_header("X-Hub-Signature-256", "")
	expected = "sha256=" + hmac.new(app_secret.encode(), raw_body, hashlib.sha256).hexdigest()

	if not hmac.compare_digest(signature_header, expected):
		frappe.throw(_("Invalid webhook signature"), frappe.PermissionError)
