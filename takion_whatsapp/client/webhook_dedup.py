"""Deduplicates incoming WhatsApp messages by Meta's wamid (`message_id`).

Meta resends a webhook delivery for up to 7 days when it doesn't get a clean ack.
frappe_whatsapp's webhook.py::post() inserts a new "WhatsApp Message" unconditionally,
with no message_id check, so a resend of an already-processed message creates a
duplicate record -- which double-fires
takion_whatsapp.client.conversation.link_message_to_conversation (second
last_message_at/last_direction update on the conversation) and inflates every count
derived from "WhatsApp Message" (SLA, cost, future AI triggers).

Called from client/internal_webhook.py::receive(), before it calls frappe_whatsapp's
own webhook handler -- never touches frappe_whatsapp's files. Mirrors post()'s own
entry/changes/value extraction (same KeyError fallback for the alternate payload
shape) so both read the same "messages" list from the same frappe.local.form_dict
object.
"""
import frappe


def drop_duplicate_messages(form_dict):
	"""Mutate form_dict's message list in place, dropping any wamid already stored
	as a WhatsApp Message.message_id.

	Returns True if the caller should proceed to frappe_whatsapp's webhook handler
	(new messages remain, or this payload carries no "messages" array at all --
	e.g. a status-update callback, out of scope for this dedup). Returns False if
	every message in the batch was already processed, meaning the caller should
	let the request succeed with no further action.
	"""
	try:
		value = form_dict["entry"][0]["changes"][0]["value"]
	except KeyError:
		value = form_dict["entry"]["changes"][0]["value"]

	messages = value.get("messages")
	if not messages:
		return True

	new_messages = [
		m for m in messages
		if not (m.get("id") and frappe.db.exists("WhatsApp Message", {"message_id": m["id"]}))
	]
	if not new_messages:
		return False

	if len(new_messages) != len(messages):
		value["messages"] = new_messages
	return True
