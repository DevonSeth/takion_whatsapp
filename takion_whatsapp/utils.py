"""Shared helpers used by both the gateway and client sides of takion_whatsapp."""
import json
import re

_BR_COUNTRY_CODE = "55"

# Anatel's numbering plan (confirmed via anatel.gov.br "Nono Dígito"): the first digit of
# an 8-digit Brazilian local number is 2-5 for fixed lines and 6-9 for mobile — only
# mobile numbers ever have (or should have) a 9th digit. A 12-digit BR number
# (DDI+DDD+8-digit local) is only mobile-missing-its-9th-digit if the local part falls in
# this range — otherwise it's a landline (WhatsApp Business explicitly supports these,
# verified by voice call instead of SMS) or a non-geographic special number
# (0800/4004/0300/etc — those don't follow the DDI+DDD+8 shape at all and never reach 12
# digits this way), and must NOT have a "9" fabricated into it.
#
# Mexico (extra "1" after DDI 52) and Argentina (extra "9" right after DDI 54) have
# similar but structurally different wa_id quirks of their own — deliberately NOT handled
# here yet (tracked as a pre-launch follow-up, not blocking this Brazil-specific fix).
# Every other country code is untouched by all three functions below, always.
_BR_MOBILE_LOCAL_PREFIXES = ("6", "7", "8", "9")


def _is_br_mobile_local(local_number):
	return len(local_number) == 8 and local_number[0] in _BR_MOBILE_LOCAL_PREFIXES


def normalize_phone_number(raw):
	"""Canonical matching key for a WhatsApp wa_id/phone number.

	Brazilian mobile numbers have an optional 9th digit (rolled out unevenly between
	~2012-2016) that Meta's webhooks report inconsistently for the same physical number
	across messages — e.g. the first message from a contact arrives as 5511987654321,
	a later one as 551187654321. Left untreated, this silently splits one contact into
	two WhatsApp Conversation records. For DDI 55 numbers, the leading "9" of the
	9-digit subscriber number is stripped so both variants collapse to the same key.
	Landlines are naturally 8-digit already (never had a 9th digit to begin with, so a
	13-digit BR number is unambiguously a mobile with its 9 already present) and are
	never touched by this. Every other country code is returned digits-only, unchanged —
	no assumption is made about numbering plans that haven't shown this issue.
	"""
	digits = re.sub(r"\D", "", raw or "")
	if digits.startswith(_BR_COUNTRY_CODE) and len(digits) == 13:
		ddi, ddd, subscriber = digits[:2], digits[2:4], digits[4:]
		if len(subscriber) == 9 and subscriber.startswith("9"):
			return ddi + ddd + subscriber[1:]
	return digits


def format_phone_number_display(normalized):
	"""Human-facing form of a normalized phone number.

	Only reinserts the Brazilian 9th digit when the 8-digit local part actually falls in
	the mobile numbering range (see _is_br_mobile_local) — landlines, 0800/4004/0300-style
	special numbers, and anything else that doesn't match are shown as digits-only instead
	of guessing a formatting. Blindly adding a "9" to every 12-digit BR number would
	fabricate a wrong, nonexistent number for a landline contact. Non-Brazilian numbers
	are always returned as plain "+digits", untouched.
	"""
	digits = re.sub(r"\D", "", normalized or "")
	if digits.startswith(_BR_COUNTRY_CODE) and len(digits) == 12:
		ddi, ddd, local = digits[:2], digits[2:4], digits[4:]
		if _is_br_mobile_local(local):
			return f"+{ddi} {ddd} 9{local[:4]}-{local[4:]}"
		return f"+{ddi} {ddd} {local[:4]}-{local[4:]}"
	return f"+{digits}" if digits else digits


def phone_number_candidates(raw):
	"""Digit variants worth trying when matching an existing Contact's stored phone —
	the same 9th-digit ambiguity normalize_phone_number() handles can affect how a
	contact's phone was originally saved, with or without it. Only adds a with-9 variant
	when the local part is actually in the mobile range, for the same reason
	format_phone_number_display() is careful about it — a landline has no valid with-9
	form to try. Non-Brazilian numbers only ever produce the one digits-only candidate."""
	digits = re.sub(r"\D", "", raw or "")
	normalized = normalize_phone_number(raw)
	candidates = {digits, normalized}
	if normalized.startswith(_BR_COUNTRY_CODE) and len(normalized) == 12:
		ddi, ddd, local = normalized[:2], normalized[2:4], normalized[4:]
		if _is_br_mobile_local(local):
			candidates.add(ddi + ddd + "9" + local)
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


def extract_change(raw_body):
	"""Pull the whole changes[0] object (field + value) out of a raw Meta payload --
	used to detect the 4 WhatsApp Groups webhook types (group_lifecycle_update,
	group_participants_update, group_settings_update, group_status_update), whose
	`value` carries a `groups[]` array instead of `messages[]`/`statuses[]`, so
	neither extract_messages nor extract_statuses fits."""
	try:
		data = json.loads(raw_body)
		try:
			return data["entry"][0]["changes"][0]
		except KeyError:
			return data["entry"]["changes"][0]
	except (KeyError, IndexError, ValueError, TypeError):
		return {}


def extract_messages(raw_body):
	"""Pull the messages[] array (inbound customer messages, incl. any `referral`
	object from a Click-to-WhatsApp ad) out of a raw Meta payload. Outbound status
	updates never appear here -- those are in extract_statuses()'s statuses[]."""
	try:
		data = json.loads(raw_body)
		return data["entry"][0]["changes"][0]["value"].get("messages", [])
	except (KeyError, IndexError, ValueError, TypeError):
		return []
