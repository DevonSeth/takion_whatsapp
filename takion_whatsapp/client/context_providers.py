"""Default whatsapp_context_providers (Entrega 7, item 5.2) for the three role
types the user named explicitly: Customer, Supplier, Employee. Registered in
hooks.py and dispatched by client/contacts.py::get_role_context -- kept in their
own module (not inside contacts.py) since each function here embeds real
business-module knowledge (Sales Order/Purchase Order/Employee fields), unlike
the rest of contacts.py which stays deliberately generic across doctypes.

A niche-specific Takion build that wants a different summary (or one for a
doctype not covered here) overrides this by registering its own function for
the same key in its own app's whatsapp_context_providers -- frappe.get_hooks
merges values from every installed app into one list; client/contacts.py's
get_role_context always takes the first-registered handler, so app install
order decides precedence in a multi-app override scenario.
"""
import frappe


def customer_context(name):
	last_order = frappe.get_list(
		"Sales Order",
		filters={"customer": name},
		fields=["name", "status", "transaction_date"],
		order_by="transaction_date desc",
		limit_page_length=1,
	)
	outstanding = frappe.db.sql(
		"select sum(outstanding_amount) from `tabSales Invoice` where customer=%s and docstatus=1",
		name,
	)[0][0] or 0
	return {
		"last_order": last_order[0] if last_order else None,
		"outstanding_amount": outstanding,
	}


def supplier_context(name):
	last_po = frappe.get_list(
		"Purchase Order",
		filters={"supplier": name},
		fields=["name", "status", "transaction_date"],
		order_by="transaction_date desc",
		limit_page_length=1,
	)
	pending_deliveries = frappe.db.count(
		"Purchase Order",
		filters={"supplier": name, "status": ["in", ["To Receive and Bill", "To Receive"]]},
	)
	return {
		"last_po": last_po[0] if last_po else None,
		"pending_deliveries": pending_deliveries,
	}


def employee_context(name):
	return frappe.db.get_value(
		"Employee", name, ["department", "designation", "status"], as_dict=True
	)
