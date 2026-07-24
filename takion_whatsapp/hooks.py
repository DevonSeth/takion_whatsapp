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
# doctype_js = {"doctype" : "public/js/doctype.js"}
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

# Fires only on client sites (where frappe_whatsapp is installed and its
# "WhatsApp Message" doctype exists); harmless no-op dead code on the gateway
# site, since no such documents are ever created there.
doc_events = {
	"WhatsApp Message": {
		"after_insert": "takion_whatsapp.client.pricing.capture_pricing",
		"on_update": "takion_whatsapp.client.pricing.capture_pricing",
	}
}

# Scheduled Tasks
# ---------------

# scheduler_events = {
# 	"all": [
# 		"takion_whatsapp.tasks.all"
# 	],
# 	"daily": [
# 		"takion_whatsapp.tasks.daily"
# 	],
# 	"hourly": [
# 		"takion_whatsapp.tasks.hourly"
# 	],
# 	"weekly": [
# 		"takion_whatsapp.tasks.weekly"
# 	],
# 	"monthly": [
# 		"takion_whatsapp.tasks.monthly"
# 	],
# }

# Testing
# -------

# before_tests = "takion_whatsapp.install.before_tests"

# Extend DocType Class
# ------------------------------
#
# Specify custom mixins to extend the standard doctype controller.
# extend_doctype_class = {
# 	"Task": "takion_whatsapp.custom.task.CustomTaskMixin"
# }

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

