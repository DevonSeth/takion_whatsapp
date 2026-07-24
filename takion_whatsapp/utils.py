"""Shared helpers used by both the gateway and client sides of takion_whatsapp."""
import json


def extract_phone_number_id(raw_body):
	"""Pull metadata.phone_number_id out of a raw Meta webhook payload (bytes or str)."""
	try:
		data = json.loads(raw_body)
		return data["entry"][0]["changes"][0]["value"]["metadata"]["phone_number_id"]
	except (KeyError, IndexError, ValueError, TypeError):
		return None


def extract_statuses(raw_body):
	"""Pull the statuses[] array (delivery/read/pricing events) out of a raw Meta payload."""
	try:
		data = json.loads(raw_body)
		return data["entry"][0]["changes"][0]["value"].get("statuses", [])
	except (KeyError, IndexError, ValueError, TypeError):
		return []
