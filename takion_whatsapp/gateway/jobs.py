"""Background job that forwards a validated webhook payload to its owning tenant site.

Runs on a dedicated `whatsapp_gateway` RQ queue so a stuck/slow tenant never
competes with (or blocks) forwarding for other tenants. Implements the
per-channel circuit breaker: repeated failures open the circuit and further
events are logged/skipped without an HTTP attempt, until a cooldown trial
succeeds again.
"""
import requests

import frappe
from frappe.utils import now_datetime, time_diff_in_seconds


def forward_webhook(raw_payload, phone_number_id):
	settings = frappe.get_single("WhatsApp Gateway Settings")
	channel_name = frappe.db.get_value("WhatsApp Channel Registry", {"phone_number_id": phone_number_id})

	if not channel_name:
		_log_delivery(
			None, raw_payload, "Failed",
			error_message=f"No channel registered for phone_number_id={phone_number_id}",
		)
		return

	channel = frappe.get_doc("WhatsApp Channel Registry", channel_name)

	if not channel.is_active:
		_log_delivery(channel.name, raw_payload, "Failed", error_message="Channel is inactive")
		return

	if channel.circuit_state == "Open" and not _cooldown_elapsed(channel, settings):
		_log_delivery(channel.name, raw_payload, "Skipped - Circuit Open")
		return

	try:
		secret = channel.get_password("internal_shared_secret")
		response = requests.post(
			f"{channel.tenant_site_url.rstrip('/')}/api/method/takion_whatsapp.client.internal_webhook.receive",
			data=raw_payload,
			headers={
				"Content-Type": "application/json",
				"X-Internal-Secret": secret,
			},
			timeout=10,
		)
		response.raise_for_status()
	except requests.RequestException as e:
		_record_failure(channel, settings, error_message=str(e))
		_log_delivery(channel.name, raw_payload, "Failed", error_message=str(e))
		return

	_record_success(channel)
	_log_delivery(channel.name, raw_payload, "Delivered", http_status_code=response.status_code)


def _cooldown_elapsed(channel, settings):
	if not channel.opened_at:
		return True
	return time_diff_in_seconds(now_datetime(), channel.opened_at) >= (settings.cooldown_seconds or 300)


def _record_success(channel):
	frappe.db.set_value("WhatsApp Channel Registry", channel.name, {
		"consecutive_failures": 0,
		"circuit_state": "Closed",
		"last_success_at": now_datetime(),
	})


def _record_failure(channel, settings, error_message):
	failures = (channel.consecutive_failures or 0) + 1
	values = {"consecutive_failures": failures}

	threshold = settings.failure_threshold or 5
	if failures >= threshold:
		values["circuit_state"] = "Open"
		values["opened_at"] = now_datetime()
		_alert(channel, settings, error_message)

	frappe.db.set_value("WhatsApp Channel Registry", channel.name, values)


def _alert(channel, settings, error_message):
	if not settings.alert_email:
		return
	frappe.sendmail(
		recipients=[settings.alert_email],
		subject=f"WhatsApp Gateway: circuit opened for {channel.name}",
		message=f"Channel {channel.name} ({channel.tenant_site_url}) failed repeatedly.<br>"
		f"Last error: {frappe.utils.escape_html(error_message)}",
	)


def _log_delivery(channel, raw_payload, status, http_status_code=None, error_message=None):
	frappe.get_doc({
		"doctype": "WhatsApp Gateway Delivery Log",
		"channel": channel,
		"event_timestamp": now_datetime(),
		"raw_payload": raw_payload,
		"status": status,
		"http_status_code": http_status_code,
		"error_message": error_message,
	}).insert(ignore_permissions=True)
