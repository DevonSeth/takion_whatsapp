"""Capture Meta's per-message pricing/conversation fields that frappe_whatsapp doesn't store.

Wired via hooks.py doc_events on frappe_whatsapp's "WhatsApp Message" doctype
(after_insert and on_update — Meta often attaches pricing to a later status
webhook rather than the original message webhook).
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

	cost_doc.update({
		"whatsapp_message": doc.name,
		"channel": frappe.db.get_value("WhatsApp Channel", {"whatsapp_account": doc.whatsapp_account}),
		"direction": "Outbound" if doc.type == "Outgoing" else "Inbound",
		"pricing_type": pricing.get("type"),
		"pricing_category": pricing.get("category"),
		"billable": pricing.get("billable"),
		"conversation_id": conversation.get("id"),
		"conversation_origin": (conversation.get("origin") or {}).get("type"),
		"raw_pricing_json": json.dumps(status),
		"captured_at": frappe.utils.now_datetime(),
	})
	cost_doc.save(ignore_permissions=True)
