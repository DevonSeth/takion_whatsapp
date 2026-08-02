"""Fixes a real gap confirmed by an end-to-end test (2026-08-02, gateway path,
schema-accurate synthetic payload): frappe_whatsapp's generic `else` branch in
utils/webhook.py::post builds `message[message_type].get(message_type)` for any
content_type it has no dedicated branch for. For "location", Meta's payload is
`message["location"] = {latitude, longitude, name, address}` -- there is no
nested "location" key inside it, so that expression always evaluates to None
and the WhatsApp Message is inserted with an empty `message` (lat/long/name/
address silently discarded, confirmed live: a location message showed up in
the desk with message=None).

Same extension point the rest of the app already uses for this class of gap
(Entrega 13's fetch_incoming_sticker): a doc_events after_insert hook that
re-derives the correct value from the raw payload frappe_whatsapp's own insert
already stashed via frappe.local.flags.takion_whatsapp_raw_payload
(client/internal_webhook.py) and corrects the message field. No new DocType
fields -- the inbox's render_generic_bubble already falls back to a plain text
bubble for any content_type without a dedicated attach-based branch, so a
readable formatted string is all "location" needs to display correctly.
"""
import frappe

from takion_whatsapp.utils import extract_messages


def fix_incoming_location(doc, method=None):
	"""doc_events after_insert -- guarded on `doc.message` being empty so this
	is a no-op on any later on_update re-save of the same message. Must run
	BEFORE client/conversation.py's link_message_to_conversation (see hooks.py)
	so the conversation's last_message_preview reflects the fixed text instead
	of the empty value frappe_whatsapp originally inserted.
	"""
	if doc.type != "Incoming" or doc.content_type != "location" or doc.message:
		return

	raw_payload = getattr(frappe.local.flags, "takion_whatsapp_raw_payload", None)
	if not raw_payload:
		return

	message = next(
		(m for m in extract_messages(raw_payload) if m.get("id") == doc.message_id),
		None,
	)
	location = (message or {}).get("location") or {}
	latitude, longitude = location.get("latitude"), location.get("longitude")
	if latitude is None or longitude is None:
		return

	parts = [p for p in (location.get("name"), location.get("address")) if p]
	parts.append(f"https://www.google.com/maps?q={latitude},{longitude}")
	doc.db_set("message", "\n".join(parts), update_modified=False)
