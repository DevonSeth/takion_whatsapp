"""Capture Meta's per-message pricing/conversation fields that frappe_whatsapp doesn't store.

Wired via hooks.py doc_events on frappe_whatsapp's "WhatsApp Message" doctype
(after_insert and on_update — Meta often attaches pricing to a later status
webhook rather than the original message webhook).

Entrega 8 ("Atribuição & Custo") added cost_amount/currency population from the
new WhatsApp Pricing Rate doctype -- a rate table the user fills in themselves
(Meta's prices vary by country/category and change over time, so no rate is
hardcoded here). Until rows exist, cost_amount simply stays unset, same as
before this Entrega.
"""
import json

import frappe

from takion_whatsapp.utils import extract_statuses


def capture_pricing(doc, method=None):
	raw_payload = getattr(frappe.local.flags, "takion_whatsapp_raw_payload", None)
	if not raw_payload:
		return

	status = next(
		(s for s in extract_statuses(raw_payload) if s.get("id") == doc.message_id),
		None,
	)
	if not status:
		return

	pricing = status.get("pricing") or {}
	if not pricing:
		return

	conversation = status.get("conversation") or {}

	existing = frappe.db.get_value("WhatsApp Message Cost", {"whatsapp_message": doc.name})
	cost_doc = frappe.get_doc("WhatsApp Message Cost", existing) if existing else frappe.new_doc("WhatsApp Message Cost")

	billable = pricing.get("billable")
	pricing_category = pricing.get("category")
	rate = _lookup_rate(pricing_category) if billable else None

	cost_doc.update({
		"whatsapp_message": doc.name,
		"channel": frappe.db.get_value("WhatsApp Channel", {"whatsapp_account": doc.whatsapp_account}),
		"direction": "Outbound" if doc.type == "Outgoing" else "Inbound",
		"pricing_type": pricing.get("type"),
		"pricing_category": pricing_category,
		"billable": billable,
		"conversation_id": conversation.get("id"),
		"conversation_origin": (conversation.get("origin") or {}).get("type"),
		"raw_pricing_json": json.dumps(status),
		"captured_at": frappe.utils.now_datetime(),
		"currency": rate.currency if rate else None,
		"cost_amount": rate.rate if rate else 0,
	})
	cost_doc.save(ignore_permissions=True)


def _lookup_rate(pricing_category):
	"""Most recent WhatsApp Pricing Rate row effective on or before today for this
	category. Returns None (leaving cost_amount at 0) until the user populates the
	rate table -- no price is ever guessed or hardcoded here.
	"""
	if not pricing_category:
		return None

	rows = frappe.get_all(
		"WhatsApp Pricing Rate",
		filters={"pricing_category": pricing_category, "effective_from": ["<=", frappe.utils.today()]},
		fields=["currency", "rate"],
		order_by="effective_from desc",
		limit_page_length=1,
	)
	return rows[0] if rows else None
