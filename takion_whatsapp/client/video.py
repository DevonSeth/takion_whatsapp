"""Detects a GIF sent via WhatsApp's own app, which Meta's Cloud API delivers as
a plain content_type=video message -- there is no distinct GIF message type and
no distinguishing webhook field (confirmed live, 2026-08-02: a real recorded
video and a GIF-derived one had byte-identical payload shapes, both
`{"mime_type": "video/mp4", ...}`). The one signal that DOES differ in
practice: WhatsApp converts a GIF to a silent, looping MP4 with no audio
stream, while a genuine recorded video almost always has one (confirmed via
ffprobe on both real files from the same test session).

Wired as a doc_events after_insert on "WhatsApp Message" (hooks.py), same
extension point Entrega 13's fetch_incoming_sticker uses -- runs after
frappe_whatsapp's own image/audio/video/document download branch has already
set `attach`, so the file is on disk by the time this probes it.
"""
import json
import subprocess

import frappe


def detect_gif_video(doc, method=None):
	if doc.content_type != "video" or not doc.attach:
		return

	file_name = frappe.db.get_value("File", {"file_url": doc.attach})
	if not file_name:
		return
	file_doc = frappe.get_doc("File", file_name)
	try:
		result = subprocess.run(
			[
				"ffprobe", "-v", "error", "-print_format", "json",
				"-show_entries", "stream=codec_type", file_doc.get_full_path(),
			],
			check=True, capture_output=True, timeout=15,
		)
	except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
		frappe.log_error(title="WhatsApp GIF detection (ffprobe) failed", message=frappe.get_traceback())
		return

	streams = json.loads(result.stdout).get("streams", [])
	has_audio = any(s.get("codec_type") == "audio" for s in streams)
	doc.db_set("is_gif", 0 if has_audio else 1, update_modified=False)
