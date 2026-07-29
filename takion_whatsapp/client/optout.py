"""Entrega 10 ("Transmissão Segura"): opt-out is an LGPD/Meta-policy compliance
floor, not a feature toggle -- confirmed by the user (see
takion_whatsapp_entrega10_decisions memory), so the confirmation reply below is
always sent, unconditionally, never gated behind a settings checkbox.

Wired via hooks.py doc_events on "WhatsApp Message" (after_insert), listed
AFTER client.conversation.link_message_to_conversation -- same ordering
requirement as client/attribution.py: this needs the WhatsApp Conversation to
already exist/be resolved before it can flag it.

The confirmation reply is sent via frappe.enqueue, not inline: an outbound
send is a real HTTP call to Meta, and the whole WhatsApp Message insert path
runs synchronously inside the gateway's circuit breaker (10s timeout, see
takion_whatsapp_professional_features_research memory) -- an opt-out is
always a one-off per contact (detect_optout no-ops on a conversation that's
already opted out), so the enqueue's small extra latency is a non-issue.

Only ever runs on a client site (frappe_whatsapp installed) with an inbound
message -- harmless no-op otherwise, same pattern as client/attribution.py
and client/pricing.py.
"""
import re

import frappe

from takion_whatsapp.utils import normalize_phone_number

_PUNCTUATION_RE = re.compile(r"[^\w\s]", re.UNICODE)


def _clean(text):
	return _PUNCTUATION_RE.sub("", (text or "").strip().lower())


def detect_optout(doc, method=None):
	if doc.type != "Incoming":
		return

	channel = frappe.db.get_value("WhatsApp Channel", {"whatsapp_account": doc.whatsapp_account})
	if not channel:
		return

	phone_number = normalize_phone_number(doc.get("from"))
	conversation_name = f"{channel}-{phone_number}"

	if frappe.db.get_value("WhatsApp Conversation", conversation_name, "opted_out"):
		return  # already opted out -- don't re-detect or re-confirm on every later message

	message_text = _clean(doc.message)
	if not message_text:
		return

	settings = frappe.get_cached_doc("WhatsApp Broadcast Settings")
	keywords = {_clean(k) for k in (settings.optout_keywords or "").splitlines() if k.strip()}
	if not keywords or message_text not in keywords:
		return

	frappe.db.set_value(
		"WhatsApp Conversation",
		conversation_name,
		{"opted_out": 1, "opted_out_at": frappe.utils.now_datetime()},
		update_modified=False,
	)

	frappe.enqueue(
		"takion_whatsapp.client.optout.send_confirmation",
		queue="short",
		conversation_name=conversation_name,
		whatsapp_account=doc.whatsapp_account,
		to=doc.get("from"),
		confirmation_message=settings.optout_confirmation_message,
	)


def send_confirmation(conversation_name, whatsapp_account, to, confirmation_message):
	message = frappe.new_doc("WhatsApp Message")
	message.type = "Outgoing"
	message.content_type = "text"
	message.to = to
	message.message = confirmation_message
	message.whatsapp_account = whatsapp_account
	message.reference_doctype = "WhatsApp Conversation"
	message.reference_name = conversation_name
	message.insert(ignore_permissions=True)  # before_insert -> send_outgoing()


def is_opted_out(whatsapp_account, raw_number):
	"""Shared by client/broadcast.py's two filter points (assembly + send-time
	safety re-check) -- avoids each duplicating the channel/normalization lookup.
	"""
	channel = frappe.db.get_value("WhatsApp Channel", {"whatsapp_account": whatsapp_account})
	if not channel:
		return False
	phone_number = normalize_phone_number(raw_number)
	return bool(frappe.db.get_value("WhatsApp Conversation", f"{channel}-{phone_number}", "opted_out"))
