"""Entrega 10 ("Transmissão Segura"): extends frappe_whatsapp's "Bulk WhatsApp
Message" (extend_doctype_class, never fork frappe_whatsapp) to close three real
gaps confirmed in the upstream code (see
takion_whatsapp_professional_features_research memory): zero rate limiting on
submit (queue_messages fans out every recipient at once via frappe.enqueue_doc),
a dead scheduled_time field nothing ever reads, and zero opt-out enforcement.

Design: on_submit no longer sends anything. queue_messages() is overridden to
only resolve the final recipient set once -- snapshotting a Recipient List's
rows onto THIS document (a shared list can be reused/auto-refreshed by other
broadcasts later, see client/segments.py, so a broadcast must own its own copy
rather than reading the live list mid-send) -- and stamps every row with
send_status (WhatsApp Recipient Custom Field): "Opt-out" for a number already
opted out (first of the two opt-out filter points), "Pending" otherwise.

process_pending_batches, the scheduler task, reuses Entrega 9's existing
5-minute cron (see hooks.py) rather than introducing a new cadence. Each tick:
skips a broadcast whose scheduled_time hasn't arrived yet (this is what
finally makes that field do something), re-checks opt-out status right before
sending (second filter point -- a number can opt out mid-way through a
scheduled/paced send that spans hours or days), and reuses
create_single_message unchanged for the actual send.
"""
import frappe
from frappe.model.document import Document
from frappe.utils import cint, get_datetime

from takion_whatsapp.client.optout import is_opted_out


class BulkWhatsAppMessageMixin(Document):
	def queue_messages(self):
		"""Full override, not an extension -- calling super() here would do the
		exact mass-fan-out-with-no-pacing this Entrega exists to prevent.
		"""
		if self.recipient_type == "Recipient List" and self.recipient_list:
			self._snapshot_recipient_list()

		processable = self._stamp_send_status()

		if processable:
			self.db_set("recipient_count", processable, update_modified=False)
			self.db_set("status", "Queued", update_modified=False)
		else:
			# Every resolved recipient was already opted out -- nothing left to
			# do, and nothing will ever call create_single_message for this
			# broadcast, so it must not sit in "Queued" forever.
			self.db_set("status", "Completed", update_modified=False)

	def _snapshot_recipient_list(self):
		list_rows = frappe.get_all(
			"WhatsApp Recipient",
			filters={"parent": self.recipient_list, "parenttype": "WhatsApp Recipient List"},
			fields=["mobile_number", "recipient_name", "recipient_data"],
		)
		for row in list_rows:
			frappe.get_doc({
				"doctype": "WhatsApp Recipient",
				"parent": self.name,
				"parenttype": "Bulk WhatsApp Message",
				"parentfield": "recipients",
				"mobile_number": row.mobile_number,
				"recipient_name": row.recipient_name,
				"recipient_data": row.recipient_data,
			}).insert(ignore_permissions=True)

	def _stamp_send_status(self):
		rows = frappe.get_all(
			"WhatsApp Recipient",
			filters={"parent": self.name, "parenttype": "Bulk WhatsApp Message"},
			fields=["name", "mobile_number"],
		)
		processable = 0
		for row in rows:
			if is_opted_out(self.whatsapp_account, row.mobile_number):
				status = "Opt-out"
			else:
				status = "Pending"
				processable += 1
			frappe.db.set_value("WhatsApp Recipient", row.name, "send_status", status, update_modified=False)
		return processable


def process_pending_batches():
	settings = frappe.get_single("WhatsApp Broadcast Settings")
	batch_size = cint(settings.broadcast_batch_size) or 50
	now = frappe.utils.now_datetime()

	broadcasts = frappe.get_all(
		"Bulk WhatsApp Message",
		filters={"docstatus": 1, "status": ["in", ["Queued", "In Progress"]]},
		fields=["name", "scheduled_time", "whatsapp_account"],
	)

	for broadcast in broadcasts:
		if broadcast.scheduled_time and get_datetime(broadcast.scheduled_time) > now:
			continue  # item 3: scheduled_time not reached yet

		_process_one_batch(broadcast, batch_size)

	frappe.db.commit()  # nosemgrep: frappe-manual-commit -- scheduler task, same pattern as client/sla.py


def _process_one_batch(broadcast, batch_size):
	pending = frappe.get_all(
		"WhatsApp Recipient",
		filters={"parent": broadcast.name, "parenttype": "Bulk WhatsApp Message", "send_status": "Pending"},
		fields=["name", "mobile_number", "recipient_name", "recipient_data"],
		limit_page_length=batch_size,
	)

	if not pending:
		_finalize_if_done(broadcast.name)
		return

	frappe.db.set_value("Bulk WhatsApp Message", broadcast.name, "status", "In Progress", update_modified=False)
	doc = frappe.get_doc("Bulk WhatsApp Message", broadcast.name)

	for row in pending:
		if is_opted_out(broadcast.whatsapp_account, row.mobile_number):
			frappe.db.set_value("WhatsApp Recipient", row.name, "send_status", "Opt-out", update_modified=False)
			continue

		try:
			doc.create_single_message(row)  # existing frappe_whatsapp method, unchanged
		except Exception:
			frappe.log_error(title=f"WhatsApp broadcast pacing failed: {broadcast.name}/{row.name}")

		# create_single_message never re-raises a failed Meta send: its own
		# try/except around wa_message.insert() swallows it, and a failure
		# inside WhatsApp Message.before_insert (send_outgoing -> frappe.throw)
		# means that message row never actually gets persisted for this
		# attempt. So success/failure has to be read back from whether a
		# message row actually landed, not from exception propagation.
		sent = frappe.db.exists(
			"WhatsApp Message",
			{"bulk_message_reference": broadcast.name, "to": row.mobile_number},
		)
		frappe.db.set_value(
			"WhatsApp Recipient", row.name, "send_status", "Sent" if sent else "Failed", update_modified=False
		)

	# create_single_message's own internal bookkeeping (self.recipient_count ==
	# self.sent_count, or its except-branch) can flip the parent's status to
	# "Completed"/"Partially Failed" on its own, even while recipients from
	# THIS broadcast are still Pending (its sent_count also counts Opt-out
	# rows we skipped calling it for, and increments unconditionally on
	# failure too -- a pre-existing upstream quirk, not something to patch).
	# Reassert "In Progress" here so the parent status stays accurate for as
	# long as any row is still Pending; _finalize_if_done below is the only
	# thing allowed to promote it to a terminal state.
	frappe.db.set_value("Bulk WhatsApp Message", broadcast.name, "status", "In Progress", update_modified=False)
	_finalize_if_done(broadcast.name)


def _finalize_if_done(name):
	remaining = frappe.db.count(
		"WhatsApp Recipient",
		{"parent": name, "parenttype": "Bulk WhatsApp Message", "send_status": "Pending"},
	)
	if remaining:
		return
	has_failed = frappe.db.exists(
		"WhatsApp Recipient",
		{"parent": name, "parenttype": "Bulk WhatsApp Message", "send_status": "Failed"},
	)
	frappe.db.set_value(
		"Bulk WhatsApp Message", name, "status", "Partially Failed" if has_failed else "Completed",
		update_modified=False,
	)
