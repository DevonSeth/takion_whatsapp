// Copyright (c) 2026, HazeLab and contributors
// For license information, please see license.txt

// Bugfix 2026-08-01: same fix as whatsapp_channel.js -- meta_app_secret and
// meta_verify_token are opaque credentials, not human-chosen passwords, so
// Frappe's zxcvbn strength-meter check must be disabled for them (see that
// file's comment for the full root-cause explanation of the 64-bit orjson
// crash it triggers).
frappe.ui.form.on("WhatsApp Gateway Settings", {
	refresh(frm) {
		frm.fields_dict.meta_app_secret?.disable_password_checks();
		frm.fields_dict.meta_verify_token?.disable_password_checks();
	},
});
