"""Captures Meta's Click-to-WhatsApp ad attribution (`referral` object: ad id,
`ctwa_clid`, headline, source_type) from the first inbound message of a new
conversation -- thrown away entirely by frappe_whatsapp today.

Wired via hooks.py doc_events on "WhatsApp Message" (after_insert), listed
AFTER client.conversation.link_message_to_conversation for the same event --
that ordering is load-bearing: this function relies on the WhatsApp
Conversation already existing by the time it runs, rather than re-deriving it
independently.

Only ever runs on a client site (frappe_whatsapp installed) with an inbound
message whose webhook payload carried a `referral` -- harmless no-op
otherwise, same pattern as client/pricing.py.
"""
import json

import frappe

from takion_whatsapp.utils import extract_messages, normalize_phone_number


def capture_referral(doc, method=None):
	if doc.type != "Incoming":
		return

	raw_payload = getattr(frappe.local.flags, "takion_whatsapp_raw_payload", None)
	if not raw_payload:
		return

	message = next(
		(m for m in extract_messages(raw_payload) if m.get("id") == doc.message_id),
		None,
	)
	if not message:
		return

	referral = message.get("referral")
	if not referral:
		return

	channel = frappe.db.get_value("WhatsApp Channel", {"whatsapp_account": doc.whatsapp_account})
	if not channel:
		return

	phone_number = normalize_phone_number(doc.get("from"))
	conversation_name = f"{channel}-{phone_number}"

	# First inbound message with a referral wins -- a contact only ever clicks
	# the ad once; later messages (with or without their own referral) must
	# never overwrite the original attribution.
	if frappe.db.get_value("WhatsApp Conversation", conversation_name, "ctwa_clid"):
		return

	frappe.db.set_value(
		"WhatsApp Conversation",
		conversation_name,
		{
			"ctwa_clid": referral.get("ctwa_clid"),
			"referral_source_type": referral.get("source_type"),
			"referral_headline": referral.get("headline"),
			"raw_referral_json": json.dumps(referral),
		},
		update_modified=False,
	)
