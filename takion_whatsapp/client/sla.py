"""Entrega 9 ("SLA / detecção de mensagem perdida"): the app's first
scheduler_events (Entrega 10's broadcast pacing reuses this same
infrastructure). Periodically checks every WhatsApp Conversation with a
pending (unanswered) inbound message against WhatsApp SLA Settings'
thresholds, in business-hours minutes -- not wall-clock minutes, or every
Friday-evening conversation would read as breached by Saturday morning.

Thresholds and business hours are deliberately NOT hardcoded anywhere here --
WhatsApp SLA Settings is a real editable singleton, since what counts as a
missed message varies by the client's own business (a clinic's SLA is not a
parts store's SLA). See takion_whatsapp_entrega9_decisions memory for the
user's explicit call on this.

Uses db_set(..., update_modified=False) throughout: WhatsApp Conversation has
track_changes: 1, and a plain save() on every 5-minute tick would generate a
Version record per conversation per tick.
"""
import json
from datetime import datetime, timedelta

import frappe
from frappe import _
from frappe.desk.doctype.notification_log.notification_log import enqueue_create_notification
from frappe.utils import get_time

from erpnext.setup.doctype.holiday_list.holiday_list import is_holiday

# date.weekday(): Monday=0 .. Sunday=6 -- matches this list's order.
_WEEKDAY_FIELDS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def _is_business_day(settings, date):
	"""Days with no attendance at all (unchecked in WhatsApp SLA Settings) are
	skipped exactly like a holiday -- same effect, without having to enumerate
	every Saturday/Sunday (or whichever days a given client doesn't operate)
	as individual Holiday List rows.
	"""
	return bool(settings.get(_WEEKDAY_FIELDS[date.weekday()]))


def business_minutes_elapsed(start, end, settings):
	"""Minutes of business-hours overlap between [start, end], walked day by day
	and skipping any day that's either a non-attendance weekday (settings.monday
	.. settings.sunday) or a date in settings.holiday_list (if set). Handles a
	start that falls outside business hours on its own day correctly with no
	special case: that day's window ends up empty since day_end < start, and
	later days are unaffected.

	frappe.utils.get_time() normalizes business_start_time/business_end_time
	regardless of whether the Time field arrives as a string (an in-memory
	Document's own JSON-applied default, e.g. from get_single() before the
	singleton has ever been saved) or a timedelta (the usual shape once a value
	has actually round-tripped through the database) -- confirmed both occur in
	practice, not just a hypothetical.
	"""
	if not start or not end or end <= start:
		return 0

	business_start = get_time(settings.business_start_time)
	business_end = get_time(settings.business_end_time)

	total = timedelta()
	current_date = start.date()
	while current_date <= end.date():
		if _is_business_day(settings, current_date) and not (
			settings.holiday_list and is_holiday(settings.holiday_list, current_date)
		):
			day_start = datetime.combine(current_date, business_start)
			day_end = datetime.combine(current_date, business_end)
			window_start = max(day_start, start)
			window_end = min(day_end, end)
			if window_end > window_start:
				total += window_end - window_start
		current_date += timedelta(days=1)

	return total.total_seconds() / 60


def check_sla():
	settings = frappe.get_single("WhatsApp SLA Settings")
	if not settings.enabled:
		return

	now = frappe.utils.now_datetime()
	conversations = frappe.get_all(
		"WhatsApp Conversation",
		filters={
			"first_unanswered_inbound_at": ["is", "set"],
			"sla_state": ["!=", "Estourado"],
		},
		fields=["name", "first_unanswered_inbound_at", "sla_state", "_assign"],
	)

	for conversation in conversations:
		elapsed = business_minutes_elapsed(conversation.first_unanswered_inbound_at, now, settings)

		new_state = "OK"
		if elapsed >= settings.breach_threshold_minutes:
			new_state = "Estourado"
		elif elapsed >= settings.warning_threshold_minutes:
			new_state = "Em risco"

		if new_state == conversation.sla_state:
			continue

		frappe.db.set_value(
			"WhatsApp Conversation", conversation.name, "sla_state", new_state, update_modified=False
		)
		frappe.publish_realtime(
			"whatsapp_inbox_update", {"conversation": conversation.name}, after_commit=True
		)

		if new_state == "Estourado":
			_notify_breach(conversation)

	frappe.db.commit()


def _notify_breach(conversation):
	"""Active notification -- only when someone is actually assigned; the
	always-on visual badge (sla_state itself, rendered client-side) already
	covers the case where nobody's watching this conversation yet.
	"""
	try:
		assignees = json.loads(conversation.get("_assign") or "[]")
	except ValueError:
		assignees = []
	if not assignees:
		return

	enqueue_create_notification(assignees, {
		"type": "Alert",
		"subject": _("Conversa do WhatsApp sem resposta há muito tempo"),
		"document_type": "WhatsApp Conversation",
		"document_name": conversation.name,
	})
