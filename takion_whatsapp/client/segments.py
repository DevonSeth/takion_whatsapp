"""Entrega 10 ("Transmissão Segura"), item 5: turns "WhatsApp Recipient List"
from a static list into an optionally dynamic segment. Reuses Entrega 9's
existing 5-minute cron (see hooks.py) -- no new scheduler cadence.

WhatsAppRecipientListMixin fixes a real bug in frappe_whatsapp's
import_list_from_doctype(): it persists the caller's `filters` argument onto a
plain Python attribute (`self.filters`), never onto the actual DB field
(`import_filters`) -- so a later reimport with no `filters` argument re-applied
never remembers the filter from the time before. This is a prerequisite for
auto-refresh: refresh_dynamic_segments() below re-calls
import_list_from_doctype() reading doctype_to_import/mobile_field/
import_filters straight from the DB each tick, and without the fix a segment
whose filter was only ever set via a direct Python/API call (not hand-typed
into the form and saved first) would silently lose it on the very first
refresh.

import_list_from_doctype() is destructive (self.recipients = [] then
repopulated) -- refresh_dynamic_segments() skips any list currently in use by
an In Progress broadcast, so a scheduled refresh never wipes recipients out
from under a send in progress. (client/broadcast.py additionally snapshots a
list's rows onto the broadcast's own recipients table at submit time, so this
guard is defense-in-depth rather than the only thing preventing data loss --
kept because it's cheap and still closes the gap for a second broadcast
referencing the same list while the first is still sending.)
"""
import json

import frappe
from frappe.model.document import Document
from frappe.utils import add_to_date, cint


class WhatsAppRecipientListMixin(Document):
	def import_list_from_doctype(self, doctype, mobile_field, name_field=None, filters=None, limit=None, data_fields=None):
		count = super().import_list_from_doctype(
			doctype, mobile_field, name_field=name_field, filters=filters, limit=limit, data_fields=data_fields
		)
		# The real fix: persist onto the actual field, not the upstream
		# method's own (unpersisted) self.filters attribute.
		self.import_filters = json.dumps(filters) if filters else None
		return count


def refresh_dynamic_segments():
	now = frappe.utils.now_datetime()
	lists = frappe.get_all(
		"WhatsApp Recipient List",
		filters={"auto_refresh": 1},
		fields=[
			"name", "refresh_frequency_hours", "last_refreshed_at",
			"doctype_to_import", "mobile_field", "name_field",
			"import_filters", "import_limit", "data_fields",
		],
	)

	for row in lists:
		if not row.doctype_to_import or not row.mobile_field:
			continue  # marked auto_refresh but never actually configured as an import segment

		if row.last_refreshed_at:
			due_at = add_to_date(row.last_refreshed_at, hours=cint(row.refresh_frequency_hours) or 24)
			if due_at > now:
				continue

		if _list_in_use_by_in_progress_broadcast(row.name):
			continue

		doc = frappe.get_doc("WhatsApp Recipient List", row.name)
		doc.import_list_from_doctype(
			doctype=row.doctype_to_import,
			mobile_field=row.mobile_field,
			name_field=row.name_field,
			filters=json.loads(row.import_filters) if row.import_filters else None,
			limit=row.import_limit,
			data_fields=json.loads(row.data_fields) if row.data_fields else None,
		)
		doc.save(ignore_permissions=True)
		frappe.db.set_value("WhatsApp Recipient List", row.name, "last_refreshed_at", now, update_modified=False)

	frappe.db.commit()  # nosemgrep: frappe-manual-commit -- scheduler task, same pattern as client/sla.py


def _list_in_use_by_in_progress_broadcast(list_name):
	return bool(frappe.db.exists(
		"Bulk WhatsApp Message",
		{"recipient_list": list_name, "status": "In Progress", "docstatus": 1},
	))
