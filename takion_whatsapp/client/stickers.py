"""Figurinhas (Entrega 13): fecha os dois lados reais que frappe_whatsapp não
cobre para o content_type "sticker" -- envio (WhatsAppMessage.send_outgoing
nunca monta {"sticker": {"link": ...}} no payload para esse content_type, só
para document/image/video/audio/reaction/text/interactive/flow, então cairia
um POST inválido pra Meta) e recebimento (utils/webhook.py's media branch só
cobre image/audio/video/document; sticker cai no ramo genérico `else`, que
nunca baixa o arquivo -- confirmado via leitura direta do código vendorizado:
message["sticker"].get("sticker") é sempre None, então o WhatsApp Message
seria inserido sem anexo nenhum).

Ambos resolvidos pelos mesmos pontos de extensão já usados no resto do app:
WhatsAppMessageStickerMixin via extend_doctype_class (hooks.py) para o envio
(mesmo notify(self, data) que client/groups.py's WhatsAppMessageGroupSendMixin
usa), fetch_incoming_sticker via doc_events after_insert (hooks.py) para o
recebimento.

O catálogo de figurinhas em si (WhatsApp Sticker, admin-managed) não tem
nenhuma imagem própria do Takion -- ver o docstring do doctype.
"""
import requests

import frappe
from frappe.model.document import Document

from takion_whatsapp.utils import extract_messages


class WhatsAppMessageStickerMixin(Document):
	"""notify(self, data) is the surgical override point -- send_outgoing()
	already builds the full payload and calls self.notify(data) right before
	the actual POST, so this only injects the one missing key rather than
	re-implementing any of send_outgoing()'s own content-type branching. Same
	link-derivation as send_outgoing() itself uses for image/video/document.
	"""
	def notify(self, data):
		if self.content_type == "sticker" and self.attach:
			# self.attach already starts with "/" (Frappe file_url convention) --
			# see client/media_link_fix.py's docstring for the same bug this
			# would otherwise reproduce (a double slash right after the host).
			link = self.attach if self.attach.startswith("http") else frappe.utils.get_url() + self.attach
			data["sticker"] = {"link": link}
		super().notify(data)


def fetch_incoming_sticker(doc, method=None):
	"""doc_events after_insert -- downloads and attaches the sticker file for
	an Incoming message, mirroring frappe_whatsapp's own image/audio/video/
	document branch in utils/webhook.py::post. Guarded on `not doc.attach` so
	this is a no-op on any later on_update re-save of the same message.
	"""
	if doc.type != "Incoming" or doc.content_type != "sticker" or doc.attach:
		return

	raw_payload = getattr(frappe.local.flags, "takion_whatsapp_raw_payload", None)
	if not raw_payload:
		return

	message = next(
		(m for m in extract_messages(raw_payload) if m.get("id") == doc.message_id),
		None,
	)
	media_id = (message or {}).get("sticker", {}).get("id")
	if not media_id:
		return

	whatsapp_account = frappe.get_doc("WhatsApp Account", doc.whatsapp_account)
	token = whatsapp_account.get_password("token")
	headers = {"Authorization": "Bearer " + token}
	base_url = f"{whatsapp_account.url}/{whatsapp_account.version}/"

	response = requests.get(f"{base_url}{media_id}/", headers=headers)
	if response.status_code != 200:
		return
	media_data = response.json()
	media_url = media_data.get("url")
	mime_type = media_data.get("mime_type", "image/webp")
	file_extension = mime_type.split("/")[-1]

	media_response = requests.get(media_url, headers=headers)
	if media_response.status_code != 200:
		return

	file_doc = frappe.get_doc({
		"doctype": "File",
		"file_name": f"{frappe.generate_hash(length=10)}.{file_extension}",
		"attached_to_doctype": "WhatsApp Message",
		"attached_to_name": doc.name,
		"content": media_response.content,
		"attached_to_field": "attach",
	}).save(ignore_permissions=True)

	doc.attach = file_doc.file_url
	doc.save(ignore_permissions=True)
