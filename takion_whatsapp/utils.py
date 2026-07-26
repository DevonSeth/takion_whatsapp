"""Shared helpers used by both the gateway and client sides of takion_whatsapp."""
import json
import re

_BR_COUNTRY_CODE = "55"


def normalize_phone_number(raw):
	"""Canonical matching key for a WhatsApp wa_id/phone number.

	Brazilian mobile numbers have an optional 9th digit (rolled out unevenly between
	~2012-2016) that Meta's webhooks report inconsistently for the same physical number
	across messages — e.g. the first message from a contact arrives as 5511987654321,
	a later one as 551187654321. Left untreated, this silently splits one contact into
	two WhatsApp Conversation records. For DDI 55 numbers, the leading "9" of the
	9-digit subscriber number is stripped so both variants collapse to the same key.
	Every other country code is returned digits-only, unchanged — no assumption is made
	about numbering plans that haven't shown this issue.
	"""
	digits = re.sub(r"\D", "", raw or "")
	if digits.startswith(_BR_COUNTRY_CODE) and len(digits) == 13:
		ddi, ddd, subscriber = digits[:2], digits[2:4], digits[4:]
		if len(subscriber) == 9 and subscriber.startswith("9"):
			return ddi + ddd + subscriber[1:]
	return digits


def format_phone_number_display(normalized):
	"""Human-facing form of a normalized phone number.

	Every real Brazilian mobile number has the 9th digit today — normalize_phone_number()
	strips it only as an internal matching key, because the WhatsApp API reports it
	inconsistently. For display, always reinsert it for DDI 55 numbers so agents see the
	real, correct phone number regardless of what a given payload happened to include.
	"""
	digits = re.sub(r"\D", "", normalized or "")
	if digits.startswith(_BR_COUNTRY_CODE) and len(digits) == 12:
		ddi, ddd, subscriber = digits[:2], digits[2:4], digits[4:]
		return f"+{ddi} {ddd} 9{subscriber[:4]}-{subscriber[4:]}"
	return f"+{digits}" if digits else digits


def phone_number_candidates(raw):
	"""Digit variants worth trying when matching an existing Contact's stored phone —
	the same 9th-digit ambiguity normalize_phone_number() handles can affect how a
	contact's phone was originally saved, with or without it."""
	digits = re.sub(r"\D", "", raw or "")
	normalized = normalize_phone_number(raw)
	candidates = {digits, normalized}
	if normalized.startswith(_BR_COUNTRY_CODE) and len(normalized) == 12:
		ddi, ddd, subscriber = normalized[:2], normalized[2:4], normalized[4:]
		candidates.add(ddi + ddd + "9" + subscriber)
	return candidates


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
