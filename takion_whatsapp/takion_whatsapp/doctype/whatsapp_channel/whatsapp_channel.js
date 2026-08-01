// Copyright (c) 2026, HazeLab and contributors
// For license information, please see license.txt

// Bugfix 2026-08-01: internal_shared_secret/embedded_signup_token are opaque
// API credentials, not human-chosen passwords -- Frappe's zxcvbn-based
// strength meter (frappe.core.doctype.user.user.test_password_strength)
// chokes on long/high-entropy strings: zxcvbn's "guesses" estimate for a
// ~70+ char random token exceeds what Frappe's orjson response serializer
// can encode (int64 range), so the as-you-type strength check 500s with
// "TypeError: Integer exceeds 64-bit range". Since these fields never hold
// a real password, disabling the check (a supported ControlPassword API,
// see public/js/frappe/form/controls/password.js) is the correct fix, not
// a workaround.
frappe.ui.form.on("WhatsApp Channel", {
	refresh(frm) {
		frm.fields_dict.internal_shared_secret?.disable_password_checks();
		frm.fields_dict.embedded_signup_token?.disable_password_checks();
	},
});
