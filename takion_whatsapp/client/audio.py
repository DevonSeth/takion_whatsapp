"""WebM/Opus -> OGG/Opus conversion for operator-recorded voice notes.

The browser's MediaRecorder API only produces WebM/Opus, but Meta only renders
a message as a native voice-note bubble (instead of a generic downloadable
file) when it's OGG with the Opus codec — see
takion_whatsapp_whatsapp_feature_backlog item 4 for the sourced constraint.
This runs in the background (queue "short") so the operator's browser isn't
blocked on the ffmpeg subprocess; the actual send afterwards reuses
frappe_whatsapp's existing content_type="audio" path unchanged (same as
client.inbox.send_message's text path).
"""
import os
import subprocess

import frappe
from frappe.utils.file_manager import save_file

# 24kbps mono Opus keeps a 120s recording (the client-side cap) around 360KB —
# comfortably under the 512KB threshold Meta uses to decide whether to show
# the native play icon vs. a generic "download file" affordance.
FFMPEG_AUDIO_ARGS = ["-c:a", "libopus", "-b:a", "24k", "-ac", "1", "-ar", "16000"]


def convert_and_send(conversation, file_url):
	webm_file = frappe.get_doc("File", {"file_url": file_url})
	webm_path = webm_file.get_full_path()
	ogg_path = os.path.splitext(webm_path)[0] + ".ogg"

	# The raw browser recording is always scratch, whether the rest of this
	# succeeds or not (ffmpeg failure, or frappe_whatsapp's send_outgoing()
	# raising via frappe.throw() on a Meta API error, which aborts doc.insert()
	# entirely) — clean it up in `finally` rather than only on the happy path.
	try:
		try:
			subprocess.run(
				["ffmpeg", "-y", "-i", webm_path, *FFMPEG_AUDIO_ARGS, ogg_path],
				check=True,
				capture_output=True,
				timeout=60,
			)
		except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
			frappe.log_error(title="WhatsApp voice note conversion failed", message=frappe.get_traceback())
			return

		with open(ogg_path, "rb") as f:
			ogg_content = f.read()
		os.remove(ogg_path)

		conv = frappe.get_doc("WhatsApp Conversation", conversation)
		ogg_file = save_file(
			f"voice-note-{frappe.generate_hash(length=8)}.ogg",
			ogg_content,
			"WhatsApp Conversation",
			conv.name,
			is_private=0,
		)

		doc = frappe.new_doc("WhatsApp Message")
		doc.type = "Outgoing"
		doc.content_type = "audio"
		doc.to = conv.wa_id
		doc.attach = ogg_file.file_url
		doc.reference_doctype = "WhatsApp Conversation"
		doc.reference_name = conv.name
		doc.insert(ignore_permissions=True)
		# before_insert (frappe_whatsapp) sends via Meta; after_insert (hooks.py's
		# doc_events) links the conversation and publishes whatsapp_inbox_update —
		# both already wired for every WhatsApp Message, nothing extra needed here.
	finally:
		frappe.delete_doc("File", webm_file.name, ignore_permissions=True)
