// Bugfix 2026-08-01: frappe_whatsapp's own "WhatsApp Account".token field is
// an opaque Meta access token, not a human-chosen password -- Frappe's
// zxcvbn-based strength meter (frappe.core.doctype.user.user.test_password_strength)
// chokes on long/high-entropy strings: zxcvbn's "guesses" estimate for a
// ~70+ char random token exceeds what Frappe's orjson response serializer
// can encode (int64 range), so the as-you-type strength check 500s with
// "TypeError: Integer exceeds 64-bit range" -- which surfaced as an "Erro do
// servidor" dialog while just typing/pasting the token into this form.
// Loaded via hooks.py's doctype_js (layered on top of frappe_whatsapp's own
// whatsapp_account.js, not a fork of it -- Frappe merges doctype_js
// contributions from every installed app for the same doctype).
frappe.ui.form.on("WhatsApp Account", {
	refresh(frm) {
		frm.fields_dict.token?.disable_password_checks();
	},
});
