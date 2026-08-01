// Copyright (c) 2026, HazeLab and contributors
// For license information, please see license.txt

// Bugfix 2026-08-01: same fix as whatsapp_channel.js -- internal_shared_secret
// is an opaque credential, not a human-chosen password, so Frappe's zxcvbn
// strength-meter check must be disabled for it (see that file's comment for
// the full root-cause explanation of the 64-bit orjson crash it triggers).
frappe.ui.form.on("WhatsApp Channel Registry", {
	refresh(frm) {
		frm.fields_dict.internal_shared_secret?.disable_password_checks();
	},
});
