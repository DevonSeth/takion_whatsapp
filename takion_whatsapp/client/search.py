"""Global search across WhatsApp conversations, for the inbox's search bar.

In-conversation search (Entrega 4's other half) runs entirely client-side in
whatsapp_inbox.js: a conversation's thread is already loaded in full,
unpaginated, once it's opened, so filtering it needs no round trip. This
endpoint is the part that DOES need the server: finding matches in
conversations that aren't loaded in the browser yet. Both share the same
simple LIKE-based approach, no full-text index, per the original design
(see takion_whatsapp_search_deferred memory) — add one later only if volume
makes LIKE too slow.
"""
import frappe

MAX_CONVERSATIONS = 30
MAX_MATCHES_PER_CONVERSATION = 5


@frappe.whitelist()
def search_global(query):
	query = (query or "").strip()
	if not query:
		return []

	messages = frappe.get_list(
		"WhatsApp Message",
		filters={
			"reference_doctype": "WhatsApp Conversation",
			"message": ["like", f"%{query}%"],
		},
		fields=["name", "message", "reference_name", "creation"],
		order_by="creation desc",
		limit_page_length=MAX_CONVERSATIONS * MAX_MATCHES_PER_CONVERSATION,
	)
	if not messages:
		return []

	grouped = {}
	order = []
	for m in messages:
		if m.reference_name not in grouped:
			if len(order) >= MAX_CONVERSATIONS:
				continue
			grouped[m.reference_name] = []
			order.append(m.reference_name)
		if len(grouped[m.reference_name]) < MAX_MATCHES_PER_CONVERSATION:
			grouped[m.reference_name].append(m)

	# WhatsApp Message filtered by get_list already respects the caller's permissions;
	# re-check WhatsApp Conversation too (a message could in principle be visible while
	# its parent conversation isn't, depending on permission rules) and use its presence
	# in conv_map below to drop any conversation that fails that second check.
	conversations = frappe.get_list(
		"WhatsApp Conversation",
		filters={"name": ["in", order]},
		fields=["name", "phone_number_display", "contact"],
	)
	conv_map = {c.name: c for c in conversations}

	return [
		{
			"conversation": name,
			"phone_number_display": conv_map[name].phone_number_display,
			"contact": conv_map[name].contact,
			"matches": grouped[name],
		}
		for name in order
		if name in conv_map
	]
