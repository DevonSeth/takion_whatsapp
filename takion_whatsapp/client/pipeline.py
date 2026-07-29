"""Conversation <-> Sales-Funnel join (Entrega 7). Computed on demand, never
stored: a Lead/Opportunity already attaches itself to a Contact via the native
Dynamic Link table (Contact.links) -- the exact same "one Contact, several
simultaneous roles" mechanism client/contacts.py already uses for
Customer/Supplier/Employee, now extended to Lead/Opportunity/Prospect (see
LINKABLE_DOCTYPES there). No new field on WhatsApp Conversation: a Lead is data
that belongs to the funnel, not to the conversation, and a direct `lead` field
would force picking "the one" Lead per conversation instead of letting the
relationship stay historical and free.

Also owns the two pieces that keep that join from silently breaking:
- LeadMixin (extend_doctype_class): ERPNext's own Lead.create_contact(), called
  from before_insert whenever "CRM Settings.auto_creation_of_contact" is on,
  blindly creates a brand-new Contact. Left unpatched, a Lead created from (or
  for) a phone number the WhatsApp module already has a Contact for would spawn
  a second, disconnected Contact -- fighting the module's own phone-based dedup.
- resolve_conversation_for_lead (doc_events, Lead.after_insert): the reverse
  direction. A Lead created entirely outside WhatsApp (import, manual entry,
  mapped from a Quotation, etc.) that happens to carry a whatsapp_no should
  still resolve onto the SAME Contact a future/existing WhatsApp message for
  that number would use -- otherwise the funnel and the inbox silently diverge
  into two Contacts for one real person.

Entrega 8 ("Atribuição & Custo") added LeadMixin.before_insert: stamps
utm_source="WhatsApp" and, when the matching WhatsApp Conversation carries a
captured `ctwa_clid`/referral (see client/attribution.py), auto-resolves or
creates a UTM Campaign from the ad's headline so the existing
campaign_efficiency report picks up WhatsApp-originated Leads without any
manual UTM Campaign bookkeeping -- the report groups by Lead.utm_campaign, so
without this the ROI loop stays closed only for hand-entered Leads.

Both hooks are dead code on the gateway site (no Lead doctype there) and,
following the same gateway-safety pattern as hooks.py's WhatsApp Message
doc_events, harmless no-ops if erpnext isn't installed on a given client site.
"""
import frappe
from frappe.contacts.doctype.contact.contact import get_contact_with_phone_number
from frappe.model.document import Document

from takion_whatsapp.client import contacts
from takion_whatsapp.utils import normalize_phone_number, phone_number_candidates


@frappe.whitelist()
def get_pipeline_state(contact):
	"""Funnel context for the contact panel's "Funil" section: every Lead and
	Opportunity reachable from this Contact, most-recent first.

	Opportunities are gathered two ways, not just via Contact.links: ERPNext's
	own Opportunity controller never appends itself to Contact.links when made
	from a Lead ("Make Opportunity") -- only Lead does that via its own
	after_insert. So besides Opportunities an operator explicitly linked here
	(LINKABLE_DOCTYPES' role picker), this also follows every linked Lead's own
	party_name to catch the common "WhatsApp Lead converted to Opportunity"
	case that would otherwise never show up here at all.
	"""
	if not contact:
		return {"leads": [], "opportunities": []}

	links = frappe.get_all(
		"Dynamic Link",
		filters={
			"parenttype": "Contact",
			"parent": contact,
			"link_doctype": ["in", ["Lead", "Opportunity"]],
		},
		fields=["link_doctype", "link_name"],
	)

	lead_names = [link.link_name for link in links if link.link_doctype == "Lead"]
	linked_opportunity_names = [link.link_name for link in links if link.link_doctype == "Opportunity"]

	leads = (
		frappe.get_list(
			"Lead",
			filters={"name": ["in", lead_names]},
			fields=["name", "lead_name", "status", "modified"],
			order_by="modified desc",
		)
		if lead_names
		else []
	)

	opportunity_names = set(linked_opportunity_names)
	if lead_names:
		via_lead = frappe.get_all(
			"Opportunity",
			filters={"opportunity_from": "Lead", "party_name": ["in", lead_names]},
			pluck="name",
		)
		opportunity_names.update(via_lead)

	opportunities = (
		frappe.get_list(
			"Opportunity",
			filters={"name": ["in", list(opportunity_names)]},
			fields=["name", "title", "status", "opportunity_amount", "modified"],
			order_by="modified desc",
		)
		if opportunity_names
		else []
	)

	return {"leads": leads, "opportunities": opportunities}


class LeadMixin(Document):
	def before_insert(self):
		# MUST call super() first: ERPNext's own Lead.before_insert() is what sets
		# self.contact_doc (read later by after_insert's link_to_contact()) and
		# triggers the auto_creation_of_contact dance this mixin's create_contact()
		# override plugs into. Skipping it (as an earlier version of this method
		# did) crashes after_insert with AttributeError on every Lead that has no
		# whatsapp_no, since self.contact_doc would never get set at all.
		super().before_insert()

		if not self.whatsapp_no:
			return

		if not self.utm_source:
			self.utm_source = "WhatsApp"

		conversation = _find_conversation_attribution(self.whatsapp_no)
		if conversation and conversation.ctwa_clid and not self.utm_campaign:
			self.utm_campaign = _resolve_or_create_utm_campaign(conversation)

	def create_contact(self):
		raw_number = self.whatsapp_no or self.mobile_no or self.phone
		if raw_number:
			for candidate in phone_number_candidates(raw_number):
				existing = get_contact_with_phone_number(candidate)
				if existing:
					return frappe.get_doc("Contact", existing)
		return super().create_contact()


def _find_conversation_attribution(raw_number):
	phone_number = normalize_phone_number(raw_number)
	conversation_name = frappe.db.get_value("WhatsApp Conversation", {"phone_number": phone_number})
	if not conversation_name:
		return None
	return frappe.db.get_value(
		"WhatsApp Conversation", conversation_name, ["ctwa_clid", "referral_headline"], as_dict=True
	)


def _resolve_or_create_utm_campaign(conversation):
	"""UTM Campaign uses autoname "prompt" -- the caller supplies `name` directly,
	there's no separate naming series to resolve. Named after the ad's own
	headline (falling back to the raw ctwa_clid if Meta didn't send one) so the
	campaign_efficiency report groups by something a human recognizes, not an
	opaque click id.
	"""
	campaign_name = conversation.referral_headline or conversation.ctwa_clid
	if not campaign_name:
		return None
	if not frappe.db.exists("UTM Campaign", campaign_name):
		frappe.get_doc({"doctype": "UTM Campaign", "name": campaign_name}).insert(ignore_permissions=True)
	return campaign_name


def resolve_conversation_for_lead(doc, method=None):
	if not doc.whatsapp_no:
		return

	already_linked = frappe.db.exists(
		"Dynamic Link",
		{"parenttype": "Contact", "link_doctype": "Lead", "link_name": doc.name},
	)
	if already_linked:
		return  # ERPNext's own before_insert/after_insert already resolved a Contact for it

	contact = contacts.resolve_or_create_contact(doc.whatsapp_no)
	contacts.link_existing_role(contact, "Lead", doc.name)
