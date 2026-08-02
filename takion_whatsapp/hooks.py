app_name = "takion_whatsapp"
app_title = "Takion WhatsApp"
app_publisher = "Takion"
app_description = "WhatsApp module foundation for Takion multi-tenant SaaS"
app_email = "dev@veloft.com.br"
app_license = "mit"

# Apps
# ------------------

# required_apps = []

# Each item in the list will be shown as an app in the apps page
# add_to_apps_screen = [
# 	{
# 		"name": "takion_whatsapp",
# 		"logo": "/assets/takion_whatsapp/logo.png",
# 		"title": "Takion WhatsApp",
# 		"route": "/takion_whatsapp",
# 		"has_permission": "takion_whatsapp.api.permission.has_app_permission"
# 	}
# ]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
# app_include_css = "/assets/takion_whatsapp/css/takion_whatsapp.css"
# app_include_js = "/assets/takion_whatsapp/js/takion_whatsapp.js"

# include js, css files in header of web template
# web_include_css = "/assets/takion_whatsapp/css/takion_whatsapp.css"
# web_include_js = "/assets/takion_whatsapp/js/takion_whatsapp.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "takion_whatsapp/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
# Bugfix 2026-08-01: layers a disable_password_checks() call onto
# frappe_whatsapp's own "WhatsApp Account" form -- see
# public/js/whatsapp_account_password_checks.js for the root-cause
# explanation (zxcvbn + orjson 64-bit crash on long access tokens). This is
# additive, not a fork: Frappe loads every installed app's doctype_js entry
# for the same doctype, so frappe_whatsapp's own whatsapp_account.js (the
# "Subscribe App to Webhooks" button) still runs too.
doctype_js = {"WhatsApp Account": "public/js/whatsapp_account_password_checks.js"}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
# app_include_icons = "takion_whatsapp/public/icons.svg"

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# automatically load and sync documents of this doctype from downstream apps
# importable_doctypes = [doctype_1]

# Jinja
# ----------

# add methods and filters to jinja environment
# jinja = {
# 	"methods": "takion_whatsapp.utils.jinja_methods",
# 	"filters": "takion_whatsapp.utils.jinja_filters"
# }

# Installation
# ------------

# before_install = "takion_whatsapp.install.before_install"
# after_install = "takion_whatsapp.install.after_install"

# Uninstallation
# ------------

# before_uninstall = "takion_whatsapp.uninstall.before_uninstall"
# after_uninstall = "takion_whatsapp.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "takion_whatsapp.utils.before_app_install"
# after_app_install = "takion_whatsapp.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "takion_whatsapp.utils.before_app_uninstall"
# after_app_uninstall = "takion_whatsapp.utils.after_app_uninstall"

# Build
# ------------------
# To hook into the build process

# after_build = "takion_whatsapp.build.after_build"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "takion_whatsapp.notifications.get_notification_config"

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# Document Events
# ---------------
# Hook on document methods and events

# Fires only on client sites (where frappe_whatsapp / erpnext are installed and
# these doctypes exist); harmless no-op dead code on the gateway site, since no
# such documents are ever created there.
doc_events = {
	"WhatsApp Message": {
		# Order is load-bearing: capture_referral and detect_optout both rely on
		# the WhatsApp Conversation already existing, which
		# link_message_to_conversation is what creates/resolves it. See
		# client/attribution.py's and client/optout.py's module docstrings.
		# fix_incoming_location runs first so a location message's corrected
		# text (see client/location.py) is what link_message_to_conversation
		# reads for the conversation's last_message_preview.
		"after_insert": [
			"takion_whatsapp.client.pricing.capture_pricing",
			"takion_whatsapp.client.location.fix_incoming_location",
			"takion_whatsapp.client.conversation.link_message_to_conversation",
			"takion_whatsapp.client.optout.detect_optout",
			"takion_whatsapp.client.attribution.capture_referral",
			# Entrega 13 ("Figurinhas"): downloads the sticker file frappe_whatsapp's
			# own webhook handler never does for content_type == "sticker" -- no
			# ordering dependency on the other three above, appended last.
			"takion_whatsapp.client.stickers.fetch_incoming_sticker",
			# GIF detection (2026-08-02): covers the OUTGOING case here, where
			# attach is already set before insert -- see on_update below for why
			# INCOMING also needs it there.
			"takion_whatsapp.client.video.detect_gif_video",
		],
		# capture_pricing: Meta often attaches pricing to a later status webhook,
		# not the original message webhook (see client/pricing.py).
		# detect_gif_video: frappe_whatsapp's own webhook.py sets an INCOMING
		# video's `attach` via a SEPARATE save() after the initial insert (the
		# file is downloaded, then attached) -- after_insert above only ever
		# sees attach populated for the OUTGOING case, so incoming needs this
		# on_update leg too. Harmless to re-run on a later, unrelated on_update
		# (e.g. a status-webhook resave) -- just recomputes the same value.
		"on_update": [
			"takion_whatsapp.client.pricing.capture_pricing",
			"takion_whatsapp.client.video.detect_gif_video",
		],
	},
	# Entrega 7 ("Contexto & Funil"): reverse half of the Conversation<->Funnel
	# join -- a Lead created outside WhatsApp that carries a whatsapp_no still
	# resolves onto the same Contact a WhatsApp message for that number would
	# use. See client/pipeline.py's module docstring.
	"Lead": {
		"after_insert": "takion_whatsapp.client.pipeline.resolve_conversation_for_lead",
	},
}

# Custom hook (not a Frappe built-in): per-role context summary for the contact
# panel's role chips (Entrega 7, item 5.2 of the WhatsApp feature backlog).
# Keyed by the linked doctype (must be one of client/contacts.py's
# CONTEXT_ROLE_DOCTYPES); value is a dotted path to a function(name) -> dict.
# frappe.get_hooks merges every installed app's entry for the same key into a
# list -- client/contacts.py::get_role_context always dispatches to the first
# one, so a niche Takion build wanting a different summary for the same
# doctype overrides this by registering its own app earlier in the install
# order, not by editing this file.
whatsapp_context_providers = {
	"Customer": "takion_whatsapp.client.context_providers.customer_context",
	"Supplier": "takion_whatsapp.client.context_providers.supplier_context",
	"Employee": "takion_whatsapp.client.context_providers.employee_context",
}

# Fixtures
# --------
# Entrega 6 ("Onda 0", config-only): sales-funnel Kanban Boards, the WhatsApp UTM
# Source, the WhatsApp workspace's dashboard Number Cards/Charts, and enabling
# Appointment Booking Settings + its generic weekends-off Holiday List. Shipped here
# (not as workspace/*.json app exports) since developer_mode is off on every
# environment -- this is the reproducible-on-install mechanism instead.
fixtures = [
	{"dt": "UTM Source", "filters": [["name", "=", "WhatsApp"]]},
	{"dt": "Kanban Board", "filters": [["name", "in", ["Funil de Leads", "Funil de Oportunidades"]]]},
	{"dt": "Holiday List", "filters": [["name", "like", "Fins de Semana %"]]},
	{"dt": "Appointment Booking Settings"},
	{"dt": "Number Card", "filters": [["module", "=", "Takion WhatsApp"]]},
	{"dt": "Dashboard Chart", "filters": [["module", "=", "Takion WhatsApp"]]},
	# 2026-08-01: consolidated every WhatsApp-related doctype/page from both
	# frappe_whatsapp and takion_whatsapp into ONE categorized workspace
	# ("WhatsApp", nested under "Comunicacao") instead of two separate,
	# flat, auto-generated module dumps. The "Takion WhatsApp" app-switcher
	# entry's own bare-module-listing fallback is separately fixed by a
	# NATIVE (non-fixture) workspace file -- see
	# takion_whatsapp/workspace/takion_whatsapp_home/ -- because Frappe's
	# orphan-workspace cleanup (frappe/model/sync.py::remove_orphan_entities)
	# deletes any public workspace with both `module` and `app` set unless
	# it's shipped as a real <app>/<module>/workspace/<name>/<name>.json
	# file, not merely fixture-imported (confirmed by two failed attempts
	# at redirect workspaces here, auto-deleted on the very next migrate).
	# The "Frappe Whatsapp" module's own equivalent fallback can't be fixed
	# the same way without forking frappe_whatsapp (that file would have to
	# live inside ITS module folder) -- and the literal "Frappe Whatsapp"
	# text in a document's own breadcrumb trail is that DocType's `module`
	# field either way, baked into frappe_whatsapp's own doctype JSON.
	{"dt": "Workspace", "filters": [["name", "=", "WhatsApp"]]},
	# Entrega 8: origin_doctype/origin_name Custom Fields on frappe_whatsapp's
	# "WhatsApp Message" -- actually created idempotently by after_migrate below
	# (create_custom_fields), this entry only exports the resulting records so a
	# completely fresh install (before any migrate has run) still reproduces them.
	{"dt": "Custom Field", "filters": [["dt", "=", "WhatsApp Message"], ["fieldname", "in", ["origin_doctype", "origin_name", "is_gif"]]]},
	# Entrega 10 ("Transmissão Segura"): same idempotent-creation/fixture-export
	# split as Entrega 8, above, for the three other third-party doctypes this
	# Entrega adds Custom Fields to.
	{"dt": "Custom Field", "filters": [["dt", "=", "WhatsApp Recipient"], ["fieldname", "=", "send_status"]]},
	{"dt": "Custom Field", "filters": [["dt", "=", "WhatsApp Recipient List"], ["fieldname", "in", ["auto_refresh", "refresh_frequency_hours", "last_refreshed_at"]]]},
	{"dt": "Custom Field", "filters": [["dt", "=", "Bulk WhatsApp Message"], ["fieldname", "=", "utm_campaign"]]},
	# Entrega 13 ("Figurinhas"): Property Setters widening content_type's Select
	# options and attach's depends_on on the same third-party "WhatsApp Message"
	# doctype -- created idempotently by after_migrate below
	# (client/setup.py::_create_property_setters), this entry only exports the
	# resulting records for a completely fresh install.
	{"dt": "Property Setter", "filters": [["doc_type", "=", "WhatsApp Message"], ["field_name", "in", ["content_type", "attach"]]]},
	# Bugfix 2026-08-01: widen frappe_whatsapp's "WhatsApp Account".
	# webhook_verify_token length (was truncating real Meta access tokens
	# mistakenly typed into that field) and document phone_id/app_id/
	# business_id as Meta string IDs, not numbers -- created idempotently by
	# after_migrate below (client/setup.py::_create_property_setters), this
	# entry only exports the resulting records for a completely fresh install.
	{"dt": "Property Setter", "filters": [["doc_type", "=", "WhatsApp Account"], ["field_name", "in", ["webhook_verify_token", "phone_id", "app_id", "business_id"]]]},
]

# after_migrate
# -------------
after_migrate = ["takion_whatsapp.client.setup.after_migrate"]

# Scheduled Tasks
# ---------------

# Entrega 9 ("SLA / detecção de mensagem perdida"): the app's first
# scheduler_events. Entrega 10 ("Transmissão Segura") reuses this same
# 5-minute cron for broadcast pacing and dynamic-segment refresh, rather than
# introducing a second cadence. Every 5 minutes, not "all" (v16's ~60s tick is
# too frequent for checks this cheap-but-not-free). See client/sla.py's,
# client/broadcast.py's and client/segments.py's module docstrings.
#
# Entrega 12 ("Grupos"): reconcile_pending_groups is the safety net for a
# WhatsApp Group whose create-confirmation webhook never arrives (Meta retries
# webhook delivery for up to 7 days, so anything still Pendente needs an
# active check, not just passive waiting) -- same cron, no new cadence, per
# the user's explicit call (see takion_whatsapp_grupos_decisions memory).
scheduler_events = {
	"cron": {
		"*/5 * * * *": [
			"takion_whatsapp.client.sla.check_sla",
			"takion_whatsapp.client.broadcast.process_pending_batches",
			"takion_whatsapp.client.segments.refresh_dynamic_segments",
			"takion_whatsapp.client.groups.reconcile_pending_groups",
		],
	},
}

# Testing
# -------

# before_tests = "takion_whatsapp.install.before_tests"

# Extend DocType Class
# ------------------------------
#
# Specify custom mixins to extend the standard doctype controller.

# Entrega 7 ("Contexto & Funil"): dedup half of the Conversation<->Funnel join --
# prevents ERPNext's own auto_creation_of_contact from spawning a second,
# disconnected Contact when a Lead is created for a phone number the WhatsApp
# module already resolved a Contact for. See client/pipeline.py's LeadMixin.
#
# Entrega 10 ("Transmissão Segura"): BulkWhatsAppMessageMixin replaces
# queue_messages() with paced, opt-out-aware sending (client/broadcast.py).
# WhatsAppRecipientListMixin fixes a real persistence bug in
# import_list_from_doctype() that would otherwise break dynamic segments
# (client/segments.py).
#
# Entrega 12 ("Grupos"): WhatsAppMessageGroupSendMixin patches the one gap in
# reusing WhatsAppMessage.send_outgoing() unmodified for a group send --
# recipient_type: "group" is never set there (see client/groups.py's mixin
# docstring for why notify() specifically, not send_outgoing(), is the
# override point).
#
# Entrega 13 ("Figurinhas"): WhatsAppMessageStickerMixin patches the same kind
# of gap for a sticker send -- send_outgoing() never builds a `sticker` key in
# the payload for content_type == "sticker" (see client/stickers.py's mixin
# docstring).
#
# WhatsAppMessageVoiceNoteMixin (2026-08-01): send_outgoing() builds
# `data["audio"] = {"link": link}` for content_type == "audio" but never sets
# `voice: true` -- without it Meta renders even a correctly-encoded OGG/Opus
# file as a generic audio-file attachment, not the native voice-note bubble
# (see client/audio.py's mixin docstring).
#
# WhatsAppMessageMediaLinkFixMixin (2026-08-02): frappe_whatsapp's own
# send_outgoing() builds the outgoing `link` as get_url() + "/" + self.attach,
# but self.attach already starts with "/" -- always a double slash right
# after the host for image/video/document/audio. Confirmed live (Cloudflare/
# nginx currently tolerate it, but it's still a malformed URL with no
# guarantee Meta's own fetcher would). Placed last so it normalizes whatever
# link any earlier mixin above it in the chain already set, not just
# frappe_whatsapp's own -- see client/media_link_fix.py's docstring.
#
# All mixins on WhatsApp Message override notify() and call
# super().notify(data), so frappe's extend_doctype_class chains them (see
# frappe/model/base_document.py::_get_extended_class) regardless of list
# order -- each just adds its own key and delegates down to the next one,
# ending at frappe_whatsapp's real HTTP call.
extend_doctype_class = {
	"Lead": "takion_whatsapp.client.pipeline.LeadMixin",
	"Bulk WhatsApp Message": "takion_whatsapp.client.broadcast.BulkWhatsAppMessageMixin",
	"WhatsApp Recipient List": "takion_whatsapp.client.segments.WhatsAppRecipientListMixin",
	"WhatsApp Message": [
		"takion_whatsapp.client.groups.WhatsAppMessageGroupSendMixin",
		"takion_whatsapp.client.stickers.WhatsAppMessageStickerMixin",
		"takion_whatsapp.client.audio.WhatsAppMessageVoiceNoteMixin",
		"takion_whatsapp.client.media_link_fix.WhatsAppMessageMediaLinkFixMixin",
	],
}

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "takion_whatsapp.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "takion_whatsapp.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["takion_whatsapp.utils.before_request"]
# after_request = ["takion_whatsapp.utils.after_request"]

# Job Events
# ----------
# before_job = ["takion_whatsapp.utils.before_job"]
# after_job = ["takion_whatsapp.utils.after_job"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"takion_whatsapp.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
# export_python_type_annotations = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }

# Translation
# ------------
# List of apps whose translatable strings should be excluded from this app's translations.
# ignore_translatable_strings_from = []

