"""Dedup + multi-role linking between a WhatsApp Contact and Customer/Supplier/
Employee, all via Frappe's native Dynamic Link table (Contact.links) — the exact
"one Contact, several simultaneous roles" mechanism already used throughout
ERPNext, no new entity or custom field.

Customer and Supplier carry no phone number of their own: `mobile_no` on both is
a Read Only field fetched from customer_primary_contact/supplier_primary_contact,
so a phone match for either of them is already covered by the existing
Contact-phone search in client/conversation.py. Employee is the one party
doctype with an independent phone (`cell_number`) that ERPNext never links back
to a Contact automatically — that's the actual dedup gap this module closes.
"""
import frappe
from frappe.contacts.doctype.contact.contact import get_contact_with_phone_number

from takion_whatsapp.utils import phone_number_candidates

LINKABLE_DOCTYPES = ("Customer", "Supplier", "Employee")

_PRIMARY_CONTACT_FIELD = {
	"Customer": "customer_primary_contact",
	"Supplier": "supplier_primary_contact",
}

_TITLE_FIELD = {
	"Customer": "customer_name",
	"Supplier": "supplier_name",
	"Employee": "employee_name",
}


def _unlinked_employee_matches(raw_number):
	"""Employees whose cell_number matches raw_number and that have no Dynamic
	Link to any Contact yet — candidates worth surfacing/auto-linking, as opposed
	to an Employee already linked (which would already show up as a role badge).
	"""
	seen = set()
	matches = []
	for candidate in phone_number_candidates(raw_number):
		for employee in frappe.get_all(
			"Employee",
			filters={"cell_number": ["like", f"%{candidate}%"]},
			fields=["name", "employee_name"],
		):
			if employee.name in seen:
				continue
			if frappe.db.exists(
				"Dynamic Link",
				{"link_doctype": "Employee", "link_name": employee.name, "parenttype": "Contact"},
			):
				continue
			seen.add(employee.name)
			matches.append({"doctype": "Employee", "name": employee.name, "title": employee.employee_name})
	return matches


@frappe.whitelist()
def find_party_matches(raw_number):
	"""Candidates worth offering to link for a phone number, used by the "+" role
	picker and the "Novo Contato" button — lets an operator confirm a link instead
	of blindly creating a duplicate Employee record.
	"""
	return _unlinked_employee_matches(raw_number)


@frappe.whitelist()
def find_contact_by_phone(raw_number):
	"""Whether a Contact already exists for this number — checked by "Novo
	Contato" before creating one, so the operator gets told about the existing
	record instead of a silent duplicate.
	"""
	for candidate in phone_number_candidates(raw_number):
		existing = get_contact_with_phone_number(candidate)
		if existing:
			return existing
	return None


@frappe.whitelist()
def create_contact(raw_number, first_name=None):
	"""Bare Contact creation for "Novo Contato" once find_contact_by_phone has
	confirmed none exists yet. Role linking (if any) happens as a separate,
	explicit step via link_existing_role/create-and-link — never bundled blindly
	into this call.
	"""
	contact = frappe.new_doc("Contact")
	contact.first_name = first_name or raw_number
	contact.append("phone_nos", {"phone": raw_number, "is_primary_mobile_no": 1})
	contact.insert(ignore_permissions=True)
	return contact.name


@frappe.whitelist()
def get_contact_roles(contact):
	if not contact:
		return []
	links = frappe.get_all(
		"Dynamic Link",
		filters={"parenttype": "Contact", "parent": contact},
		fields=["link_doctype", "link_name", "link_title"],
	)
	return [
		{"doctype": link.link_doctype, "name": link.link_name, "title": link.link_title or link.link_name}
		for link in links
	]


@frappe.whitelist()
def link_existing_role(contact, link_doctype, link_name):
	"""Attach an already-existing Customer/Supplier/Employee to a Contact via the
	native Dynamic Link table. Idempotent. Back-fills the party's own
	customer_primary_contact/supplier_primary_contact when empty, so ERPNext's own
	fetch-only fields (e.g. Customer.mobile_no) keep working instead of going
	stale — Employee has no such back-reference field, so nothing to back-fill.
	"""
	if link_doctype not in LINKABLE_DOCTYPES:
		frappe.throw(f"{link_doctype} não é um tipo de vínculo permitido")

	contact_doc = frappe.get_doc("Contact", contact)
	already_linked = any(
		link.link_doctype == link_doctype and link.link_name == link_name for link in contact_doc.links
	)
	if not already_linked:
		contact_doc.append("links", {"link_doctype": link_doctype, "link_name": link_name})
		contact_doc.save(ignore_permissions=True)

	primary_field = _PRIMARY_CONTACT_FIELD.get(link_doctype)
	if primary_field and not frappe.db.get_value(link_doctype, link_name, primary_field):
		frappe.db.set_value(link_doctype, link_name, primary_field, contact)

	return get_contact_roles(contact)


@frappe.whitelist()
def search_linkable(link_doctype, txt=""):
	"""Search-as-you-type source for the "+" role picker's "vincular existente"
	tab — restricted to the roles this Entrega supports, not a generic doctype
	search.
	"""
	if link_doctype not in LINKABLE_DOCTYPES:
		frappe.throw(f"{link_doctype} não é um tipo de vínculo permitido")

	title_field = _TITLE_FIELD[link_doctype]
	filters = {title_field: ["like", f"%{txt}%"]} if txt else {}
	return frappe.get_list(link_doctype, filters=filters, fields=["name", f"{title_field} as title"], limit_page_length=20)


def resolve_or_create_contact(raw_number):
	"""Automatic (no operator present) Contact resolution for a raw wa_id — used
	by the inbound-message hook. Tries an existing Contact first (as Entrega 1
	already did), then an unambiguous single Employee match (safe to auto-link,
	same trust level Entrega 1 already applied to Contact-phone LIKE matching),
	and only then falls back to creating a bare Contact with just the phone
	number — unchanged from Entrega 1's behavior when nothing matches.

	Deliberately does not search Customer/Supplier here — see module docstring,
	a Customer/Supplier phone match is already covered by the Contact search
	above, since neither carries a phone number of its own.
	"""
	for candidate in phone_number_candidates(raw_number):
		existing = get_contact_with_phone_number(candidate)
		if existing:
			return existing

	employee_matches = _unlinked_employee_matches(raw_number)

	contact = frappe.new_doc("Contact")
	contact.first_name = raw_number
	contact.append("phone_nos", {"phone": raw_number, "is_primary_mobile_no": 1})
	if len(employee_matches) == 1:
		contact.append("links", {"link_doctype": "Employee", "link_name": employee_matches[0]["name"]})
	contact.insert(ignore_permissions=True)
	return contact.name
