"""Whitelisted API consumed by the whatsapp_inbox Page (conversation list, thread,
send reply, starting a new conversation). Read endpoints use frappe.get_list (not
get_all) so results are filtered by the calling user's actual permissions on
WhatsApp Conversation / WhatsApp Message.

Search (in-conversation and global) is deliberately not part of this file yet — tracked
as the next item after this Entrega ships, not this one.
"""
import re

import frappe
from frappe import _

from takion_whatsapp.client.conversation import get_or_create_conversation
from takion_whatsapp.utils import normalize_phone_number

# Meta's own size caps (see WhatsApp Cloud API media reference) — checked here so
# an oversized upload fails fast with a clear message instead of a cryptic error
# from send_outgoing()'s Graph API call.
MEDIA_MAX_BYTES = {
	"image": 5 * 1024 * 1024,
	"video": 16 * 1024 * 1024,
	"document": 100 * 1024 * 1024,
}

URL_PATTERN = re.compile(r"https?://\S+")


@frappe.whitelist()
def get_conversations(status=None, tag=None, assigned_to=None, unread_only=None):
	filters = {}
	if status:
		# Multi-select filter: JS sends a JSON-encoded array (possibly with a
		# single value) rather than one status string.
		if isinstance(status, str):
			status = frappe.parse_json(status)
		if status:
			filters["status"] = ["in", status]
	if tag:
		filters["_user_tags"] = ["like", f"%{tag}%"]
	if assigned_to:
		filters["_assign"] = ["like", f"%{assigned_to}%"]
	if frappe.utils.cint(unread_only):
		filters["is_unread"] = 1

	return frappe.get_list(
		"WhatsApp Conversation",
		filters=filters,
		fields=[
			"name",
			"phone_number_display",
			"contact",
			"whatsapp_group",
			"status",
			"last_message_preview",
			"last_direction",
			"last_message_at",
			"is_unread",
			"sla_state",
			"_assign",
			"_user_tags",
		],
		order_by="last_message_at desc",
	)


@frappe.whitelist()
def get_thread(conversation):
	return frappe.get_list(
		"WhatsApp Message",
		filters={
			"reference_doctype": "WhatsApp Conversation",
			"reference_name": conversation,
		},
		fields=["name", "type", "content_type", "message", "attach", "message_id", "status", "creation", "from", "profile_name"],
		order_by="creation asc",
	)


@frappe.whitelist()
def mark_conversation_read(conversation):
	"""Called when an operator opens a conversation (or it's the one already open
	when a new realtime update lands) -- clears the unread badge set by
	client/conversation.py on the last inbound message. update_modified=False:
	WhatsApp Conversation has track_changes=1, and this fires on every open, not
	just meaningful edits."""
	frappe.db.set_value("WhatsApp Conversation", conversation, "is_unread", 0, update_modified=False)


@frappe.whitelist()
def get_media_gallery(conversation):
	"""Feeds the contact panel's "Mídia, links e docs" — a compact preview
	(caller slices it) plus the 3 full tabs (Mídia/Documentos/Links) shown when
	the operator opens the full browser, mirroring WhatsApp Web's own
	contact-info panel. `rows` is already creation-desc, so filtering preserves
	that order in every bucket without a second sort.
	"""
	rows = frappe.get_list(
		"WhatsApp Message",
		filters={"reference_doctype": "WhatsApp Conversation", "reference_name": conversation},
		fields=["name", "content_type", "message", "attach", "creation"],
		order_by="creation desc",
	)
	media = [r for r in rows if r.content_type in ("image", "video") and r.attach]
	documents = [r for r in rows if r.content_type == "document" and r.attach]
	links = [r for r in rows if r.message and URL_PATTERN.search(r.message)]

	return {
		"all": [r for r in rows if r.content_type in ("image", "video", "document") and r.attach],
		"media": media,
		"documents": documents,
		"links": links,
	}


@frappe.whitelist()
def send_message(conversation, message):
	conv = frappe.get_doc("WhatsApp Conversation", conversation)

	doc = frappe.new_doc("WhatsApp Message")
	doc.type = "Outgoing"
	doc.content_type = "text"
	doc.to = conv.wa_id
	doc.message = message
	doc.reference_doctype = "WhatsApp Conversation"
	doc.reference_name = conv.name
	doc.insert()  # frappe_whatsapp's before_insert triggers the actual send via send_outgoing()

	return doc.name


@frappe.whitelist()
def send_audio_message(conversation, file_url):
	"""Operator-recorded voice note. Unlike send_message, this doesn't send
	synchronously — the uploaded file (file_url) is the browser's raw
	WebM/Opus recording, which needs a WebM->OGG/Opus conversion (via ffmpeg)
	before it can go to Meta as a native voice-note bubble. See
	takion_whatsapp.client.audio.convert_and_send for the actual conversion
	and send, run in the background so the request returns immediately.
	"""
	frappe.get_doc("WhatsApp Conversation", conversation)  # 404s / permission-checks up front
	frappe.enqueue(
		"takion_whatsapp.client.audio.convert_and_send",
		queue="short",
		conversation=conversation,
		file_url=file_url,
	)


@frappe.whitelist()
def send_media_message(conversation, file_url, content_type, caption=None):
	"""Operator-attached image, video, or document. Unlike send_audio_message, no
	conversion is needed — Meta accepts these formats directly — so this sends
	synchronously through the same frappe_whatsapp path as send_message (which
	already builds the `{content_type: {link, caption}}` payload for
	content_type in ["image", "video", "document"], see WhatsAppMessage.send_outgoing).
	"""
	if content_type not in MEDIA_MAX_BYTES:
		frappe.throw(_("Tipo de mídia não suportado: {0}").format(content_type))

	file_doc = frappe.get_doc("File", {"file_url": file_url})
	if file_doc.file_size and file_doc.file_size > MEDIA_MAX_BYTES[content_type]:
		limit_mb = MEDIA_MAX_BYTES[content_type] // (1024 * 1024)
		frappe.throw(_("Arquivo excede o limite de {0}MB do WhatsApp para {1}.").format(limit_mb, content_type))

	conv = frappe.get_doc("WhatsApp Conversation", conversation)

	doc = frappe.new_doc("WhatsApp Message")
	doc.type = "Outgoing"
	doc.content_type = content_type
	doc.to = conv.wa_id
	doc.attach = file_url
	doc.message = caption
	doc.reference_doctype = "WhatsApp Conversation"
	doc.reference_name = conv.name
	doc.insert()  # frappe_whatsapp's before_insert triggers the actual send via send_outgoing()

	return doc.name


@frappe.whitelist()
def list_stickers():
	"""Enabled catalog entries for the compose picker's "Figurinhas" tab (Entrega
	13) -- read-only, no size/dimension re-check here, that already happened at
	catalog-save time in whatsapp_sticker.py::validate.
	"""
	return frappe.get_list(
		"WhatsApp Sticker",
		filters={"enabled": 1},
		fields=["name", "pack", "title", "image", "is_animated"],
		order_by="pack asc, title asc",
	)


@frappe.whitelist()
def send_sticker_message(conversation, sticker):
	"""Sends a catalog sticker -- unlike send_media_message, the file isn't a
	fresh operator upload, it's an existing WhatsApp Sticker record (already
	validated as WebP/512x512/size-capped at catalog-save time). Actual Graph
	API payload assembly happens in client/stickers.py's
	WhatsAppMessageStickerMixin.notify(), the same extend_doctype_class
	override point client/groups.py uses for a group send.
	"""
	conv = frappe.get_doc("WhatsApp Conversation", conversation)
	image = frappe.db.get_value("WhatsApp Sticker", {"name": sticker, "enabled": 1}, "image")
	if not image:
		frappe.throw(_("Figurinha não encontrada ou desativada."))

	doc = frappe.new_doc("WhatsApp Message")
	doc.type = "Outgoing"
	doc.content_type = "sticker"
	doc.to = conv.wa_id
	doc.attach = image
	doc.reference_doctype = "WhatsApp Conversation"
	doc.reference_name = conv.name
	doc.insert()  # frappe_whatsapp's before_insert triggers the actual send via send_outgoing()

	return doc.name


@frappe.whitelist()
def list_templates(channel):
	"""Approved templates available to start a new conversation on this channel —
	Meta only allows a business-initiated conversation via one of these (or within
	24h of a customer message, which never applies to "Nova Conversa": starting a
	conversation implies no prior message exists for it in our system yet).
	"""
	whatsapp_account = frappe.db.get_value("WhatsApp Channel", channel, "whatsapp_account")
	return frappe.get_list(
		"WhatsApp Templates",
		filters={"whatsapp_account": whatsapp_account, "status": "APPROVED"},
		fields=["name", "template_name", "language_code"],
	)


@frappe.whitelist()
def start_conversation(channel, phone=None, contact=None, template=None):
	"""Starts a brand-new outbound conversation — either to an existing Contact or
	to a bare phone number with no Contact yet. Registering that number as a real
	Contact later is optional and goes through the same dedup pipeline as "Novo
	Contato" (takion_whatsapp.client.contacts), not through this function.
	"""
	if not template:
		frappe.throw("Selecione um template aprovado para iniciar a conversa.")

	if contact:
		raw_number = _primary_mobile(contact)
		if not raw_number:
			frappe.throw("O contato selecionado não tem telefone cadastrado.")
	elif phone:
		raw_number = phone
	else:
		frappe.throw("Informe um contato ou um número de telefone.")

	phone_number = normalize_phone_number(raw_number)
	conversation = get_or_create_conversation(channel, phone_number, raw_number, contact=contact)

	doc = frappe.new_doc("WhatsApp Message")
	doc.type = "Outgoing"
	doc.content_type = "text"
	doc.to = raw_number
	doc.template = template
	doc.reference_doctype = "WhatsApp Conversation"
	doc.reference_name = conversation.name
	doc.insert()  # doc.template set -> before_insert routes to send_template()

	return conversation.name


def _primary_mobile(contact):
	phones = frappe.get_all(
		"Contact Phone",
		filters={"parent": contact, "parenttype": "Contact"},
		fields=["phone"],
		order_by="is_primary_mobile_no desc",
		limit_page_length=1,
	)
	return phones[0].phone if phones else None
