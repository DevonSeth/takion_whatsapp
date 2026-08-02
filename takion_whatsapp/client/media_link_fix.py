"""Fixes a real, confirmed double-slash bug in outgoing media links.

frappe_whatsapp's own `send_outgoing()` builds the `link` for any non-http
`attach` as `frappe.utils.get_url() + "/" + self.attach` -- but `self.attach`
is a Frappe file_url, which already starts with "/" (e.g. "/files/x.pdf"), so
the result is always `https://site.com//files/x.pdf` (double slash right
after the host) for every outgoing image/video/document/audio message.
`client/stickers.py`'s own `WhatsAppMessageStickerMixin` builds its sticker
link the same buggy way.

Confirmed 2026-08-02: Cloudflare and nginx currently resolve the double-slash
URL fine (direct curl comparison, identical 200 response either way), but
that's the CDN/proxy layer tolerating a malformed URL, not the URL being
correct -- there's no guarantee Meta's own media-fetching service, a future
proxy config, or any other consumer of this link would be as forgiving.

`notify(self, data)` is the surgical override point the rest of the app
already uses (see Entrega 12/13's mixins) -- by the time any mixin's notify()
runs, `send_outgoing()` has already built the full `data` payload including
the buggy link, so this only needs to normalize it in place before delegating
down the chain, not rebuild it.
"""
import re

from frappe.model.document import Document

_REPEATED_SLASHES = re.compile(r"/{2,}")


def _dedupe_path_slashes(link):
	"""Collapse repeated slashes in the host+path, leaving the "://" after the
	scheme untouched.
	"""
	if not link:
		return link
	sep = "://"
	idx = link.find(sep)
	if idx == -1:
		return _REPEATED_SLASHES.sub("/", link)
	head, rest = link[: idx + len(sep)], link[idx + len(sep):]
	return head + _REPEATED_SLASHES.sub("/", rest)


class WhatsAppMessageMediaLinkFixMixin(Document):
	def notify(self, data):
		for key in ("image", "video", "document", "audio", "sticker"):
			entry = data.get(key)
			if isinstance(entry, dict) and entry.get("link"):
				entry["link"] = _dedupe_path_slashes(entry["link"])
		super().notify(data)
