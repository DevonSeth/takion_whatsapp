"""Catálogo de figurinhas (Entrega 13) -- admin-managed, sem arte fabricada:
o app não inclui nenhuma figurinha própria, o usuário cadastra as reais aqui
quando as tiver. Validação replica as exigências da API da Meta (WebP,
512x512, 100KB estática / 500KB animada) para falhar rápido no cadastro em vez
de só no envio (Graph API rejeitaria do mesmo jeito, mas com um erro mais
opaco e depois de já estar em uso numa conversa)."""
import io

import frappe
from frappe import _
from frappe.model.document import Document
from PIL import Image

STATIC_MAX_BYTES = 100 * 1024
ANIMATED_MAX_BYTES = 500 * 1024
REQUIRED_DIMENSIONS = (512, 512)


class WhatsAppSticker(Document):
	def validate(self):
		content, image = self._load_image()
		self._validate_dimensions(image)
		self.is_animated = 1 if getattr(image, "is_animated", False) else 0
		self._validate_size(len(content))

	def _load_image(self):
		if not self.image:
			frappe.throw(_("Selecione uma imagem WebP para a figurinha."))
		if not self.image.lower().endswith(".webp"):
			frappe.throw(_("A figurinha precisa ser um arquivo .webp -- é o único formato aceito pela API do WhatsApp."))

		file_doc = frappe.get_doc("File", {"file_url": self.image})
		content = file_doc.get_content()
		try:
			image = Image.open(io.BytesIO(content))
		except Exception:
			frappe.throw(_("Não foi possível ler o arquivo como imagem."))
		return content, image

	def _validate_dimensions(self, image):
		if image.size != REQUIRED_DIMENSIONS:
			frappe.throw(
				_("A figurinha precisa ter exatamente 512x512 pixels (a enviada tem {0}x{1}).").format(*image.size)
			)

	def _validate_size(self, file_size):
		limit = ANIMATED_MAX_BYTES if self.is_animated else STATIC_MAX_BYTES
		if file_size > limit:
			frappe.throw(
				_("Figurinha {0} excede o limite de {1}KB do WhatsApp.").format(
					_("animada") if self.is_animated else _("estática"), limit // 1024
				)
			)
