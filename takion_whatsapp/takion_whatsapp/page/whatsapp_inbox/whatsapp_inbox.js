frappe.pages['whatsapp-inbox'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'WhatsApp Inbox',
		single_column: true,
	});

	// Loaded sequentially, not as one frappe.require([...]) array: dynamically
	// inserted <script> tags default to async=true, so two items in the same
	// call can execute in either order. The Record plugin's UMD wrapper only
	// extends an existing window.WaveSurfer, while the core lib's wrapper
	// replaces window.WaveSurfer outright — if the plugin ran first, the core
	// script would silently wipe it (window.WaveSurfer.Record undefined).
	frappe.require('/assets/takion_whatsapp/js/lib/wavesurfer.min.js')
		.then(() => frappe.require('/assets/takion_whatsapp/js/lib/wavesurfer.record.min.js'))
		.then(() => {
			new takion_whatsapp.WhatsAppInbox(page);
		});
};

frappe.provide('takion_whatsapp');

// Doctypes with a per-role context provider registered (see hooks.py's
// whatsapp_context_providers) -- these get a clickable Papéis chip. Lead/Opportunity
// render in their own "Funil" section instead, since an Opportunity can reach a
// Contact transitively through a Lead without ever being in Contact.links itself
// (see client/pipeline.py::get_pipeline_state).
const WA_CONTEXT_ROLE_DOCTYPES = ['Customer', 'Supplier', 'Employee'];
const WA_FUNNEL_DOCTYPES = ['Lead', 'Opportunity'];

// Must match takion_whatsapp.client.sandbox.SANDBOX_PHONE_NUMBER — used purely
// to recognize the sandbox conversation client-side (show/hide its banner),
// never to gate any permission (the whitelisted sandbox methods re-check
// System Manager + this same number server-side regardless of what the UI shows).
const SANDBOX_PHONE_NUMBER = '000000000000';

// Full Unicode emoji set (1914 emoji, 9 groups), vendored locally at
// public/js/lib/emoji-data.json — trimmed from muan/unicode-emoji-json
// (MIT), fetched lazily on first picker open, not embedded here. Plain
// UTF-8 text either way (no image assets), so any of these already
// send/render fine today via send_message with zero extra backend work.
// Distinct from stickers (WebP image messages, own catalog + send/receive
// pipeline — see client/stickers.py and the "Figurinhas" mode tab below).
const WA_EMOJI_CATEGORY_ICONS = ['😀', '👋', '🐶', '🍔', '✈️', '⚽', '💡', '🔣', '🚩'];

takion_whatsapp.WhatsAppInbox = class WhatsAppInbox {
	constructor(page) {
		this.page = page;
		this.current_conversation = null;
		this.filters = { status: [], tag: '', assigned_to: '', unread_only: false };
		this.is_system_manager = frappe.user.has_role('System Manager');

		// Audio: real waveforms per message bubble (destroyed/recreated on each
		// thread render), plus recording/preview state for the operator's own
		// voice notes. MAX_RECORDING_SECONDS keeps the converted OGG/Opus file
		// comfortably under the 512KB Meta uses to decide "native play icon" vs.
		// "generic file to download".
		this.waveforms = [];
		this.MAX_RECORDING_SECONDS = 120;
		// Meta's own limits (see WhatsApp Cloud API media reference) — checked
		// client-side too so a too-large file never even reaches upload_file.
		this.MEDIA_MAX_BYTES = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, document: 100 * 1024 * 1024, audio: 16 * 1024 * 1024 };
		this.record_wavesurfer = null;
		this.record_plugin = null;
		this.record_start = null;
		this.record_timer = null;
		this.preview_wavesurfer = null;
		this.recorded_blob = null;
		this._preview_url = null;
		this._recording_cancelled = false;

		// Search: in-conversation runs client-side over the already-loaded thread
		// (thread_messages) — no round trip needed since get_thread already loads
		// the whole history unpaginated. Global search hits the server instead,
		// since conversations that aren't open yet have no messages in the browser.
		this.thread_messages = [];
		this.thread_search_query = '';
		this.thread_search_matches = [];
		this.thread_search_index = -1;
		this.pending_jump_message = null;

		// This page never uses page actions and its own breadcrumb is already
		// hidden globally (see takion_theme/public/js/topbar.js, which mirrors
		// it into the top bar instead) -- the native .page-head row would
		// otherwise still reserve its fixed height for nothing, leaving a
		// blank strip above the inbox's own 3-pane layout.
		this.page.wrapper.find('.page-head').hide();

		this.inject_icons();
		this.inject_styles();
		this.make_layout();
		this.bind_events();
		this.setup_realtime();
		this.refresh_conversations();

		this.resize_layout();
		// Namespaced + only ever bound once per page instance (this class is
		// constructed once per session, same lifecycle as every other listener here).
		$(window).on('resize.wa-inbox-layout', () => this.resize_layout());
	}

	// Measures the real space available below the widget's own top offset instead
	// of guessing a fixed navbar/breadcrumb height — adapts to any zoom level,
	// window size, or Frappe chrome height instead of leaving (or running out of)
	// blank space below the compose bar.
	resize_layout() {
		const el = this.page.body.find('.whatsapp-inbox')[0];
		if (!el) return;
		const top = el.getBoundingClientRect().top;
		const height = Math.max(400, window.innerHeight - top - 20);
		el.style.height = height + 'px';
	}

	// Small line-icon set (Oracle-Cloud-inspired refinement pass, see
	// [[takion_design_reference_pipeline]]) replacing this page's emoji icons —
	// a single inline sprite so every icon() call below is just a 2-line <svg><use>,
	// no per-icon markup duplicated across the file.
	inject_icons() {
		if ($('#whatsapp-inbox-icons').length) return;
		$(`<svg id="whatsapp-inbox-icons" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
			<symbol id="wa-i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></symbol>
			<symbol id="wa-i-plus" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></symbol>
			<symbol id="wa-i-chevron-down" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></symbol>
			<symbol id="wa-i-paperclip" viewBox="0 0 24 24"><path d="M21 11.5 12.5 20a4.5 4.5 0 0 1-6.36-6.36l8.49-8.49a3 3 0 0 1 4.24 4.24l-8.13 8.13a1.5 1.5 0 0 1-2.12-2.12l6.72-6.72"/></symbol>
			<symbol id="wa-i-mic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></symbol>
			<symbol id="wa-i-send" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></symbol>
			<symbol id="wa-i-smile" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></symbol>
			<symbol id="wa-i-x" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></symbol>
			<symbol id="wa-i-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></symbol>
			<symbol id="wa-i-check-double" viewBox="0 0 24 24"><polyline points="18 6 8 16 3 11"/><polyline points="22 6 12.5 15.5 11 14"/></symbol>
			<symbol id="wa-i-play" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></symbol>
			<symbol id="wa-i-pause" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></symbol>
			<symbol id="wa-i-trash" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0-1 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 6"/></symbol>
			<symbol id="wa-i-stop" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></symbol>
			<symbol id="wa-i-users" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
			<symbol id="wa-i-user" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></symbol>
			<symbol id="wa-i-video" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></symbol>
			<symbol id="wa-i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><path d="M21 15l-5-5-4 4-3-3-6 6"/></symbol>
			<symbol id="wa-i-file" viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></symbol>
			<symbol id="wa-i-flask" viewBox="0 0 24 24"><path d="M9 2v6.5L4.2 17a2 2 0 0 0 1.8 3h12a2 2 0 0 0 1.8-3L15 8.5V2"/><line x1="7" y1="2" x2="17" y2="2"/><line x1="6" y1="15" x2="18" y2="15"/></symbol>
			<symbol id="wa-i-refresh" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></symbol>
		</defs></svg>`).appendTo('body');
	}

	icon(name, extra_class) {
		return `<svg class="wa-icon${extra_class ? ' ' + extra_class : ''}"><use href="#wa-i-${name}"></use></svg>`;
	}

	// Deterministic avatar background per contact/group name (no photo on file) —
	// small fixed palette so colors stay legible in both Frappe's light and dark
	// theme instead of a random/unbounded hue.
	avatar_color(name) {
		const palette = ['#B4703B', '#5B7A9E', '#3E8E63', '#8B4B4B', '#6B5B95', '#4A6FA5', '#9E7B3E', '#4B8B83'];
		let hash = 0;
		for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) % 997;
		return palette[hash % palette.length];
	}

	avatar_initial(name) {
		// Array.from (not charAt(0)) so a name starting with a surrogate-pair
		// character (an emoji) yields the whole glyph instead of a mangled half.
		return Array.from((name || '?').trim())[0].toUpperCase();
	}

	// All of this page's dropdowns (status filter, "Novo", attach, emoji) are
	// mutually exclusive -- opening one closes the others, since more than one
	// can visually overlap in the narrow conversations pane / compose bar.
	// `except` keeps one open (used right before re-toggling it).
	close_dropdowns(except) {
		const all = '.wa-status-filter-menu, .wa-new-menu, .wa-attach-menu, .wa-emoji-picker';
		this.page.body.find(all).not(except || '').removeClass('open');
	}

	inject_styles() {
		if ($('#whatsapp-inbox-styles').length) return;
		$(`<style id="whatsapp-inbox-styles">
			/* height: calc(100vh - 180px) fallback for the instant before JS measures the
			   real available space (resize_layout()) — 180px is only a guess at how tall
			   Frappe's own navbar/breadcrumb chrome is, and doesn't hold for every zoom
			   level/window size, leaving unused page background below the widget when it
			   overestimates. resize_layout() always overrides this with a real measurement. */
			/* Icons: a flat line-icon set (inject_icons()) replacing this page's emoji,
			   inline so size/color follow normal text rules (currentColor, 1em). */
			.wa-icon { width: 1em; height: 1em; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; vertical-align: -.15em; flex-shrink: 0; }
			@media (prefers-reduced-motion: reduce) {
				.whatsapp-inbox, .whatsapp-inbox * { transition: none !important; animation: none !important; }
			}
			.whatsapp-inbox { display: flex; height: calc(100vh - 180px); border: 1px solid var(--border-color); border-radius: var(--border-radius); overflow: hidden; }
			.wa-conversations { width: 300px; border-right: 1px solid var(--border-color); display: flex; flex-direction: column; overflow: hidden; }
			.wa-conversations-actions { padding: 8px; display: flex; gap: 6px; border-bottom: 1px solid var(--border-color); flex-wrap: wrap; }
			.wa-action-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
			.wa-action-btn .wa-icon, .wa-new-menu-toggle .wa-icon { width: 15px; height: 15px; }
			.wa-action-label { font-size: 13px; }
			/* "Nova conversa" is the one action used constantly -- primary button,
			   full width. Contato/Grupo are occasional -- tucked into a "Novo ▾"
			   dropdown instead of three equal-weight buttons in a row. */
			.wa-new-conversation { flex: 1; }
			.wa-new-menu-wrap, .wa-attach-menu-wrap { position: relative; }
			.wa-new-menu-toggle { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
			/* Generic dropdown-menu chrome, shared by "Novo" (conversations pane, opens
			   downward) and the attach menu (compose bar at the bottom of the screen,
			   opens upward) -- only position/transform-origin differ between the two. */
			.wa-new-menu, .wa-attach-menu {
				position: absolute; z-index: 15; min-width: 170px;
				background: var(--card-bg, #fff); border: 1px solid var(--border-color); border-radius: var(--border-radius);
				box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.15)); padding: 4px;
				opacity: 0; pointer-events: none;
				transition: opacity 150ms ease, transform 150ms ease;
			}
			.wa-new-menu { top: calc(100% + 6px); right: 0; transform-origin: top right; transform: translateY(-4px) scale(.98); }
			.wa-attach-menu { bottom: calc(100% + 6px); left: 0; transform-origin: bottom left; transform: translateY(4px) scale(.98); }
			.wa-new-menu.open, .wa-attach-menu.open { opacity: 1; transform: scale(1); pointer-events: auto; }
			.wa-new-menu-item, .wa-attach-menu-item {
				display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 4px; cursor: pointer; font-size: 13px;
				white-space: nowrap; transition: background 120ms ease;
			}
			.wa-new-menu-item:hover, .wa-attach-menu-item:hover { background: var(--fg-hover-color); }
			.wa-new-menu-item .wa-icon, .wa-attach-menu-item .wa-icon { color: var(--text-muted); }
			/* Sandbox is dev-only tooling, not a real inbox action -- deliberately
			   de-emphasized (own row, smaller) rather than given equal weight to
			   the primary/dropdown actions above. */
			.wa-action-btn-minor { width: 100%; display: flex; align-items: center; gap: 5px; padding: 3px; opacity: .7; justify-content: flex-start; }
			.wa-action-btn-minor .wa-icon { width: 13px; height: 13px; }
			.wa-conversations-filters { padding: 8px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--border-color); }
			.wa-filters-row { display: flex; gap: 4px; }
			.wa-filters-row > * { flex: 1; min-width: 0; }
			.wa-conversations-filters select, .wa-conversations-filters input { font-size: 12px; padding: 2px 4px; }
			.wa-unread-toggle { display: inline-flex; align-items: center; gap: 5px; transition: background 120ms ease, border-color 120ms ease, color 120ms ease; }
			.wa-unread-toggle .wa-unread-toggle-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
			.wa-unread-toggle.active { background: var(--tmr-active-bg, #E7EEFA); border-color: var(--tmr-accent, #2E5EAA); color: var(--tmr-accent, #2E5EAA); }
			.wa-conversations-list { flex: 1; overflow-y: auto; }
			.wa-conversation-item { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-bottom: 1px solid var(--border-color); cursor: pointer; transition: background 120ms ease; }
			.wa-conversation-item:hover { background: var(--fg-hover-color); }
			.wa-conversation-item.active { background: var(--fg-hover-color); }
			.wa-conversation-avatar {
				width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
				color: #fff; font-weight: 600; font-size: 13px;
			}
			.wa-conversation-avatar .wa-icon { width: 15px; height: 15px; }
			.wa-conversation-body { flex: 1; min-width: 0; }
			.wa-conversation-title { font-weight: 600; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
			.wa-conversation-title > span:first-child { display: flex; align-items: center; gap: 5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			/* Read conversations are visually quieter than unread ones -- same
			   convention as WhatsApp Web's own bold-until-opened list item, just in
			   neutral colors (see the standing no-WhatsApp-colors rule). */
			.wa-conversation-item:not(.unread) .wa-conversation-title,
			.wa-conversation-item:not(.unread) .wa-conversation-preview { font-weight: 400; color: var(--text-muted); }
			.wa-unread-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--tmr-accent, #2E5EAA); margin-left: 6px; flex-shrink: 0; }
			.wa-conversation-time { font-weight: 400; font-size: 11px; color: var(--text-muted); }
			.wa-conversation-preview { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.wa-conversation-meta { margin-top: 4px; display: flex; gap: 4px; align-items: center; }
			.wa-thread { flex: 1; display: flex; flex-direction: column; background: var(--subtle-fg); min-width: 0; position: relative; }
			/* Drag-and-drop overlay -- toggled via a counter (dragenter/dragleave fire
			   repeatedly as the cursor crosses child elements), see bind_events(). */
			.wa-thread-dragover::after {
				content: "Solte para anexar"; position: absolute; inset: 0; z-index: 20;
				display: flex; align-items: center; justify-content: center;
				background: color-mix(in srgb, var(--primary, #5b8def) 12%, transparent);
				border: 2px dashed var(--primary, #5b8def); pointer-events: none;
				font-size: 14px; font-weight: 600; color: var(--primary, #5b8def);
			}
			/* Header/compose are chrome, not canvas -- need their own surface color
			   (var(--card-bg)) so they read as elevated above .wa-thread's canvas
			   background instead of blending into it (both previously had no
			   background at all, just inheriting the canvas behind them). */
			.wa-thread-header { padding: 10px 14px; border-bottom: 1px solid var(--border-color); font-weight: 600; background: var(--card-bg, #fff); }
			.wa-thread-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 6px; }
			.wa-bubble-row { display: flex; }
			.wa-bubble-row.out { justify-content: flex-end; }
			/* Accent tokens (--tmr-accent/--tmr-active-bg) come from the module rail's
			   own palette (module_rail.js) -- reused here so the whole WhatsApp module
			   reads as one system instead of two independently-tuned blues. Same "no
			   WhatsApp brand colors" rule as ever: this is Takion's own accent, not Meta's. */
			.wa-bubble { max-width: 65%; padding: 6px 9px; border-radius: 8px; background: var(--card-bg, #fff); box-shadow: 0 1px 1px rgba(0,0,0,.08); }
			.wa-bubble-row.out .wa-bubble { background: var(--tmr-active-bg, #E7EEFA); }
			.wa-bubble-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; }
			.wa-bubble-time { text-align: right; font-size: 10px; color: var(--text-muted); margin-top: 2px; }
			.wa-bubble-time .wa-check { margin-left: 3px; display: inline-flex; }
			.wa-bubble-time .wa-check .wa-icon { width: 12px; height: 12px; }
			.wa-bubble-sender { font-size: 11px; font-weight: 600; color: var(--tmr-accent, #2E5EAA); margin-bottom: 2px; }
			.wa-check-read { color: var(--tmr-accent, #2E5EAA); }
			.wa-audio-bubble { display: flex; align-items: center; gap: 8px; min-width: 220px; }
			.wa-audio-play { width: 30px; height: 30px; border-radius: 50%; background: var(--gray-500); color: #fff; border: none; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
			.wa-audio-play .wa-icon { width: 13px; height: 13px; }
			.wa-audio-wave { flex: 1; height: 24px; }
			.wa-audio-duration { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
			.wa-thread-compose { padding: 10px; border-top: 1px solid var(--border-color); background: var(--card-bg, #fff); }
			.wa-compose-row { display: flex; align-items: center; gap: 8px; }
			/* Frappe's default textarea.form-control ships a fixed height:120px (meant
			   for full-page forms) — overridden here explicitly, then JS drives the
			   real height per keystroke so it hugs content like WhatsApp's own compose
			   box instead of always rendering at that fixed size. */
			.wa-compose-text-row { align-items: flex-end; }
			.wa-compose-text-row textarea {
				flex: 1; resize: none; overflow-y: auto;
				height: 34px; min-height: 34px; max-height: 120px; line-height: 1.4;
				padding-top: 6px; padding-bottom: 6px;
			}
			.wa-compose-mic, .wa-compose-send, .wa-compose-attach, .wa-compose-emoji, .wa-record-cancel, .wa-record-stop,
			.wa-preview-play, .wa-preview-cancel, .wa-preview-send,
			.wa-media-cancel, .wa-media-send {
				width: 34px; height: 34px; padding: 0; flex-shrink: 0;
				display: flex; align-items: center; justify-content: center;
				border-radius: 50%; line-height: 1;
				transition: background 120ms ease, transform 120ms ease;
			}
			.wa-compose-mic:hover, .wa-compose-attach:hover, .wa-compose-emoji:hover,
			.wa-preview-play:hover, .wa-media-cancel:hover, .wa-record-cancel:hover { background: var(--fg-hover-color); }
			.wa-compose-send:active, .wa-preview-send:active, .wa-media-send:active, .wa-record-stop:active { transform: scale(.92); }
			.wa-media-preview { flex-shrink: 0; }
			.wa-media-preview img, .wa-media-preview video { max-height: 40px; max-width: 60px; border-radius: 4px; display: block; }
			.wa-media-preview span { font-size: 12px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
			.wa-compose-media-row .wa-media-caption { flex: 1; }
			.wa-record-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--red-500, #e03131); flex-shrink: 0; animation: wa-record-pulse 1.2s infinite; }
			@keyframes wa-record-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
			.wa-record-timer, .wa-preview-duration { font-size: 12px; color: var(--text-muted); flex-shrink: 0; min-width: 34px; }
			.wa-record-wave, .wa-preview-wave { flex: 1; height: 34px; }
			.wa-optimistic-audio .wa-bubble-text { font-style: italic; }
			/* Collapsed by default -- opened by clicking the contact chip in the thread
			   header, closed via its own × button, same interaction as WhatsApp Web's
			   "Dados do contato" panel (a real column, not an overlay: .wa-thread's
			   flex:1 already reclaims the width the instant this closes). Width/padding/
			   opacity transition (toggled via the .open class, not display:none/jQuery
			   .toggle()) so opening/closing is an animated slide, not an instant cut. */
			.wa-contact-panel {
				display: flex; flex-direction: column; flex-shrink: 0; width: 0; padding: 0; opacity: 0;
				overflow: hidden; border-left: 1px solid transparent;
				transition: width 220ms ease, padding 220ms ease, opacity 180ms ease, border-color 220ms ease;
			}
			.wa-contact-panel.open { width: 300px; padding: 14px; opacity: 1; border-left-color: var(--border-color); overflow-y: auto; }
			.wa-contact-panel > * { min-width: 272px; }
			.wa-contact-panel h5 { margin-bottom: 2px; }
			.wa-contact-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
			.wa-contact-panel-header h5 { margin: 0; }
			.wa-contact-panel-close {
				cursor: pointer; color: var(--text-muted); width: 26px; height: 26px; border-radius: 50%;
				display: flex; align-items: center; justify-content: center; transition: background 120ms ease, color 120ms ease;
			}
			.wa-contact-panel-close:hover { color: var(--text-color); background: var(--fg-hover-color); }
			.wa-contact-profile { display: flex; flex-direction: column; align-items: center; text-align: center; margin-bottom: 14px; }
			.wa-contact-profile .wa-thread-avatar { width: 56px; height: 56px; font-size: 19px; margin-bottom: 8px; }
			.wa-thread-title {
				cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 4px 6px; margin: -4px -6px;
				border-radius: var(--border-radius); transition: background 120ms ease;
			}
			.wa-thread-title:hover { background: var(--fg-hover-color); }
			.wa-thread-avatar {
				width: 32px; height: 32px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
				background: var(--gray-500, #888); color: #fff; display: flex; align-items: center;
				justify-content: center; font-size: 14px; font-weight: 600;
			}
			.wa-thread-avatar .wa-icon { width: 16px; height: 16px; }
			.wa-thread-avatar img { width: 100%; height: 100%; object-fit: cover; }
			.wa-media-gallery { display: grid; gap: 4px; margin-top: 6px; }
			/* Fixed 4-column preview (one row, "no máximo 3 ou 4 numa fileira") vs. the
			   full browser's grid, which reflows via auto-fill so it never looks
			   cramped/stretched regardless of the panel's actual width. */
			.wa-media-gallery-preview { grid-template-columns: repeat(4, 1fr); }
			.wa-media-gallery-full { grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); margin-top: 10px; }
			.wa-media-thumb {
				aspect-ratio: 1; border-radius: 4px; overflow: hidden; background: var(--bg-color);
				display: flex; align-items: center; justify-content: center; font-size: 20px; cursor: pointer;
			}
			.wa-media-thumb img { width: 100%; height: 100%; object-fit: cover; }
			.wa-media-section-toggle { cursor: pointer; }
			.wa-media-section-toggle:hover label { text-decoration: underline; }
			.wa-media-browser-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
			.wa-media-browser-header h5 { margin: 0; font-size: 14px; }
			.wa-media-browser-back { cursor: pointer; font-size: 16px; }
			.wa-media-tabs { display: flex; border-bottom: 1px solid var(--border-color); margin-bottom: 4px; }
			.wa-media-tab {
				flex: 1; text-align: center; padding: 6px 0; cursor: pointer; font-size: 12px;
				color: var(--text-muted); border-bottom: 2px solid transparent;
				transition: color 150ms ease, border-color 150ms ease;
			}
			.wa-media-tab.active { color: var(--text-color); border-bottom-color: var(--primary, #5b8def); font-weight: 600; }
			.wa-media-link-item { display: block; padding: 8px 2px; border-bottom: 1px solid var(--border-color); font-size: 12px; }
			.wa-media-link-text { word-break: break-word; }
			.wa-media-link-date { color: var(--text-muted); font-size: 11px; margin-top: 2px; }
			.wa-contact-field { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
			/* Status/SLA badges: Frappe core's own .indicator-pill renders as plain
			   colored text + a small dot (background: var(--bg-{color}) only fills in
			   on desk themes that define that token -- this one doesn't), which reads
			   as "not styled" next to the rest of this refinement pass. Solid-fill
			   pills here instead, same Frappe-var-with-hex-fallback convention as
			   every other color in this file, not a hardcoded final palette. */
			.wa-conversation-meta .indicator-pill, .wa-contact-panel .indicator-pill {
				font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: .3px;
				padding: 2.5px 8px; border-radius: var(--border-radius-full, 999px); height: auto;
			}
			.wa-conversation-meta .indicator-pill::before, .wa-contact-panel .indicator-pill::before { display: none; }
			.wa-conversation-meta .indicator-pill.blue, .wa-contact-panel .indicator-pill.blue { background: var(--bg-blue, var(--blue-100, #d3e8fb)); color: var(--text-on-blue, var(--blue-700, #1a5490)); }
			.wa-conversation-meta .indicator-pill.orange, .wa-contact-panel .indicator-pill.orange { background: var(--bg-orange, #fceedc); color: var(--text-on-orange, #95590b); }
			.wa-conversation-meta .indicator-pill.yellow, .wa-contact-panel .indicator-pill.yellow { background: var(--bg-yellow, #fbf3d9); color: var(--text-on-yellow, #8a6d06); }
			.wa-conversation-meta .indicator-pill.green, .wa-contact-panel .indicator-pill.green { background: var(--bg-green, var(--green-100, #cdf7d8)); color: var(--text-on-green, var(--green-700, #1e7b45)); }
			.wa-conversation-meta .indicator-pill.gray, .wa-conversation-meta .indicator-pill.grey,
			.wa-contact-panel .indicator-pill.gray, .wa-contact-panel .indicator-pill.grey { background: var(--bg-gray, var(--gray-100, #eee)); color: var(--text-on-gray, var(--gray-700, #5b6472)); }
			.wa-conversation-meta .indicator-pill.red, .wa-contact-panel .indicator-pill.red { background: var(--bg-red, #fbeaea); color: var(--text-on-red, #b42318); }
			.wa-tag-chip, .wa-assign-chip, .wa-role-chip { display: inline-flex; align-items: center; background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 10px; padding: 1px 8px; font-size: 11px; margin: 2px 4px 2px 0; }
			.wa-tag-chip .remove, .wa-assign-chip .remove { cursor: pointer; margin-left: 5px; color: var(--text-muted); }
			.wa-role-add { cursor: pointer; font-weight: 600; }
			.wa-empty-state { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); }
			.wa-role-picker-results { max-height: 220px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: var(--border-radius); margin-top: 8px; }
			.wa-role-picker-result { padding: 6px 10px; cursor: pointer; border-bottom: 1px solid var(--border-color); }
			.wa-role-picker-result:hover { background: var(--fg-hover-color); }
			.wa-role-picker-result:last-child { border-bottom: none; }
			.wa-role-picker-empty { padding: 8px 10px; color: var(--text-muted); font-size: 12px; }
			.wa-role-context-toggle { cursor: pointer; }
			.wa-role-context-toggle.active { background: var(--fg-hover-color); }
			.wa-role-context-body { font-size: 12px; margin-top: 6px; padding: 6px 8px; border: 1px solid var(--border-color); border-radius: var(--border-radius); }
			.wa-funnel-chip { display: block; width: fit-content; max-width: 100%; white-space: normal; margin-bottom: 4px; }
			.wa-funnel-chip a { color: inherit; }
			.wa-conversations-search { padding: 8px 8px 0; }
			.wa-search-field {
				display: flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 15px;
				background: var(--bg-color); border: 1px solid var(--border-color); color: var(--text-muted);
				transition: border-color 120ms ease;
			}
			.wa-search-field:hover, .wa-search-field:focus-within { border-color: var(--gray-500, #888); }
			.wa-search-field .wa-icon { flex-shrink: 0; }
			.wa-search-field input { border: none !important; background: transparent !important; box-shadow: none !important; padding-left: 0 !important; }
			.wa-search-group { border-bottom: 1px solid var(--border-color); padding: 6px 0; }
			.wa-search-group-title { font-weight: 600; font-size: 12px; padding: 4px 12px; }
			.wa-search-result { padding: 4px 12px; font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.wa-search-result:hover { background: var(--fg-hover-color); }
			.wa-search-match { background: var(--yellow-200, #fff3b0); border-radius: 2px; }
			.wa-active-match-row .wa-bubble { outline: 2px solid var(--orange-400, #ff9f43); }
			.wa-thread-header-top { display: flex; justify-content: space-between; align-items: center; }
			.wa-bubble-img { cursor: zoom-in; }
			.wa-bubble-sticker-wrap { background: transparent !important; box-shadow: none !important; padding: 0 !important; }
			.wa-bubble-sticker { width: 128px; height: 128px; display: block; }
			.wa-lightbox-overlay {
				position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 1100;
				display: flex; align-items: center; justify-content: center; cursor: zoom-out;
			}
			.wa-lightbox-overlay img { max-width: 90vw; max-height: 90vh; border-radius: 4px; box-shadow: 0 4px 24px rgba(0,0,0,.5); }
			.wa-sandbox-banner { background: var(--yellow-100, #fff9db); border-bottom: 1px solid var(--border-color); padding: 6px 10px; font-size: 12px; }
			.wa-sandbox-banner button { margin-left: 6px; }
			.wa-emoji-picker-wrap { position: relative; }
			.wa-emoji-picker {
				/* Anchored by its RIGHT edge (opens leftward), not left — the emoji
				   button sits near the right side of the compose row, so a left-anchored
				   260px-wide picker ran off the right edge of the screen entirely. */
				position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 10;
				background: var(--card-bg, #fff); border: 1px solid var(--border-color);
				border-radius: var(--border-radius); width: 260px; max-height: 260px;
				box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.15));
				display: flex; flex-direction: column; overflow: hidden;
				opacity: 0; transform: translateY(4px) scale(.98); pointer-events: none; transform-origin: bottom right;
				transition: opacity 150ms ease, transform 150ms ease;
			}
			.wa-emoji-picker.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
			.wa-picker-mode-tabs { display: flex; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
			.wa-picker-mode-tab { flex: 1; text-align: center; cursor: pointer; padding: 6px 0; font-size: 15px; border-bottom: 2px solid transparent; transition: background 120ms ease; }
			.wa-picker-mode-tab:hover { background: var(--fg-hover-color); }
			.wa-picker-mode-tab.active { border-bottom-color: var(--primary, #5b8def); }
			.wa-picker-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
			.wa-emoji-tabs { display: flex; border-bottom: 1px solid var(--border-color); padding: 4px; flex-shrink: 0; }
			.wa-emoji-tab { flex: 1; text-align: center; cursor: pointer; padding: 4px 0; border-radius: 4px; font-size: 15px; transition: background 120ms ease; }
			.wa-emoji-tab:hover { background: var(--fg-hover-color); }
			.wa-emoji-tab.active { background: var(--fg-hover-color); }
			.wa-emoji-grid { flex: 1; overflow-y: auto; padding: 6px; display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; align-content: start; }
			.wa-emoji-option { cursor: pointer; text-align: center; padding: 3px; border-radius: 4px; font-size: 16px; line-height: 1.4; }
			.wa-emoji-option:hover { background: var(--fg-hover-color); }
			.wa-emoji-loading { padding: 10px; font-size: 12px; color: var(--text-muted); }
			.wa-sticker-grid { flex: 1; overflow-y: auto; padding: 6px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; align-content: start; }
			.wa-sticker-option { width: 100%; aspect-ratio: 1; cursor: pointer; border-radius: 4px; transition: background 120ms ease; }
			.wa-sticker-option:hover { background: var(--fg-hover-color); }
			.wa-status-filter { position: relative; }
			.wa-status-filter-toggle { white-space: nowrap; }
			.wa-status-filter-menu {
				position: absolute; top: 100%; left: 0; z-index: 10; margin-top: 2px;
				background: var(--card-bg, #fff); border: 1px solid var(--border-color);
				border-radius: var(--border-radius); padding: 4px 0; min-width: 170px;
				box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.15));
				opacity: 0; transform: translateY(-4px) scale(.98); pointer-events: none; transform-origin: top left;
				transition: opacity 150ms ease, transform 150ms ease;
			}
			.wa-status-filter-menu.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
			.wa-status-filter-option { display: block; padding: 4px 10px; margin: 0; font-size: 12px; font-weight: normal; cursor: pointer; white-space: nowrap; }
			.wa-status-filter-option:hover { background: var(--fg-hover-color); }
			.wa-status-filter-option input { margin-right: 6px; }
			.wa-thread-search-bar { display: flex; align-items: center; gap: 6px; padding-top: 6px; }
			.wa-thread-search-bar input { flex: 1; font-size: 12px; padding: 2px 6px; }
			.wa-thread-search-counter { font-size: 11px; color: var(--text-muted); min-width: 34px; text-align: center; }
		</style>`).appendTo('head');
	}

	make_layout() {
		this.page.body.html(`
			<div class="whatsapp-inbox">
				<div class="wa-conversations">
					<div class="wa-conversations-search">
						<div class="wa-search-field">
							${this.icon('search')}
							<input class="form-control form-control-sm wa-global-search-input" placeholder="Buscar em todas as conversas">
						</div>
					</div>
					<div class="wa-conversations-actions">
						<button class="btn btn-default btn-primary wa-action-btn wa-new-conversation" title="Nova Conversa">
							${this.icon('plus')}<span class="wa-action-label">Nova conversa</span>
						</button>
						<div class="wa-new-menu-wrap">
							<button class="btn btn-default wa-new-menu-toggle" title="Mais opções">Novo${this.icon('chevron-down')}</button>
							<div class="wa-new-menu">
								<div class="wa-new-menu-item wa-new-contact">${this.icon('user')}Novo contato</div>
								<div class="wa-new-menu-item wa-new-group">${this.icon('users')}Novo grupo</div>
							</div>
						</div>
					</div>
					${this.is_system_manager ? `
						<div style="padding:0 8px 8px;border-bottom:1px solid var(--border-color);">
							<button class="btn btn-default wa-action-btn wa-action-btn-minor wa-open-sandbox" title="Conversa de teste, sem depender do número real da Meta">
								${this.icon('flask')}<span class="wa-action-label">Sandbox</span>
							</button>
						</div>
					` : ''}
					<div class="wa-conversations-filters">
						<div class="wa-filters-row">
							<div class="wa-status-filter">
								<button type="button" class="btn btn-default btn-sm wa-status-filter-toggle">Status: Todos</button>
								<div class="wa-status-filter-menu">
									<label class="wa-status-filter-option"><input type="checkbox" value="Novo"> Novo</label>
									<label class="wa-status-filter-option"><input type="checkbox" value="Em andamento"> Em andamento</label>
									<label class="wa-status-filter-option"><input type="checkbox" value="Aguardando cliente"> Aguardando cliente</label>
									<label class="wa-status-filter-option"><input type="checkbox" value="Resolvido"> Resolvido</label>
								</div>
							</div>
							<button type="button" class="btn btn-default btn-sm wa-unread-toggle" title="Mostrar só não lidas"><span class="wa-unread-toggle-dot"></span>Não lidas</button>
						</div>
						<div class="wa-filters-row">
							<input class="form-control form-control-sm wa-filter-tag" placeholder="Tag">
							<input class="form-control form-control-sm wa-filter-agent" placeholder="Agente">
						</div>
					</div>
					<div class="wa-conversations-list"></div>
				</div>
				<div class="wa-thread">
					<div class="wa-thread-header">
						<div class="wa-thread-header-top">
							<span class="wa-thread-title"><span class="wa-empty-state" style="height:auto;">Selecione uma conversa</span></span>
							<button class="btn btn-default btn-xs wa-thread-search-toggle" style="display:none;" title="Buscar nesta conversa">${this.icon('search')}</button>
						</div>
						<div class="wa-thread-search-bar" style="display:none;">
							<input class="form-control form-control-sm wa-thread-search-input" placeholder="Buscar nesta conversa">
							<span class="wa-thread-search-counter">0/0</span>
							<button class="btn btn-default btn-xs wa-thread-search-prev" title="Anterior">↑</button>
							<button class="btn btn-default btn-xs wa-thread-search-next" title="Próxima">↓</button>
							<button class="btn btn-default btn-xs wa-thread-search-close" title="Fechar">${this.icon('x')}</button>
						</div>
						<div class="wa-sandbox-banner" style="display:none;">
							${this.icon('flask')} Conversa de sandbox — envio real (texto/áudio/imagem/vídeo/documento) só
							funciona depois de configurar uma WhatsApp Account real (aguardando número
							de teste da Meta).
							${this.is_system_manager ? `
								<button class="btn btn-default btn-xs wa-sandbox-simulate">Simular recebimento</button>
								<button class="btn btn-default btn-xs wa-sandbox-clear">Limpar mensagens de teste</button>
								<button class="btn btn-default btn-xs wa-sandbox-group">${this.icon('flask')} Testar Grupo</button>
							` : ''}
						</div>
					</div>
					<div class="wa-thread-messages"></div>
					<div class="wa-thread-compose" style="display:none;">
						<div class="wa-compose-row wa-compose-text-row">
							<div class="wa-emoji-picker-wrap">
								<button class="btn btn-default btn-sm wa-compose-emoji" title="Emoji">${this.icon('smile')}</button>
								<div class="wa-emoji-picker"></div>
							</div>
							<div class="wa-attach-menu-wrap">
								<button class="btn btn-default btn-sm wa-compose-attach" title="Anexar">${this.icon('paperclip')}</button>
								<div class="wa-attach-menu">
									<div class="wa-attach-menu-item" data-accept="">${this.icon('file')}Documento</div>
									<div class="wa-attach-menu-item" data-accept="image/*,video/*">${this.icon('image')}Foto e vídeo</div>
									<div class="wa-attach-menu-item" data-accept="audio/*">${this.icon('mic')}Áudio</div>
								</div>
							</div>
							<input type="file" class="wa-media-file-input" style="display:none;">
							<textarea class="form-control wa-compose-input" rows="1" placeholder="Digite uma mensagem"></textarea>
							<button class="btn btn-default btn-sm wa-compose-mic" title="Gravar áudio">${this.icon('mic')}</button>
							<button class="btn btn-primary btn-sm wa-compose-send" style="display:none;" title="Enviar">${this.icon('send')}</button>
						</div>
						<div class="wa-compose-row wa-compose-record-row" style="display:none;">
							<span class="wa-record-dot"></span>
							<span class="wa-record-timer">0:00</span>
							<div class="wa-record-wave"></div>
							<button class="btn btn-default btn-sm wa-record-cancel" title="Cancelar gravação">${this.icon('trash')}</button>
							<button class="btn btn-primary btn-sm wa-record-stop" title="Parar gravação">${this.icon('stop')}</button>
						</div>
						<div class="wa-compose-row wa-compose-preview-row" style="display:none;">
							<button class="btn btn-default btn-sm wa-preview-play" title="Ouvir">${this.icon('play')}</button>
							<div class="wa-preview-wave"></div>
							<span class="wa-preview-duration">0:00</span>
							<button class="btn btn-default btn-sm wa-preview-cancel" title="Descartar">${this.icon('trash')}</button>
							<button class="btn btn-primary btn-sm wa-preview-send" title="Enviar áudio">${this.icon('send')}</button>
						</div>
						<div class="wa-compose-row wa-compose-media-row" style="display:none;">
							<div class="wa-media-preview"></div>
							<input class="form-control form-control-sm wa-media-caption" placeholder="Legenda (opcional)">
							<button class="btn btn-default btn-sm wa-media-cancel" title="Descartar">${this.icon('trash')}</button>
							<button class="btn btn-primary btn-sm wa-media-send" title="Enviar">${this.icon('send')}</button>
						</div>
					</div>
				</div>
				<div class="wa-contact-panel">
					<div class="wa-contact-panel-header">
						<h5>Dados do contato</h5>
						<span class="wa-contact-panel-close" title="Fechar">${this.icon('x')}</span>
					</div>
					<div class="wa-contact-panel-body"><div class="wa-empty-state">Nenhum contato selecionado</div></div>
				</div>
			</div>
		`);
	}

	bind_events() {
		const main = this.page.body;

		main.on('click', '.wa-status-filter-toggle', (e) => {
			e.stopPropagation();
			const $menu = this.page.body.find('.wa-status-filter-menu');
			const was_open = $menu.hasClass('open');
			this.close_dropdowns();
			$menu.toggleClass('open', !was_open);
		});
		main.on('click', '.wa-status-filter-menu', (e) => e.stopPropagation());
		main.on('change', '.wa-status-filter-menu input[type="checkbox"]', () => {
			this.filters.status = this.page.body
				.find('.wa-status-filter-menu input[type="checkbox"]:checked')
				.map((_, el) => el.value)
				.get();
			this.update_status_filter_label();
			this.refresh_conversations();
		});
		main.on('click', '.wa-unread-toggle', (e) => {
			this.filters.unread_only = !this.filters.unread_only;
			$(e.currentTarget).toggleClass('active', this.filters.unread_only);
			this.refresh_conversations();
		});
		main.on('click', '.wa-new-menu-toggle', (e) => {
			e.stopPropagation();
			const $menu = this.page.body.find('.wa-new-menu');
			const was_open = $menu.hasClass('open');
			this.close_dropdowns();
			$menu.toggleClass('open', !was_open);
		});
		main.on('click', '.wa-new-menu', (e) => e.stopPropagation());
		// Menu items reuse the same .wa-new-contact/.wa-new-group classes the old
		// standalone buttons had -- their click handlers further below don't change.
		main.on('click', '.wa-new-menu-item', () => this.close_dropdowns());
		main.on('click', '.wa-compose-attach', (e) => {
			e.stopPropagation();
			const $menu = this.page.body.find('.wa-attach-menu');
			const was_open = $menu.hasClass('open');
			this.close_dropdowns();
			$menu.toggleClass('open', !was_open);
		});
		main.on('click', '.wa-attach-menu', (e) => e.stopPropagation());
		main.on('click', '.wa-attach-menu-item', (e) => {
			this.page.body.find('.wa-media-file-input').attr('accept', $(e.currentTarget).data('accept') || '');
			this.close_dropdowns();
			this.page.body.find('.wa-media-file-input').trigger('click');
		});
		main.on('click', '.wa-compose-emoji', (e) => {
			e.stopPropagation();
			const $picker = this.page.body.find('.wa-emoji-picker');
			const was_open = $picker.hasClass('open');
			this.close_dropdowns();
			if (!was_open) this.toggle_emoji_picker();
		});
		main.on('click', '.wa-emoji-picker', (e) => e.stopPropagation());
		main.on('click', '.wa-picker-mode-tab', (e) => this.set_picker_mode($(e.currentTarget).data('mode')));
		main.on('click', '.wa-emoji-tab', (e) => this.render_emoji_picker(+$(e.currentTarget).data('index')));
		main.on('click', '.wa-emoji-option', (e) => this.insert_emoji_at_cursor($(e.currentTarget).text()));
		main.on('click', '.wa-sticker-option', (e) => this.send_sticker($(e.currentTarget).data('sticker')));
		// Closes any open dropdown (status filter, "Novo"/attach menu, emoji picker)
		// on a click outside it — namespaced since this page instance is created
		// once per session and never torn down (same as every other listener here).
		$(document).on('click.wa-dropdowns', () => this.close_dropdowns());
		main.on('input', '.wa-filter-tag', frappe.utils.debounce((e) => {
			this.filters.tag = e.target.value;
			this.refresh_conversations();
		}, 300));
		main.on('input', '.wa-filter-agent', frappe.utils.debounce((e) => {
			this.filters.assigned_to = e.target.value;
			this.refresh_conversations();
		}, 300));

		main.on('click', '.wa-conversation-item', (e) => {
			this.open_conversation($(e.currentTarget).data('name'));
		});

		main.on('click', '.wa-new-contact', () => this.open_new_contact_dialog());
		main.on('click', '.wa-new-conversation', () => this.open_new_conversation_dialog());
		main.on('click', '.wa-new-group', () => this.open_new_group_dialog());
		main.on('click', '.wa-group-refresh', () => this.refresh_group_panel());
		main.on('click', '.wa-group-edit', () => this.open_edit_group_dialog());
		main.on('click', '.wa-group-invite-copy', () => this.copy_group_invite_link());
		main.on('click', '.wa-group-invite-reset', () => this.reset_group_invite_link());
		main.on('click', '.wa-group-participant-remove', (e) => this.remove_group_participant($(e.currentTarget).data('wa-id')));
		main.on('click', '.wa-group-join-approve', (e) => this.resolve_group_join_request($(e.currentTarget).data('id'), true));
		main.on('click', '.wa-group-join-reject', (e) => this.resolve_group_join_request($(e.currentTarget).data('id'), false));
		main.on('click', '.wa-bubble-img', (e) => {
			e.stopPropagation(); // a gallery thumb inside .wa-media-section-toggle must only zoom, not also open the full browser
			this.open_image_lightbox(e.currentTarget.src);
		});
		// Video/document preview thumbs are plain links (open in a new tab) — same
		// stopPropagation reasoning as .wa-bubble-img above, just without a lightbox.
		main.on('click', '.wa-media-thumb', (e) => e.stopPropagation());
		main.on('click', '.wa-open-sandbox', () => this.open_sandbox());
		main.on('click', '.wa-sandbox-simulate', () => this.open_simulate_incoming_dialog());
		main.on('click', '.wa-sandbox-clear', () => this.clear_sandbox_messages());
		main.on('click', '.wa-sandbox-group', () => this.open_group_sandbox_dialog());

		main.on('input', '.wa-global-search-input', frappe.utils.debounce((e) => {
			this.run_global_search(e.target.value.trim());
		}, 300));
		main.on('click', '.wa-search-result', (e) => {
			const $row = $(e.currentTarget);
			this.page.body.find('.wa-global-search-input').val('');
			this.page.body.find('.wa-conversations-filters').show();
			this.refresh_conversations();
			this.open_conversation($row.data('conversation'), $row.data('message'));
		});

		main.on('click', '.wa-thread-search-toggle', () => this.toggle_thread_search());
		main.on('click', '.wa-thread-title', () => this.toggle_contact_panel());
		main.on('click', '.wa-contact-panel-close', () => this.toggle_contact_panel(false));
		main.on('click', '.wa-media-section-toggle', () => this.open_media_gallery_view());
		main.on('click', '.wa-media-browser-back', () => this.load_contact_panel(this.current_conversation));
		main.on('click', '.wa-media-tab', (e) => this.render_media_gallery_view($(e.currentTarget).data('tab')));
		main.on('click', '.wa-thread-search-close', () => this.toggle_thread_search());
		main.on('input', '.wa-thread-search-input', frappe.utils.debounce((e) => {
			this.thread_search_query = e.target.value.trim();
			this.render_thread(this.thread_messages);
		}, 200));
		main.on('click', '.wa-thread-search-prev', () => this.thread_search_step(-1));
		main.on('click', '.wa-thread-search-next', () => this.thread_search_step(1));
		main.on('keydown', '.wa-thread-search-input', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.thread_search_step(e.shiftKey ? -1 : 1);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.toggle_thread_search();
			}
		});

		main.on('click', '.wa-compose-send', () => this.send_message());
		main.on('keydown', '.wa-compose-input', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.send_message();
			}
		});
		main.on('input', '.wa-compose-input', (e) => {
			this.update_compose_buttons();
			this.autosize_compose_input(e.currentTarget);
		});

		main.on('click', '.wa-compose-mic', () => this.start_recording());
		main.on('click', '.wa-record-cancel', () => this.cancel_recording());
		main.on('click', '.wa-record-stop', () => this.stop_recording());
		main.on('click', '.wa-preview-play', () => this.toggle_preview_playback());
		main.on('click', '.wa-preview-cancel', () => this.discard_recording());
		main.on('click', '.wa-preview-send', () => this.send_recorded_audio());

		main.on('change', '.wa-media-file-input', (e) => this.on_media_file_selected(e.target.files[0]));
		main.on('click', '.wa-media-cancel', () => this.discard_media());
		main.on('click', '.wa-media-send', () => this.send_media());
		main.on('keydown', '.wa-media-caption', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.send_media();
			}
		});

		// Pasting an image (or any file) copied to the clipboard -- e.g. a
		// screenshot -- goes through the same on_media_file_selected() the
		// attach-menu file input uses, so it gets the same preview/caption/size-cap
		// handling. Only intercepted when the clipboard actually carries a file;
		// a plain text paste falls through untouched.
		main.on('paste', '.wa-compose-input', (e) => {
			const clipboard = e.originalEvent.clipboardData;
			const item = clipboard && Array.from(clipboard.items).find((i) => i.kind === 'file');
			if (!item) return;
			e.preventDefault();
			this.on_media_file_selected(item.getAsFile());
		});

		// Drag-and-drop over the whole thread panel (messages + compose), not just
		// the compose bar, since that's the bigger and more discoverable target --
		// same as WhatsApp Web itself. dragenter/dragleave fire repeatedly as the
		// cursor crosses child elements, so a counter (rather than a plain
		// enter/leave toggle) is needed to avoid the overlay flickering.
		main.on('dragenter', '.wa-thread', (e) => {
			if (!this.current_conversation) return;
			e.preventDefault();
			this._drag_counter = (this._drag_counter || 0) + 1;
			this.page.body.find('.wa-thread').addClass('wa-thread-dragover');
		});
		main.on('dragover', '.wa-thread', (e) => {
			if (!this.current_conversation) return;
			e.preventDefault();
			e.originalEvent.dataTransfer.dropEffect = 'copy';
		});
		main.on('dragleave', '.wa-thread', (e) => {
			e.preventDefault();
			this._drag_counter = Math.max(0, (this._drag_counter || 0) - 1);
			if (this._drag_counter === 0) this.page.body.find('.wa-thread').removeClass('wa-thread-dragover');
		});
		main.on('drop', '.wa-thread', (e) => {
			e.preventDefault();
			this._drag_counter = 0;
			this.page.body.find('.wa-thread').removeClass('wa-thread-dragover');
			if (!this.current_conversation) return;
			const file = e.originalEvent.dataTransfer.files[0];
			if (file) this.on_media_file_selected(file);
		});

		main.on('change', '.wa-status-select', (e) => {
			frappe.db.set_value('WhatsApp Conversation', this.current_conversation, 'status', e.target.value)
				.then(() => this.refresh_conversations());
		});

		main.on('keydown', '.wa-tag-input', (e) => {
			if (e.key === 'Enter' && e.target.value.trim()) {
				e.preventDefault();
				frappe.call({
					method: 'frappe.desk.doctype.tag.tag.add_tag',
					args: { tag: e.target.value.trim(), dt: 'WhatsApp Conversation', dn: this.current_conversation },
				}).then(() => {
					e.target.value = '';
					this.open_conversation(this.current_conversation);
					this.refresh_conversations();
				});
			}
		});
		main.on('click', '.wa-tag-chip .remove', (e) => {
			frappe.call({
				method: 'frappe.desk.doctype.tag.tag.remove_tag',
				args: { tag: $(e.currentTarget).data('tag'), dt: 'WhatsApp Conversation', dn: this.current_conversation },
			}).then(() => {
				this.open_conversation(this.current_conversation);
				this.refresh_conversations();
			});
		});

		main.on('keydown', '.wa-assign-input', (e) => {
			if (e.key === 'Enter' && e.target.value.trim()) {
				e.preventDefault();
				const user = e.target.value.trim();
				frappe.call({
					method: 'frappe.desk.form.assign_to.add',
					args: { args: { assign_to: [user], doctype: 'WhatsApp Conversation', name: this.current_conversation } },
				}).then(() => {
					e.target.value = '';
					this.open_conversation(this.current_conversation);
					this.refresh_conversations();
				});
			}
		});
		main.on('click', '.wa-assign-chip .remove', (e) => {
			frappe.call({
				method: 'frappe.desk.form.assign_to.remove',
				args: { doctype: 'WhatsApp Conversation', name: this.current_conversation, assign_to: $(e.currentTarget).data('user') },
			}).then(() => {
				this.open_conversation(this.current_conversation);
				this.refresh_conversations();
			});
		});

		main.on('click', '.wa-role-add', (e) => {
			const contact = $(e.currentTarget).data('contact');
			const conversation = this.current_conversation;
			frappe.db.get_value('WhatsApp Conversation', conversation, 'wa_id').then((r) => {
				this.open_role_picker(contact, () => this.load_contact_panel(conversation), r.message.wa_id);
			});
		});

		// Per-role context summary (Entrega 7, item 5.2): lazy-loaded on first
		// click, toggled off on a second click on the same chip.
		main.on('click', '.wa-role-context-toggle', (e) => this.toggle_role_context($(e.currentTarget)));

		main.on('click', '.wa-link-contact-to-conversation', () => {
			this.link_bare_conversation_to_contact();
		});
	}

	setup_realtime() {
		frappe.realtime.on('whatsapp_inbox_update', (data) => {
			const is_current = data.conversation && data.conversation === this.current_conversation;
			if (is_current) {
				this.load_thread(this.current_conversation);
			}
			// The new message just marked this conversation unread server-side even
			// though the operator may be actively looking at it right now --
			// immediately mark it read again instead of leaving a stale unread badge
			// on an already-open conversation. refresh_conversations() waits for that
			// to land first so it doesn't briefly show the badge and flip it back off.
			const marked_read = is_current ? this.mark_conversation_read(this.current_conversation) : Promise.resolve();
			marked_read.then(() => this.refresh_conversations());
		});
	}

	mark_conversation_read(name) {
		return frappe.call({ method: 'takion_whatsapp.client.inbox.mark_conversation_read', args: { conversation: name } });
	}

	update_status_filter_label() {
		const selected = this.filters.status || [];
		let label;
		if (!selected.length) label = 'Status: Todos';
		else if (selected.length === 1) label = `Status: ${selected[0]}`;
		else label = `Status: ${selected.length} selecionados`;
		this.page.body.find('.wa-status-filter-toggle').text(label);
	}

	// Sandbox (teste manual sem depender do número real da Meta): abre (criando
	// se ainda não existir) a conversa fictícia e a trata como qualquer outra —
	// o compose normal (texto/mic/anexo) já testa send_message/send_audio_message/
	// send_media_message de verdade; só falta simular o lado de ENTRADA, que
	// nenhum outro fluxo da UI cobre hoje (mensagens de entrada só existiam via
	// webhook real até agora).
	open_sandbox() {
		frappe.call({ method: 'takion_whatsapp.client.sandbox.ensure_sandbox_conversation' }).then((r) => {
			this.refresh_conversations();
			this.open_conversation(r.message);
		});
	}

	open_simulate_incoming_dialog() {
		const conversation = this.current_conversation;
		const d = new frappe.ui.Dialog({
			title: __('Simular mensagem recebida (sandbox)'),
			fields: [
				{
					fieldname: 'content_type', fieldtype: 'Select', label: __('Tipo'),
					options: ['text', 'image', 'video', 'document', 'audio', 'sticker'].join('\n'),
					default: 'text', reqd: 1,
				},
				{ fieldname: 'message', fieldtype: 'Small Text', label: __('Mensagem / legenda') },
				{
					fieldname: 'file', fieldtype: 'Attach', label: __('Arquivo (necessário exceto p/ texto)'),
					depends_on: 'eval:doc.content_type !== "text"',
				},
			],
			primary_action_label: __('Simular'),
			primary_action: (values) => {
				if (values.content_type !== 'text' && !values.file) {
					frappe.msgprint(__('Selecione um arquivo para este tipo.'));
					return;
				}
				frappe.call({
					method: 'takion_whatsapp.client.sandbox.simulate_incoming',
					args: {
						conversation,
						content_type: values.content_type,
						message: values.message,
						file_url: values.file,
					},
				}).then(() => {
					d.hide();
					this.load_thread(conversation);
					this.refresh_conversations();
				});
			},
		});
		d.show();
	}

	clear_sandbox_messages() {
		const conversation = this.current_conversation;
		frappe.confirm(__('Apagar todas as mensagens desta conversa de sandbox?'), () => {
			frappe.call({
				method: 'takion_whatsapp.client.sandbox.clear_sandbox_messages',
				args: { conversation },
			}).then(() => {
				this.load_thread(conversation);
				this.refresh_conversations();
			});
		});
	}

	// Dedicated test harness for Entrega 12 (Grupos): no OBA exists in any Takion
	// environment yet (see takion_whatsapp_grupos_decisions memory), so the real
	// Meta Groups API is unreachable -- this drives client/sandbox.py's group
	// simulation functions, which exercise the exact same state-mutation code
	// (client/groups.py::reconcile_group) real webhooks would, minus the live
	// HTTP call. Manages one sandbox group at a time (create -> confirm ->
	// join/leave participants -> simulate an incoming message from one of them),
	// re-rendering itself after every action instead of closing.
	open_group_sandbox_dialog() {
		const dialog = new frappe.ui.Dialog({
			title: __('Testar Grupos (sandbox)'),
			fields: [{ fieldname: 'body', fieldtype: 'HTML' }],
		});
		const $body = () => $(dialog.fields_dict.body.wrapper);

		const refresh = () => {
			frappe.call({ method: 'takion_whatsapp.client.sandbox.get_sandbox_group' }).then((r) => render(r.message));
		};

		const render = (group) => {
			if (!group) {
				$body().html('<button class="btn btn-default btn-sm wa-gs-create">Criar grupo de teste</button>');
				$body().find('.wa-gs-create').on('click', () => {
					frappe.call({ method: 'takion_whatsapp.client.sandbox.create_sandbox_group' }).then(refresh);
				});
				return;
			}

			if (!group.group_id) {
				$body().html(`
					<div>${frappe.utils.escape_html(group.subject)} — <em>Pendente</em></div>
					<p class="text-muted small">Criação assíncrona (mesmo comportamento real da Meta) — simule a confirmação abaixo.</p>
					<button class="btn btn-default btn-sm wa-gs-confirm">Simular confirmação da Meta</button>
					<button class="btn btn-default btn-sm wa-gs-clear">Limpar</button>
				`);
				$body().find('.wa-gs-confirm').on('click', () => {
					frappe.call({ method: 'takion_whatsapp.client.sandbox.simulate_group_created', args: { group: group.name } }).then(refresh);
				});
				$body().find('.wa-gs-clear').on('click', () => {
					frappe.call({ method: 'takion_whatsapp.client.sandbox.clear_sandbox_groups' }).then(refresh);
				});
				return;
			}

			$body().html(`
				<div>${frappe.utils.escape_html(group.subject)} — <em>${frappe.utils.escape_html(group.status)}</em></div>
				<div class="mt-2">
					${group.participants.map((p) => `
						<span class="wa-tag-chip">${frappe.utils.escape_html(p.profile_name || p.wa_id)}<span class="remove wa-gs-leave" data-wa-id="${frappe.utils.escape_html(p.wa_id)}">×</span></span>
					`).join('') || '<span class="text-muted small">Nenhum participante ainda</span>'}
				</div>
				<div class="mt-2">
					<input class="form-control form-control-sm wa-gs-wa-id" placeholder="wa_id (ex: 5511999998888)" style="display:inline-block;width:45%;">
					<input class="form-control form-control-sm wa-gs-name" placeholder="Nome (opcional)" style="display:inline-block;width:45%;">
					<button class="btn btn-default btn-xs mt-1 wa-gs-join">+ Simular entrada</button>
				</div>
				${group.participants.length ? `
					<div class="mt-3">
						<select class="form-control form-control-sm wa-gs-sender" style="display:inline-block;width:45%;">
							${group.participants.map((p) => `<option value="${frappe.utils.escape_html(p.wa_id)}" data-profile-name="${frappe.utils.escape_html(p.profile_name || '')}">${frappe.utils.escape_html(p.profile_name || p.wa_id)}</option>`).join('')}
						</select>
						<input class="form-control form-control-sm wa-gs-message" placeholder="Mensagem" style="display:inline-block;width:45%;">
						<button class="btn btn-default btn-xs mt-1 wa-gs-send">Simular mensagem recebida</button>
					</div>
				` : ''}
				<div class="mt-3">
					<button class="btn btn-default btn-xs wa-gs-open">Abrir conversa</button>
					<button class="btn btn-danger btn-xs wa-gs-clear">Limpar grupo de teste</button>
				</div>
			`);

			$body().find('.wa-gs-join').on('click', () => {
				const wa_id = $body().find('.wa-gs-wa-id').val().trim();
				if (!wa_id) return;
				frappe.call({
					method: 'takion_whatsapp.client.sandbox.simulate_group_participant_join',
					args: { group: group.name, wa_id, profile_name: $body().find('.wa-gs-name').val().trim() || null },
				}).then(refresh);
			});
			$body().find('.wa-gs-leave').on('click', (e) => {
				frappe.call({
					method: 'takion_whatsapp.client.sandbox.simulate_group_participant_leave',
					args: { group: group.name, wa_id: $(e.currentTarget).data('wa-id') },
				}).then(refresh);
			});
			$body().find('.wa-gs-send').on('click', () => {
				const $sender = $body().find('.wa-gs-sender');
				const wa_id = $sender.val();
				const profile_name = $sender.find('option:selected').data('profile-name') || null;
				const message = $body().find('.wa-gs-message').val().trim();
				if (!wa_id || !message) return;
				frappe.call({
					method: 'takion_whatsapp.client.sandbox.simulate_incoming_group_message',
					args: { group: group.name, wa_id, message, profile_name },
				}).then(() => {
					if (this.current_conversation) this.load_thread(this.current_conversation);
					this.refresh_conversations();
					refresh();
				});
			});
			$body().find('.wa-gs-open').on('click', () => {
				frappe.db.get_value('WhatsApp Conversation', { whatsapp_group: group.name }, 'name').then((r) => {
					if (r.message && r.message.name) {
						dialog.hide();
						this.open_conversation(r.message.name);
					}
				});
			});
			$body().find('.wa-gs-clear').on('click', () => {
				frappe.confirm(__('Apagar este grupo de teste?'), () => {
					frappe.call({ method: 'takion_whatsapp.client.sandbox.clear_sandbox_groups' }).then(() => {
						this.refresh_conversations();
						refresh();
					});
				});
			});
		};

		dialog.show();
		refresh();
	}

	refresh_conversations() {
		frappe.call({
			method: 'takion_whatsapp.client.inbox.get_conversations',
			args: this.filters,
		}).then((r) => this.render_conversations(r.message || []));
	}

	render_conversations(conversations) {
		const $list = this.page.body.find('.wa-conversations-list');
		if (!conversations.length) {
			$list.html('<div class="wa-empty-state">Nenhuma conversa</div>');
			return;
		}

		$list.html(conversations.map((c) => {
			const title = frappe.utils.escape_html(c.contact || c.phone_number_display || c.name);
			const preview = frappe.utils.escape_html(c.last_message_preview || '');
			const when = c.last_message_at ? this.format_bubble_time(c.last_message_at) : '';
			const active = c.name === this.current_conversation ? ' active' : '';
			const unread = c.is_unread ? ' unread' : '';
			const direction_icon = c.last_direction === 'Outbound' ? '↗' : '↙';
			const tags = (c._user_tags || '').split(',').map((t) => t.trim()).filter(Boolean);
			let assignees = [];
			try { assignees = JSON.parse(c._assign || '[]'); } catch (e) { assignees = []; }

			const avatar_name = c.contact || c.phone_number_display || c.name;
			return `
				<div class="wa-conversation-item${active}${unread}" data-name="${c.name}">
					<div class="wa-conversation-avatar" style="background:${this.avatar_color(avatar_name)};">
						${c.whatsapp_group ? this.icon('users') : frappe.utils.escape_html(this.avatar_initial(avatar_name))}
					</div>
					<div class="wa-conversation-body">
						<div class="wa-conversation-title">
							<span>${title}</span>
							<span class="wa-conversation-time">${when}</span>
						</div>
						<div class="wa-conversation-preview">${direction_icon} ${preview}</div>
						<div class="wa-conversation-meta">
							<span class="indicator-pill ${this.status_color(c.status)}">${frappe.utils.escape_html(c.status || '')}</span>
							${this.render_sla_badge(c.sla_state)}
							${tags.map((t) => `<span class="wa-tag-chip">${frappe.utils.escape_html(t)}</span>`).join('')}
							${assignees.length ? `<span class="wa-assign-chip" title="${frappe.utils.escape_html(assignees[0])}">${frappe.utils.escape_html(assignees[0][0] || '?').toUpperCase()}</span>` : ''}
							${c.is_unread ? '<span class="wa-unread-dot" title="Não lida"></span>' : ''}
						</div>
					</div>
				</div>
			`;
		}).join(''));
	}

	status_color(status) {
		return {
			'Novo': 'blue',
			'Em andamento': 'orange',
			'Aguardando cliente': 'yellow',
			'Resolvido': 'green',
		}[status] || 'gray';
	}

	// Entrega 9 (SLA): quiet by default -- "OK" (the vast majority of
	// conversations, most of the time) renders nothing at all, only "Em risco"/
	// "Estourado" get a pill, so the badge only draws the eye when it matters.
	render_sla_badge(sla_state) {
		if (!sla_state || sla_state === 'OK') return '';
		const color = sla_state === 'Estourado' ? 'red' : 'orange';
		return `<span class="indicator-pill ${color}" title="SLA">${frappe.utils.escape_html(sla_state)}</span>`;
	}

	open_conversation(name, jump_to_message) {
		this.abort_compose_recording();
		this.discard_media();
		this.current_conversation = name;
		// Reset eagerly (not just after load_contact_panel resolves) so a stray
		// render_message() firing mid-switch (e.g. a fast realtime update) never
		// paints the PREVIOUS conversation's group/1:1 mode onto the new one.
		this.is_group_conversation = false;
		this.current_group_panel = null;
		this.pending_jump_message = jump_to_message || null;
		this.thread_search_query = '';
		this.thread_search_matches = [];
		this.thread_search_index = -1;
		this.page.body.find('.wa-thread-search-bar').hide();
		this.page.body.find('.wa-thread-search-input').val('');
		this.page.body.find('.wa-conversation-item').removeClass('active');
		this.page.body.find(`.wa-conversation-item[data-name="${name}"]`)
			.addClass('active')
			.removeClass('unread')
			.find('.wa-unread-dot').remove();
		this.mark_conversation_read(name).then(() => this.refresh_conversations());
		this.page.body.find('.wa-thread-compose').show();
		this.page.body.find('.wa-compose-input').val('');
		this.autosize_compose_input();
		this.update_compose_buttons();

		// Gates is_group_conversation (read by render_message's sender-label logic)
		// BEFORE the thread itself renders -- load_contact_panel below fetches the
		// same conversation doc again for its own (larger) panel payload, but
		// that call resolving later/first is not reliable enough to gate the
		// very first paint's sender labels on, and this lookup is cheap.
		frappe.db.get_value('WhatsApp Conversation', name, 'whatsapp_group').then((r) => {
			this.is_group_conversation = !!(r.message && r.message.whatsapp_group);
			this.load_thread(name);
		});
		this.load_contact_panel(name);
	}

	load_thread(name) {
		frappe.call({
			method: 'takion_whatsapp.client.inbox.get_thread',
			args: { conversation: name },
		}).then((r) => {
			this.render_thread(r.message || []);
			if (this.pending_jump_message) {
				this.flash_highlight_message(this.pending_jump_message);
				this.pending_jump_message = null;
			}
		});
	}

	render_thread(messages) {
		// .wa-thread-title itself (avatar + name) is set by render_thread_contact_chip,
		// called from load_contact_panel — both fire together from open_conversation.
		this.page.body.find('.wa-thread-search-toggle').show();

		this.waveforms.forEach((ws) => ws.destroy());
		this.waveforms = [];

		this.thread_messages = messages;
		const $messages = this.page.body.find('.wa-thread-messages');
		$messages.html(messages.map((m) => this.render_message(m)).join(''));

		this.init_waveforms(messages);

		if (this.thread_search_query) {
			this.thread_search_matches = messages
				.filter((m) => (m.message || '').toLowerCase().includes(this.thread_search_query.toLowerCase()))
				.map((m) => m.name);
			// Defaults to the newest match — matches WhatsApp's own "search jumps to
			// the most recent hit first" behavior; ↑/↓ step through older/newer ones.
			this.thread_search_index = this.thread_search_matches.length - 1;
			this.render_search_counter();
			this.jump_to_current_match();
		} else {
			$messages.scrollTop($messages[0].scrollHeight);
		}
	}

	// In-conversation search: entirely client-side, over thread_messages already
	// loaded by load_thread — no backend round trip, since get_thread loads the
	// whole (unpaginated) history up front.
	toggle_thread_search() {
		const $bar = this.page.body.find('.wa-thread-search-bar');
		const opening = $bar.is(':hidden');
		$bar.toggle(opening);
		if (opening) {
			this.page.body.find('.wa-thread-search-input').val('').focus();
		} else {
			this.thread_search_query = '';
			this.thread_search_matches = [];
			this.thread_search_index = -1;
			this.render_thread(this.thread_messages);
		}
	}

	thread_search_step(direction) {
		const total = this.thread_search_matches.length;
		if (!total) return;
		this.thread_search_index = (this.thread_search_index + direction + total) % total;
		this.render_search_counter();
		this.jump_to_current_match();
	}

	render_search_counter() {
		const total = this.thread_search_matches.length;
		const current = total ? this.thread_search_index + 1 : 0;
		this.page.body.find('.wa-thread-search-counter').text(`${current}/${total}`);
	}

	jump_to_current_match() {
		this.page.body.find('.wa-bubble-row').removeClass('wa-active-match-row');
		if (this.thread_search_index < 0) return;
		const name = this.thread_search_matches[this.thread_search_index];
		const $row = this.page.body.find(`.wa-bubble-row[data-message="${name}"]`);
		$row.addClass('wa-active-match-row');
		if ($row.length) $row[0].scrollIntoView({ block: 'center' });
	}

	// Used when a global search result opens a conversation the user didn't have
	// open before — a one-off flash, distinct from the persistent highlight an
	// active in-conversation search match gets.
	flash_highlight_message(name) {
		const $row = this.page.body.find(`.wa-bubble-row[data-message="${name}"]`);
		if (!$row.length) return;
		$row[0].scrollIntoView({ block: 'center' });
		$row.addClass('wa-active-match-row');
		setTimeout(() => $row.removeClass('wa-active-match-row'), 2000);
	}

	// Splits on the (escaped) query so each segment can be escaped for HTML
	// independently — safer than highlighting after escaping the whole string,
	// which could otherwise match inside an already-escaped entity like "&amp;".
	highlight_text(text, query) {
		const raw = text || '';
		if (!query) return frappe.utils.escape_html(raw);
		const escaped_query = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const parts = raw.split(new RegExp(`(${escaped_query})`, 'gi'));
		return parts.map((part, i) => {
			const safe = frappe.utils.escape_html(part);
			return (i % 2 === 1 && part) ? `<mark class="wa-search-match">${safe}</mark>` : safe;
		}).join('');
	}

	run_global_search(query) {
		if (!query) {
			this.page.body.find('.wa-conversations-filters').show();
			this.refresh_conversations();
			return;
		}
		this.page.body.find('.wa-conversations-filters').hide();
		frappe.call({
			method: 'takion_whatsapp.client.search.search_global',
			args: { query },
		}).then((r) => this.render_global_search_results(r.message || [], query));
	}

	render_global_search_results(groups, query) {
		const $list = this.page.body.find('.wa-conversations-list');
		if (!groups.length) {
			$list.html('<div class="wa-empty-state">Nenhum resultado</div>');
			return;
		}

		$list.html(groups.map((g) => {
			const title = frappe.utils.escape_html(g.contact || g.phone_number_display || g.conversation);
			return `
				<div class="wa-search-group">
					<div class="wa-search-group-title">${title}</div>
					${g.matches.map((m) => `
						<div class="wa-search-result" data-conversation="${g.conversation}" data-message="${m.name}">
							${this.highlight_text(m.message || '', query)}
						</div>
					`).join('')}
				</div>
			`;
		}).join(''));
	}

	// Resolves a Desk CSS variable (theme-aware) to a concrete color, since
	// canvas fillStyle (what wavesurfer draws with) can't resolve var(--x) itself.
	theme_color(var_name, fallback) {
		const val = getComputedStyle(document.documentElement).getPropertyValue(var_name).trim();
		return val || fallback;
	}

	init_waveforms(messages) {
		messages.filter((m) => m.content_type === 'audio' && m.attach).forEach((m) => {
			const $bubble = this.page.body.find(`.wa-audio-bubble[data-message="${m.name}"]`);
			if (!$bubble.length) return;
			const $button = $bubble.find('.wa-audio-play');
			const $duration = $bubble.find('.wa-audio-duration');

			const ws = WaveSurfer.create({
				container: $bubble.find('.wa-audio-wave')[0],
				url: m.attach,
				height: 24,
				barWidth: 2,
				barGap: 1.5,
				cursorWidth: 0,
				waveColor: this.theme_color('--gray-400', '#bbb'),
				progressColor: this.theme_color('--gray-600', '#666'),
				interact: true,
			});

			ws.on('ready', () => $duration.text(this.format_duration(ws.getDuration())));
			ws.on('audioprocess', () => $duration.text(this.format_duration(ws.getDuration() - ws.getCurrentTime())));
			ws.on('finish', () => {
				$button.html(this.icon('play'));
				$duration.text(this.format_duration(ws.getDuration()));
			});

			$button.on('click', () => {
				this.waveforms.filter((w) => w !== ws).forEach((w) => w.pause());
				this.page.body.find('.wa-audio-play').not($button).html(this.icon('play'));
				ws.playPause();
				$button.html(this.icon(ws.isPlaying() ? 'pause' : 'play'));
			});

			this.waveforms.push(ws);
		});
	}

	// Bugfix 2026-08-01: frappe.datetime.str_to_user(val, true)'s only_time
	// branch parses `val` with moment(val, frappe.defaultTimeFormat) -- a
	// TIME-only format pattern ("HH:mm:ss") applied to a full datetime
	// string ("2026-08-01 12:03:29.738624"), which moment mis-parses,
	// producing wrong hours (seen: showing 20:03 for a message actually
	// sent at 12:03 local time). Goes through the same
	// moment.tz(system)->tz(user) conversion str_to_user's own datetime
	// branch uses (the only one that's actually correct), then formats
	// just the time -- HH:mm, no seconds, per user's explicit ask (seconds
	// stay intact in the underlying `creation` field for reports/logs,
	// this only affects the bubble timestamp's display).
	format_bubble_time(datetime_str) {
		const system_datetime = moment.tz(datetime_str, frappe.defaultDatetimeFormat, frappe.boot.time_zone.system);
		const user_datetime = system_datetime.clone().tz(frappe.boot.time_zone.user);
		return user_datetime.format('HH:mm');
	}

	render_message(msg) {
		const out = msg.type === 'Outgoing';
		const time = this.format_bubble_time(msg.creation);
		const check = out ? this.render_check(msg.status) : '';
		// Group threads can have several distinct senders in one conversation
		// (unlike 1:1, where "who sent this" is never ambiguous) -- labeled only
		// for inbound bubbles, since every outgoing bubble is always us.
		const sender = (!out && this.is_group_conversation)
			? `<div class="wa-bubble-sender">${frappe.utils.escape_html(msg.profile_name || msg.from || '')}</div>`
			: '';
		const body = msg.content_type === 'audio'
			? this.render_audio_bubble(msg)
			: this.render_generic_bubble(msg);

		// Stickers render without the chat-bubble background/shadow, same as
		// WhatsApp's own UI -- everything else keeps the normal bubble chrome.
		const bubble_class = msg.content_type === 'sticker' ? 'wa-bubble wa-bubble-sticker-wrap' : 'wa-bubble';

		return `
			<div class="wa-bubble-row ${out ? 'out' : 'in'}" data-message="${frappe.utils.escape_html(msg.name)}">
				<div class="${bubble_class}">
					${sender}
					${body}
					<div class="wa-bubble-time">${time}${check}</div>
				</div>
			</div>
		`;
	}

	// Click-to-zoom on any image bubble — a fullscreen overlay with the same
	// URL at full size, closed by clicking anywhere or pressing Escape.
	open_image_lightbox(src) {
		const $overlay = $(`<div class="wa-lightbox-overlay"><img src="${frappe.utils.escape_html(src)}"></div>`).appendTo('body');
		const close = () => {
			$overlay.remove();
			$(document).off('keydown.wa-lightbox');
		};
		$overlay.on('click', close);
		$(document).on('keydown.wa-lightbox', (e) => {
			if (e.key === 'Escape') close();
		});
	}

	render_check(status) {
		if (status === 'read') return ` <span class="wa-check wa-check-read">${this.icon('check-double')}</span>`;
		if (status === 'delivered') return ` <span class="wa-check">${this.icon('check-double')}</span>`;
		if (status === 'failed') return ` <span class="wa-check text-danger">${this.icon('x')}</span>`;
		return ` <span class="wa-check">${this.icon('check')}</span>`;
	}

	render_generic_bubble(msg) {
		// Image/video captions ride in the same `message` field text messages use
		// (see WhatsAppMessage.send_outgoing's data[content_type]["caption"]) —
		// rendered below the media, same as WhatsApp's own bubble layout.
		const caption = msg.message
			? `<div class="wa-bubble-text" style="margin-top:4px;">${
				this.thread_search_query
					? this.highlight_text(msg.message, this.thread_search_query)
					: frappe.utils.escape_html(msg.message)
			}</div>`
			: '';
		if (msg.content_type === 'sticker' && msg.attach) {
			// No caption support (see WhatsApp Cloud API's Sticker Message reference)
			// and no bubble chrome, same as WhatsApp's own rendering of stickers.
			return `<img class="wa-bubble-sticker" src="${frappe.utils.escape_html(msg.attach)}" alt="${__('Figurinha')}">`;
		}
		if (msg.content_type === 'image' && msg.attach) {
			return `<img class="wa-bubble-img" src="${frappe.utils.escape_html(msg.attach)}" style="max-width:220px;border-radius:4px;">${caption}`;
		}
		if (msg.content_type === 'video' && msg.attach) {
			return `<video src="${frappe.utils.escape_html(msg.attach)}" controls style="max-width:220px;border-radius:4px;"></video>${caption}`;
		}
		if (msg.attach && msg.content_type === 'document') {
			return `<a href="${frappe.utils.escape_html(msg.attach)}" target="_blank">${this.icon('file')} ${frappe.utils.escape_html(msg.attach.split('/').pop())}</a>`;
		}
		const html = this.thread_search_query
			? this.highlight_text(msg.message || '', this.thread_search_query)
			: frappe.utils.escape_html(msg.message || '');
		return `<div class="wa-bubble-text">${html}</div>`;
	}

	render_audio_bubble(msg) {
		// Real waveform: WhatsApp doesn't transmit pre-computed waveform data, so
		// wavesurfer.js decodes the actual audio client-side. Instantiated after
		// insertion by init_waveforms() (needs the container in the live DOM).
		return `
			<div class="wa-audio-bubble" data-message="${frappe.utils.escape_html(msg.name)}">
				<button class="wa-audio-play">${this.icon('play')}</button>
				<div class="wa-audio-wave"></div>
				<span class="wa-audio-duration">--:--</span>
			</div>
		`;
	}

	format_duration(seconds) {
		if (!isFinite(seconds) || seconds < 0) return '--:--';
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	send_message() {
		const $input = this.page.body.find('.wa-compose-input');
		const text = $input.val().trim();
		if (!text || !this.current_conversation) return;

		$input.val('').prop('disabled', true);
		this.autosize_compose_input();
		frappe.call({
			method: 'takion_whatsapp.client.inbox.send_message',
			args: { conversation: this.current_conversation, message: text },
		}).then(() => {
			$input.prop('disabled', false).focus();
			this.update_compose_buttons();
			this.load_thread(this.current_conversation);
			this.refresh_conversations();
		}).catch(() => $input.prop('disabled', false));
	}

	// Grows the textarea with its content, like WhatsApp's own compose box —
	// capped at max-height (CSS), after which it scrolls internally instead of
	// growing forever. Reset to 'auto' first so shrinking (e.g. after deleting
	// lines) is picked up too, not just growth.
	autosize_compose_input(el) {
		el = el || this.page.body.find('.wa-compose-input')[0];
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = el.scrollHeight + 'px';
	}

	// Full 1914-emoji, 9-category set, fetched once (lazily, on first open) from
	// the vendored JSON — see WA_EMOJI_CATEGORY_ICONS' comment for provenance.
	// Entrega 13 ("Figurinhas") adds a 2nd mode alongside emoji -- a top-level
	// Emoji/Figurinhas switch, structurally the same idea as the WhatsApp
	// Business App's own Emoji/GIF/Sticker tab row (no GIF here, only 2 modes).
	async toggle_emoji_picker() {
		const $picker = this.page.body.find('.wa-emoji-picker');
		if ($picker.hasClass('open')) {
			$picker.removeClass('open');
			return;
		}
		if (!$picker.find('.wa-picker-mode-tabs').length) {
			$picker.html(`
				<div class="wa-picker-mode-tabs">
					<span class="wa-picker-mode-tab active" data-mode="emoji" title="${__('Emoji')}">😀</span>
					<span class="wa-picker-mode-tab" data-mode="sticker" title="${__('Figurinhas')}">🏷️</span>
				</div>
				<div class="wa-picker-body"></div>
			`);
		}
		$picker.addClass('open');
		await this.set_picker_mode(this.picker_mode || 'emoji');
	}

	async set_picker_mode(mode) {
		this.picker_mode = mode;
		this.page.body.find('.wa-picker-mode-tab').removeClass('active').filter(`[data-mode="${mode}"]`).addClass('active');
		if (mode === 'sticker') {
			await this.render_sticker_picker();
		} else {
			await this.load_emoji_categories();
			this.render_emoji_picker(this.emoji_active_category || 0);
		}
	}

	async load_emoji_categories() {
		if (this.emoji_categories) return;
		const $body = this.page.body.find('.wa-picker-body');
		$body.html('<div class="wa-emoji-loading">Carregando…</div>');
		try {
			const res = await fetch('/assets/takion_whatsapp/js/lib/emoji-data.json');
			this.emoji_categories = await res.json();
		} catch (e) {
			$body.html('<div class="wa-emoji-loading">Não foi possível carregar os emojis.</div>');
		}
	}

	render_emoji_picker(category_index) {
		if (!this.emoji_categories) return;
		this.emoji_active_category = category_index;
		const $body = this.page.body.find('.wa-picker-body');
		const tabs = this.emoji_categories
			.map((cat, i) => `<span class="wa-emoji-tab${i === category_index ? ' active' : ''}" data-index="${i}" title="${frappe.utils.escape_html(cat.name)}">${WA_EMOJI_CATEGORY_ICONS[i] || '•'}</span>`)
			.join('');
		const grid = this.emoji_categories[category_index].emojis
			.map(([emoji, name]) => `<span class="wa-emoji-option" title="${frappe.utils.escape_html(name)}">${emoji}</span>`)
			.join('');
		$body.html(`<div class="wa-emoji-tabs">${tabs}</div><div class="wa-emoji-grid">${grid}</div>`);
	}

	// Catalog is admin-managed (WhatsApp Sticker list) -- fetched once per page
	// session, same lazy-cache pattern as emoji_categories. Clicking a sticker
	// sends it immediately (like WhatsApp's own picker), it isn't inserted into
	// the compose box first -- stickers have no caption/text to combine with.
	async render_sticker_picker() {
		const $body = this.page.body.find('.wa-picker-body');
		if (!this.stickers) {
			$body.html('<div class="wa-emoji-loading">Carregando…</div>');
			try {
				const r = await frappe.call({ method: 'takion_whatsapp.client.inbox.list_stickers' });
				this.stickers = r.message || [];
			} catch (e) {
				$body.html('<div class="wa-emoji-loading">Não foi possível carregar as figurinhas.</div>');
				return;
			}
		}
		if (!this.stickers.length) {
			$body.html(`<div class="wa-emoji-loading">${__('Nenhuma figurinha cadastrada ainda. Um administrador pode cadastrar em WhatsApp Sticker.')}</div>`);
			return;
		}
		const grid = this.stickers
			.map((s) => `<img class="wa-sticker-option" data-sticker="${frappe.utils.escape_html(s.name)}" src="${frappe.utils.escape_html(s.image)}" title="${frappe.utils.escape_html(s.title || s.pack || '')}">`)
			.join('');
		$body.html(`<div class="wa-sticker-grid">${grid}</div>`);
	}

	send_sticker(sticker) {
		if (!sticker || !this.current_conversation) return;
		this.page.body.find('.wa-emoji-picker').removeClass('open');
		frappe.call({
			method: 'takion_whatsapp.client.inbox.send_sticker_message',
			args: { conversation: this.current_conversation, sticker },
		}).then(() => {
			this.load_thread(this.current_conversation);
			this.refresh_conversations();
		});
	}

	insert_emoji_at_cursor(emoji) {
		const el = this.page.body.find('.wa-compose-input')[0];
		if (!el) return;
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? el.value.length;
		el.value = el.value.slice(0, start) + emoji + el.value.slice(end);
		const cursor = start + emoji.length;
		el.selectionStart = el.selectionEnd = cursor;
		el.focus();
		this.autosize_compose_input(el);
		this.update_compose_buttons();
	}

	update_compose_buttons() {
		const has_text = !!this.page.body.find('.wa-compose-input').val().trim();
		this.page.body.find('.wa-compose-mic').toggle(!has_text);
		this.page.body.find('.wa-compose-send').toggle(has_text);
	}

	show_compose_row(which) {
		const $compose = this.page.body.find('.wa-thread-compose');
		$compose.find('.wa-compose-text-row').toggle(which === 'text');
		$compose.find('.wa-compose-record-row').toggle(which === 'record');
		$compose.find('.wa-compose-preview-row').toggle(which === 'preview');
		$compose.find('.wa-compose-media-row').toggle(which === 'media');
		if (which === 'text') this.update_compose_buttons();
	}

	// Recording relies entirely on wavesurfer's Record plugin (same vendored lib
	// as the playback waveform) rather than a hand-rolled MediaRecorder: it owns
	// mic access, live waveform rendering, AND the recorded Blob, so there's a
	// single audio dependency instead of two overlapping ones. mimeType/bitrate
	// are capped client-side so the browser recording itself starts small —
	// the real format fix (WebM/Opus -> OGG/Opus for native voice-note
	// rendering) still happens server-side, see send_recorded_audio().
	async start_recording() {
		if (this.record_plugin) return;

		const $wave = this.page.body.find('.wa-record-wave').empty();
		const ws = WaveSurfer.create({
			container: $wave[0],
			height: 34,
			waveColor: this.theme_color('--gray-400', '#bbb'),
			progressColor: this.theme_color('--gray-600', '#666'),
			cursorWidth: 0,
		});
		const record = ws.registerPlugin(WaveSurfer.Record.create({
			scrollingWaveform: true,
			renderRecordedAudio: false,
			mimeType: 'audio/webm;codecs=opus',
			audioBitsPerSecond: 32000,
		}));
		record.on('record-end', (blob) => this.on_recording_finished(blob));

		try {
			await record.startRecording();
		} catch (e) {
			ws.destroy();
			frappe.msgprint(__('Não foi possível acessar o microfone. Verifique as permissões do navegador.'));
			return;
		}

		this.record_wavesurfer = ws;
		this.record_plugin = record;
		this.record_start = Date.now();
		this.show_compose_row('record');
		this.update_record_timer();
		this.record_timer = setInterval(() => {
			this.update_record_timer();
			if ((Date.now() - this.record_start) / 1000 >= this.MAX_RECORDING_SECONDS) {
				this.stop_recording();
			}
		}, 250);
	}

	update_record_timer() {
		const elapsed = (Date.now() - this.record_start) / 1000;
		this.page.body.find('.wa-record-timer').text(this.format_duration(elapsed));
	}

	stop_recording() {
		if (!this.record_plugin) return;
		this.record_plugin.stopRecording();
	}

	cancel_recording() {
		if (!this.record_plugin) {
			this.show_compose_row('text');
			return;
		}
		this._recording_cancelled = true;
		this.record_plugin.stopRecording();
	}

	on_recording_finished(blob) {
		clearInterval(this.record_timer);
		this.record_timer = null;
		// Not calling record_wavesurfer.destroy() here: the Record plugin's own
		// stopRecording() already tears down the mic stream and its AudioContext,
		// so destroy() would try to close an already-closed AudioContext (logs
		// "Cannot close a closed AudioContext" as an unhandled rejection inside
		// wavesurfer's own internals — harmless, but avoided by just dropping the
		// reference; the container's DOM gets cleared on the next recording anyway).
		this.record_wavesurfer = null;
		this.record_plugin = null;

		const cancelled = this._recording_cancelled;
		this._recording_cancelled = false;

		if (cancelled || !blob || !blob.size) {
			this.show_compose_row('text');
			return;
		}

		this.recorded_blob = blob;
		this.show_recording_preview(blob);
	}

	show_recording_preview(blob) {
		this.show_compose_row('preview');
		const url = URL.createObjectURL(blob);
		this._preview_url = url;

		const $wave = this.page.body.find('.wa-preview-wave').empty();
		const ws = WaveSurfer.create({
			container: $wave[0],
			height: 34,
			url,
			waveColor: this.theme_color('--gray-400', '#bbb'),
			progressColor: this.theme_color('--gray-600', '#666'),
			cursorWidth: 0,
		});
		const $duration = this.page.body.find('.wa-preview-duration');
		ws.on('ready', () => $duration.text(this.format_duration(ws.getDuration())));
		ws.on('audioprocess', () => $duration.text(this.format_duration(ws.getDuration() - ws.getCurrentTime())));
		ws.on('finish', () => {
			this.page.body.find('.wa-preview-play').html(this.icon('play'));
			$duration.text(this.format_duration(ws.getDuration()));
		});

		this.preview_wavesurfer = ws;
	}

	toggle_preview_playback() {
		if (!this.preview_wavesurfer) return;
		this.preview_wavesurfer.playPause();
		this.page.body.find('.wa-preview-play').html(this.icon(this.preview_wavesurfer.isPlaying() ? 'pause' : 'play'));
	}

	discard_recording() {
		if (this.preview_wavesurfer) {
			this.preview_wavesurfer.destroy();
			this.preview_wavesurfer = null;
		}
		if (this._preview_url) {
			URL.revokeObjectURL(this._preview_url);
			this._preview_url = null;
		}
		this.recorded_blob = null;
		this.show_compose_row('text');
	}

	// Called when navigating away from the conversation mid-recording/preview,
	// so a stray mic stream or unsent blob from a previous thread never leaks
	// into the next one.
	abort_compose_recording() {
		if (this.record_plugin) {
			this._recording_cancelled = true;
			this.record_plugin.stopRecording();
		}
		this.discard_recording();
	}

	send_recorded_audio() {
		if (!this.recorded_blob || !this.current_conversation) return;
		const blob = this.recorded_blob;
		const conversation = this.current_conversation;

		this.discard_recording();
		this.render_optimistic_audio_bubble();

		const form_data = new FormData();
		form_data.append('file', blob, `voice-note-${Date.now()}.webm`);
		form_data.append('is_private', 0);
		form_data.append('doctype', 'WhatsApp Conversation');
		form_data.append('docname', conversation);

		fetch('/api/method/upload_file', {
			method: 'POST',
			headers: { 'X-Frappe-CSRF-Token': frappe.csrf_token },
			body: form_data,
		})
			.then((r) => r.json())
			.then((r) => {
				const file_url = r.message && r.message.file_url;
				if (!file_url) throw new Error('upload failed');
				return frappe.call({
					method: 'takion_whatsapp.client.inbox.send_audio_message',
					args: { conversation, file_url },
				});
			})
			.catch(() => {
				frappe.msgprint(__('Não foi possível enviar o áudio. Tente novamente.'));
			});
	}

	// The real send happens in a background job (WebM->OGG/Opus conversion via
	// ffmpeg, then the same frappe_whatsapp send path text messages use) — this
	// bubble is a client-side placeholder only, replaced wholesale once
	// `whatsapp_inbox_update` triggers a real load_thread(). The timeout is a
	// fallback in case that realtime event is ever missed, not the primary path.
	render_optimistic_audio_bubble() {
		const conversation = this.current_conversation;
		const $messages = this.page.body.find('.wa-thread-messages');
		$messages.append(`
			<div class="wa-bubble-row out wa-optimistic-audio">
				<div class="wa-bubble"><div class="wa-bubble-text text-muted">${this.icon('mic')} ${__('Enviando áudio…')}</div></div>
			</div>
		`);
		$messages.scrollTop($messages[0].scrollHeight);
		setTimeout(() => {
			if (this.current_conversation === conversation) this.load_thread(conversation);
		}, 15000);
	}

	on_media_file_selected(file) {
		const $input = this.page.body.find('.wa-media-file-input');
		if (!file) return;

		// Anything that isn't image/video/audio goes through as a generic WhatsApp
		// "document" — frappe_whatsapp already sends/receives that content_type
		// exactly like image/video (link + caption), just with a bigger size cap.
		// An audio FILE picked here (as opposed to a live recording) reuses the
		// exact same send_audio_message/ffmpeg pipeline as the mic button --
		// ffmpeg's -i auto-detects the input format, it isn't webm-specific.
		const kind = file.type.startsWith('image/') ? 'image'
			: file.type.startsWith('video/') ? 'video'
			: file.type.startsWith('audio/') ? 'audio'
			: 'document';
		if (file.size > this.MEDIA_MAX_BYTES[kind]) {
			const limit_mb = this.MEDIA_MAX_BYTES[kind] / (1024 * 1024);
			frappe.msgprint(__('Arquivo muito grande para o WhatsApp (limite de {0}MB).', [limit_mb]));
			$input.val('');
			return;
		}

		this.media_file = file;
		this.media_kind = kind;
		this.show_media_preview(file, kind);
		$input.val(''); // allow re-selecting the same file later
	}

	show_media_preview(file, kind) {
		this.show_compose_row('media');
		const $preview = this.page.body.find('.wa-media-preview').empty();
		// send_audio_message (unlike send_media_message) has no caption param --
		// same as a recorded voice note, an uploaded audio file goes out without one.
		this.page.body.find('.wa-media-caption').toggle(kind !== 'audio');

		if (kind === 'document' || kind === 'audio') {
			this._media_preview_url = null;
			$preview.append(`<span title="${frappe.utils.escape_html(file.name)}">${this.icon(kind === 'audio' ? 'mic' : 'file')} ${frappe.utils.escape_html(file.name)}</span>`);
			return;
		}

		const url = URL.createObjectURL(file);
		this._media_preview_url = url;
		if (kind === 'image') {
			$preview.append(`<img src="${url}">`);
		} else {
			$preview.append(`<video src="${url}" muted></video>`);
		}
	}

	discard_media() {
		if (this._media_preview_url) {
			URL.revokeObjectURL(this._media_preview_url);
			this._media_preview_url = null;
		}
		this.media_file = null;
		this.media_kind = null;
		this.page.body.find('.wa-media-caption').val('');
		this.page.body.find('.wa-media-preview').empty();
		this.show_compose_row('text');
	}

	send_media() {
		if (!this.media_file || !this.current_conversation) return;
		const file = this.media_file;
		const kind = this.media_kind;
		const caption = this.page.body.find('.wa-media-caption').val().trim();
		const conversation = this.current_conversation;

		this.discard_media();
		this.render_optimistic_media_bubble(kind);

		const form_data = new FormData();
		form_data.append('file', file, file.name);
		form_data.append('is_private', 0);
		form_data.append('doctype', 'WhatsApp Conversation');
		form_data.append('docname', conversation);

		fetch('/api/method/upload_file', {
			method: 'POST',
			headers: { 'X-Frappe-CSRF-Token': frappe.csrf_token },
			body: form_data,
		})
			.then((r) => r.json())
			.then((r) => {
				const file_url = r.message && r.message.file_url;
				if (!file_url) throw new Error('upload failed');
				// Audio picked via the attach menu goes through the same
				// send_audio_message/ffmpeg conversion pipeline a recorded voice note
				// does (server's send_media_message only accepts image/video/document)
				// -- no caption param either way, same as a recording.
				return kind === 'audio'
					? frappe.call({ method: 'takion_whatsapp.client.inbox.send_audio_message', args: { conversation, file_url } })
					: frappe.call({
						method: 'takion_whatsapp.client.inbox.send_media_message',
						args: { conversation, file_url, content_type: kind, caption },
					});
			})
			.then(() => this.load_thread(conversation))
			.catch(() => {
				frappe.msgprint(__('Não foi possível enviar o arquivo. Tente novamente.'));
			});
	}

	// Placeholder only, same pattern/fallback timeout as render_optimistic_audio_bubble
	// — real bubble replaces it once whatsapp_inbox_update triggers load_thread().
	render_optimistic_media_bubble(kind) {
		const conversation = this.current_conversation;
		const $messages = this.page.body.find('.wa-thread-messages');
		const icon = this.icon(kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'audio' ? 'mic' : 'file');
		$messages.append(`
			<div class="wa-bubble-row out wa-optimistic-media">
				<div class="wa-bubble"><div class="wa-bubble-text text-muted">${icon} ${__('Enviando...')}</div></div>
			</div>
		`);
		$messages.scrollTop($messages[0].scrollHeight);
		setTimeout(() => {
			if (this.current_conversation === conversation) this.load_thread(conversation);
		}, 15000);
	}

	load_contact_panel(name) {
		frappe.db.get_doc('WhatsApp Conversation', name).then((conversation) => {
			this.is_group_conversation = !!conversation.whatsapp_group;
			this.page.body.find('.wa-sandbox-banner').toggle(conversation.phone_number === SANDBOX_PHONE_NUMBER);

			if (conversation.whatsapp_group) {
				frappe.call({
					method: 'takion_whatsapp.client.groups.get_group_panel_data',
					args: { conversation: name },
				}).then((r) => {
					this.current_group_panel = r.message;
					this.render_thread_group_chip(r.message);
					this.render_group_panel(r.message);
				});
				return;
			}

			const media_call = frappe.call({ method: 'takion_whatsapp.client.inbox.get_media_gallery', args: { conversation: name } });
			const empty_gallery = { all: [], media: [], documents: [], links: [] };
			if (conversation.contact) {
				Promise.all([
					frappe.db.get_doc('Contact', conversation.contact),
					frappe.call({ method: 'takion_whatsapp.client.contacts.get_contact_roles', args: { contact: conversation.contact } }),
					frappe.call({ method: 'takion_whatsapp.client.pipeline.get_pipeline_state', args: { contact: conversation.contact } }),
					media_call,
				]).then(([contact, roles_resp, pipeline_resp, media_resp]) => {
					this.render_thread_contact_chip(conversation, contact);
					this.current_media_gallery = media_resp.message || empty_gallery;
					this.render_contact_panel(conversation, contact, roles_resp.message || [], pipeline_resp.message || { leads: [], opportunities: [] }, this.current_media_gallery);
				});
			} else {
				this.render_thread_contact_chip(conversation, null);
				media_call.then((media_resp) => {
					this.current_media_gallery = media_resp.message || empty_gallery;
					this.render_contact_panel(conversation, null, [], { leads: [], opportunities: [] }, this.current_media_gallery);
				});
			}
		});
	}

	toggle_role_context($chip) {
		const doctype = $chip.data('doctype');
		const name = $chip.data('name');
		const $body = this.page.body.find('.wa-role-context-body');
		const already_open = $chip.hasClass('active');

		this.page.body.find('.wa-role-context-toggle').removeClass('active');
		if (already_open) {
			$body.hide().empty();
			return;
		}

		$chip.addClass('active');
		$body.show().html('<div class="text-muted">Carregando…</div>');
		frappe.call({
			method: 'takion_whatsapp.client.contacts.get_role_context',
			args: { link_doctype: doctype, link_name: name },
		}).then((r) => $body.html(this.render_role_context(doctype, r.message)));
	}

	// frappe.format's Currency fieldtype wraps the result in its own block-level
	// <div style="text-align:right">, meant for table cells -- wrong here, where
	// it forces an awkward line-break inside a short inline label. Plain text.
	format_currency_brl(value) {
		return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
	}

	render_role_context(doctype, ctx) {
		if (!ctx) return '<div class="text-muted">Sem detalhes</div>';
		if (doctype === 'Customer') {
			const lo = ctx.last_order;
			return `
				<div>Último pedido: ${lo ? `${frappe.utils.escape_html(lo.name)} (${frappe.utils.escape_html(lo.status)})` : '—'}</div>
				<div>Saldo em aberto: ${this.format_currency_brl(ctx.outstanding_amount)}</div>
			`;
		}
		if (doctype === 'Supplier') {
			const po = ctx.last_po;
			return `
				<div>Última compra: ${po ? `${frappe.utils.escape_html(po.name)} (${frappe.utils.escape_html(po.status)})` : '—'}</div>
				<div>Entregas pendentes: ${ctx.pending_deliveries || 0}</div>
			`;
		}
		if (doctype === 'Employee') {
			return `
				<div>Departamento: ${frappe.utils.escape_html(ctx.department || '—')}</div>
				<div>Cargo: ${frappe.utils.escape_html(ctx.designation || '—')}</div>
				<div>Status: ${frappe.utils.escape_html(ctx.status || '—')}</div>
			`;
		}
		return '';
	}

	render_contact_panel(conversation, contact, roles, pipeline, gallery) {
		this.page.body.find('.wa-contact-panel-header h5').text('Dados do contato');
		const $panel = this.page.body.find('.wa-contact-panel-body');
		const tags = (conversation._user_tags || '').split(',').map((t) => t.trim()).filter(Boolean);
		let assignees = [];
		try { assignees = JSON.parse(conversation._assign || '[]'); } catch (e) { assignees = []; }

		const name = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : conversation.phone_number_display;
		const role_labels = { Customer: 'Cliente', Supplier: 'Fornecedor', Employee: 'Funcionário', Lead: 'Lead', Opportunity: 'Oportunidade', Prospect: 'Prospect' };
		const paper_roles = roles.filter((r) => !WA_FUNNEL_DOCTYPES.includes(r.doctype));

		const avatar = contact && contact.image
			? `<img src="${frappe.utils.escape_html(contact.image)}">`
			: `<span>${frappe.utils.escape_html(this.avatar_initial(name))}</span>`;

		$panel.html(`
			<div class="wa-contact-profile">
				<span class="wa-thread-avatar" style="background:${this.avatar_color(name)};">${avatar}</span>
				<h5>${frappe.utils.escape_html(name || '')}</h5>
				<div class="wa-contact-field">${frappe.utils.escape_html(conversation.phone_number_display || '')}</div>
				${contact && contact.email_id ? `<div class="wa-contact-field">${frappe.utils.escape_html(contact.email_id)}</div>` : ''}
				${contact && contact.company_name ? `<div class="wa-contact-field">${frappe.utils.escape_html(contact.company_name)}</div>` : ''}
			</div>

			${contact ? `
				<div class="mt-3"><label class="text-muted small">Papéis</label><br>
					${paper_roles.map((r) => {
						const clickable = WA_CONTEXT_ROLE_DOCTYPES.includes(r.doctype);
						return `<span class="wa-role-chip${clickable ? ' wa-role-context-toggle' : ''}" data-doctype="${frappe.utils.escape_html(r.doctype)}" data-name="${frappe.utils.escape_html(r.name)}" title="${frappe.utils.escape_html(r.name)}">${frappe.utils.escape_html(role_labels[r.doctype] || r.doctype)}: ${frappe.utils.escape_html(r.title)}</span>`;
					}).join('')}
					<span class="wa-role-chip wa-role-add" data-contact="${frappe.utils.escape_html(contact.name)}">+</span>
				</div>
				<div class="wa-role-context-body" style="display:none;"></div>
			` : `
				<div class="mt-3">
					<button class="btn btn-default btn-xs wa-link-contact-to-conversation">+ Cadastrar contato</button>
				</div>
			`}

			${pipeline && (pipeline.leads.length || pipeline.opportunities.length) ? `
				<div class="mt-3"><label class="text-muted small">Funil</label><br>
					${pipeline.leads.map((l) => `
						<span class="wa-role-chip wa-funnel-chip" title="${frappe.utils.escape_html(l.name)}">
							<a href="/app/lead/${encodeURIComponent(l.name)}" target="_blank">Lead: ${frappe.utils.escape_html(l.lead_name || l.name)}</a>
							<small class="text-muted">(${frappe.utils.escape_html(l.status)})</small>
						</span>
					`).join('')}
					${pipeline.opportunities.map((o) => `
						<span class="wa-role-chip wa-funnel-chip" title="${frappe.utils.escape_html(o.name)}">
							<a href="/app/opportunity/${encodeURIComponent(o.name)}" target="_blank">Oport.: ${frappe.utils.escape_html(o.title || o.name)}</a>
							<small class="text-muted">(${frappe.utils.escape_html(o.status)}${o.opportunity_amount ? ', ' + this.format_currency_brl(o.opportunity_amount) : ''})</small>
						</span>
					`).join('')}
				</div>
			` : ''}

			${gallery && (gallery.all.length || gallery.links.length) ? `
				<div class="mt-3 wa-media-section-toggle" title="Ver tudo">
					<label class="text-muted small">Mídia, links e docs (${gallery.all.length + gallery.links.length})</label>
					<div class="wa-media-gallery wa-media-gallery-preview">
						${gallery.all.slice(0, 4).map((m) => this.render_media_thumb(m)).join('')}
					</div>
				</div>
			` : ''}

			<div class="mt-3"><label class="text-muted small">Status</label>
				<select class="form-control form-control-sm wa-status-select">
					${['Novo', 'Em andamento', 'Aguardando cliente', 'Resolvido'].map((s) =>
						`<option value="${s}" ${s === conversation.status ? 'selected' : ''}>${s}</option>`).join('')}
				</select>
			</div>

			<div class="mt-3"><label class="text-muted small">Tags</label><br>
				${tags.map((t) => `<span class="wa-tag-chip">${frappe.utils.escape_html(t)}<span class="remove" data-tag="${frappe.utils.escape_html(t)}">×</span></span>`).join('')}
				<input class="form-control form-control-sm wa-tag-input mt-1" placeholder="+ tag">
			</div>

			<div class="mt-3"><label class="text-muted small">Atribuído a</label><br>
				${assignees.map((u) => `<span class="wa-assign-chip">${frappe.utils.escape_html(u)}<span class="remove" data-user="${frappe.utils.escape_html(u)}">×</span></span>`).join('')}
				<input class="form-control form-control-sm wa-assign-input mt-1" placeholder="+ e-mail do agente">
			</div>
		`);
	}

	// Images open in the same lightbox as thread bubbles; video/document don't
	// have a cheap thumbnail to generate here, so they're a plain icon tile
	// linking straight to the file (same as the thread's own document bubble).
	render_media_thumb(m) {
		if (m.content_type === 'image') {
			return `<div class="wa-media-thumb"><img class="wa-bubble-img" src="${frappe.utils.escape_html(m.attach)}"></div>`;
		}
		const icon = this.icon(m.content_type === 'video' ? 'video' : 'file');
		return `<a class="wa-media-thumb" href="${frappe.utils.escape_html(m.attach)}" target="_blank" title="${frappe.utils.escape_html(m.attach.split('/').pop())}">${icon}</a>`;
	}

	// Full tabbed browser (Mídia/Documentos/Links), replacing the contact-info
	// body the same way WhatsApp Web's own panel navigates — same drawer, back
	// arrow returns to "Dados do contato" (a plain re-fetch, simplest correct
	// way to restore that view without caching it separately).
	open_media_gallery_view() {
		if (!this.current_media_gallery) return;
		this.render_media_gallery_view(this.media_gallery_tab || 'media');
	}

	render_media_gallery_view(tab) {
		this.media_gallery_tab = tab;
		const gallery = this.current_media_gallery;
		const items = gallery[tab] || [];
		const TAB_LABELS = { media: 'Mídia', documents: 'Documentos', links: 'Links' };

		const $body = this.page.body.find('.wa-contact-panel-body');
		$body.html(`
			<div class="wa-media-browser-header">
				<span class="wa-media-browser-back" title="Voltar">←</span>
				<h5>Mídia, links e docs</h5>
			</div>
			<div class="wa-media-tabs">
				${Object.keys(TAB_LABELS).map((key) =>
					`<span class="wa-media-tab${key === tab ? ' active' : ''}" data-tab="${key}">${TAB_LABELS[key]}</span>`
				).join('')}
			</div>
			${items.length
				? tab === 'links'
					? items.map((m) => this.render_link_item(m)).join('')
					: `<div class="wa-media-gallery wa-media-gallery-full">${items.map((m) => this.render_media_thumb(m)).join('')}</div>`
				: '<div class="wa-empty-state" style="height:auto;padding:20px 0;">Nada por aqui ainda</div>'}
		`);
	}

	render_link_item(m) {
		const url_match = (m.message || '').match(/https?:\/\/\S+/);
		const url = url_match ? url_match[0] : '#';
		return `
			<a class="wa-media-link-item" href="${frappe.utils.escape_html(url)}" target="_blank">
				<div class="wa-media-link-text">${frappe.utils.escape_html(m.message || '')}</div>
				<div class="wa-media-link-date">${this.format_bubble_time(m.creation)}</div>
			</a>
		`;
	}

	// Avatar + name (+ phone, when it isn't already the displayed name) in the
	// thread header — clickable to open the contact drawer, same as WhatsApp
	// Web's own header chip.
	render_thread_contact_chip(conversation, contact) {
		const name = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : (conversation.phone_number_display || conversation.name);
		const phone = conversation.phone_number_display || '';
		const avatar = contact && contact.image
			? `<img src="${frappe.utils.escape_html(contact.image)}">`
			: `<span>${frappe.utils.escape_html(this.avatar_initial(name))}</span>`;
		this.page.body.find('.wa-thread-title').html(`
			<span class="wa-thread-avatar" style="background:${this.avatar_color(name)};">${avatar}</span>
			<span>${frappe.utils.escape_html(name)}${phone && phone !== name ? ` <small class="text-muted">${frappe.utils.escape_html(phone)}</small>` : ''}</span>
		`);
	}

	// Group counterpart of render_thread_contact_chip -- subject + participant
	// count instead of a single contact's name/avatar/phone.
	render_thread_group_chip(group) {
		const count = group.total_participant_count || 0;
		const status_note = group.status !== 'Ativo' ? ` <small class="text-muted">(${frappe.utils.escape_html(group.status)})</small>` : '';
		this.page.body.find('.wa-thread-title').html(`
			<span class="wa-thread-avatar" style="background:${this.avatar_color(group.subject || group.name)};">${this.icon('users')}</span>
			<span>${frappe.utils.escape_html(group.subject || '')}${status_note}
				<br><small class="text-muted">${count} participante${count === 1 ? '' : 's'}</small>
			</span>
		`);
	}

	// "Dados do grupo" -- replaces the normal contact panel body (same drawer,
	// same toggle_contact_panel/close button) whenever the open conversation's
	// whatsapp_group is set. Pendente/Falhou are shown plainly since creation/
	// edits are asynchronous (see client/groups.py) -- the operator should never
	// be left guessing why a brand-new group isn't sending yet.
	render_group_panel(group) {
		this.page.body.find('.wa-contact-panel-header h5').text('Dados do grupo');
		const $panel = this.page.body.find('.wa-contact-panel-body');
		const pending = group.status === 'Pendente';

		$panel.html(`
			<h5>${frappe.utils.escape_html(group.subject || '')} <span class="wa-group-refresh" title="Atualizar" style="cursor:pointer;font-size:13px;">${this.icon('refresh')}</span></h5>
			${pending ? '<div class="indicator-pill blue">Pendente de confirmação da Meta</div>' : ''}
			${group.status === 'Falhou' ? `<div class="indicator-pill red" title="${frappe.utils.escape_html(group.error_message || '')}">Falhou${group.error_message ? ': ' + frappe.utils.escape_html(group.error_message) : ''}</div>` : ''}
			${group.description ? `<div class="wa-contact-field mt-2">${frappe.utils.escape_html(group.description)}</div>` : ''}
			<div class="wa-contact-field">${group.total_participant_count || 0}/${group.max_participants} participantes</div>

			${!pending ? '<div class="mt-2"><button class="btn btn-default btn-xs wa-group-edit">Editar assunto/descrição</button></div>' : ''}

			${!pending ? `
				<div class="mt-3"><label class="text-muted small">Link de convite</label><br>
					${group.invite_link ? `
						<div style="word-break:break-all;font-size:12px;">${frappe.utils.escape_html(group.invite_link)}</div>
						<button class="btn btn-default btn-xs mt-1 wa-group-invite-copy">Copiar</button>
					` : ''}
					<button class="btn btn-default btn-xs mt-1 wa-group-invite-reset">${group.invite_link ? 'Resetar' : 'Gerar link'}</button>
				</div>
			` : ''}

			${group.join_requests && group.join_requests.length ? `
				<div class="mt-3"><label class="text-muted small">Solicitações de entrada</label><br>
					${group.join_requests.map((jr) => `
						<div class="wa-role-chip" style="display:block;">
							${frappe.utils.escape_html(jr.wa_id || jr.id || '')}
							<span class="wa-group-join-approve" data-id="${frappe.utils.escape_html(jr.id || jr.request_id || '')}" title="Aprovar" style="cursor:pointer;color:var(--green-500,#2e7d32);margin-left:6px;">${this.icon('check')}</span>
							<span class="wa-group-join-reject" data-id="${frappe.utils.escape_html(jr.id || jr.request_id || '')}" title="Rejeitar" style="cursor:pointer;color:var(--red-500,#c62828);margin-left:4px;">${this.icon('x')}</span>
						</div>
					`).join('')}
				</div>
			` : ''}

			<div class="mt-3"><label class="text-muted small">Participantes (${group.participants.length})</label><br>
				${group.participants.map((p) => `
					<div class="wa-role-chip" style="display:block;">
						${frappe.utils.escape_html(p.profile_name || p.phone_number || p.wa_id || '')}
						<span class="wa-group-participant-remove remove" data-wa-id="${frappe.utils.escape_html(p.wa_id)}" title="Remover">×</span>
					</div>
				`).join('') || '<div class="text-muted small">Nenhum participante ainda</div>'}
			</div>
		`);
	}

	refresh_group_panel() {
		if (!this.current_group_panel) return;
		frappe.call({
			method: 'takion_whatsapp.client.groups.refresh_group',
			args: { name: this.current_group_panel.name },
		}).then(() => this.load_contact_panel(this.current_conversation));
	}

	open_edit_group_dialog() {
		const group = this.current_group_panel;
		if (!group) return;
		const dialog = new frappe.ui.Dialog({
			title: 'Editar grupo',
			fields: [
				{ fieldname: 'subject', label: 'Assunto', fieldtype: 'Data', reqd: 1, default: group.subject },
				{ fieldname: 'description', label: 'Descrição', fieldtype: 'Small Text', default: group.description },
			],
			primary_action_label: 'Salvar',
			primary_action: (values) => {
				frappe.call({
					method: 'takion_whatsapp.client.groups.update_group',
					args: { name: group.name, subject: values.subject, description: values.description },
				}).then(() => {
					dialog.hide();
					this.load_contact_panel(this.current_conversation);
					this.refresh_conversations();
				});
			},
		});
		dialog.show();
	}

	copy_group_invite_link() {
		if (this.current_group_panel && this.current_group_panel.invite_link) {
			frappe.utils.copy_to_clipboard(this.current_group_panel.invite_link);
		}
	}

	reset_group_invite_link() {
		if (!this.current_group_panel) return;
		frappe.call({
			method: 'takion_whatsapp.client.groups.reset_invite_link',
			args: { name: this.current_group_panel.name },
		}).then(() => this.load_contact_panel(this.current_conversation));
	}

	remove_group_participant(wa_id) {
		const group = this.current_group_panel;
		if (!group) return;
		frappe.confirm(__('Remover este participante do grupo?'), () => {
			frappe.call({
				method: 'takion_whatsapp.client.groups.remove_participants',
				args: { name: group.name, wa_ids: [wa_id] },
			}).then(() => this.load_contact_panel(this.current_conversation));
		});
	}

	resolve_group_join_request(id, approve) {
		const group = this.current_group_panel;
		if (!group) return;
		frappe.call({
			method: `takion_whatsapp.client.groups.${approve ? 'approve_join_requests' : 'reject_join_requests'}`,
			args: { name: group.name, join_request_ids: [id] },
		}).then(() => this.load_contact_panel(this.current_conversation));
	}

	toggle_contact_panel(force) {
		const $panel = this.page.body.find('.wa-contact-panel');
		const show = force !== undefined ? force : !$panel.hasClass('open');
		$panel.toggleClass('open', show);
	}

	link_bare_conversation_to_contact() {
		const conversation = this.current_conversation;
		if (!conversation) return;

		frappe.db.get_doc('WhatsApp Conversation', conversation).then((conv) => {
			this.open_new_contact_dialog(conv.wa_id, (contact_name) => {
				frappe.db.set_value('WhatsApp Conversation', conversation, 'contact', contact_name).then(() => {
					this.load_contact_panel(conversation);
					this.refresh_conversations();
				});
			});
		});
	}

	// Shared by the "Novo Contato" toolbar button and by linking a bare-number
	// conversation to a Contact after the fact — same dedup pipeline either way,
	// just a different entry point and an optional callback for the caller.
	open_new_contact_dialog(prefill_phone, on_created) {
		const dialog = new frappe.ui.Dialog({
			title: 'Novo Contato',
			fields: [
				{ fieldname: 'phone', label: 'Telefone', fieldtype: 'Data', reqd: 1, default: prefill_phone || '' },
				{ fieldname: 'first_name', label: 'Nome', fieldtype: 'Data' },
				{ fieldname: 'results', fieldtype: 'HTML' },
			],
			primary_action_label: 'Criar Contato',
			primary_action: (values) => {
				frappe.call({
					method: 'takion_whatsapp.client.contacts.find_contact_by_phone',
					args: { raw_number: values.phone },
				}).then((r) => {
					if (r.message) {
						frappe.msgprint('Já existe um contato para esse número — nada foi criado para evitar duplicidade.');
						return;
					}
					frappe.call({
						method: 'takion_whatsapp.client.contacts.create_contact',
						args: { raw_number: values.phone, first_name: values.first_name },
					}).then((created) => {
						dialog.hide();
						const contact_name = created.message;
						this.open_role_picker(contact_name, () => {}, values.phone);
						if (on_created) on_created(contact_name);
					});
				});
			},
		});
		dialog.show();
	}

	open_new_conversation_dialog() {
		frappe.call({ method: 'frappe.client.get_list', args: { doctype: 'WhatsApp Channel', fields: ['name'] } }).then((r) => {
			const channels = r.message || [];
			const dialog = new frappe.ui.Dialog({
				title: 'Nova Conversa',
				fields: [
					{ fieldname: 'channel', label: 'Canal', fieldtype: 'Select', reqd: 1, options: channels.map((c) => c.name).join('\n'), default: channels[0] && channels[0].name },
					{ fieldname: 'target_type', label: 'Destino', fieldtype: 'Select', reqd: 1, options: 'Contato existente\nNúmero novo', default: 'Contato existente' },
					{ fieldname: 'contact', label: 'Contato', fieldtype: 'Link', options: 'Contact', depends_on: 'eval:doc.target_type=="Contato existente"' },
					{ fieldname: 'phone', label: 'Telefone', fieldtype: 'Data', depends_on: 'eval:doc.target_type=="Número novo"' },
					{ fieldname: 'template', label: 'Template aprovado', fieldtype: 'Select', reqd: 1, options: [] },
				],
				primary_action_label: 'Iniciar',
				primary_action: (values) => {
					frappe.call({
						method: 'takion_whatsapp.client.inbox.start_conversation',
						args: {
							channel: values.channel,
							contact: values.target_type === 'Contato existente' ? values.contact : null,
							phone: values.target_type === 'Número novo' ? values.phone : null,
							template: values.template,
						},
					}).then((r) => {
						dialog.hide();
						this.refresh_conversations();
						this.open_conversation(r.message);
					});
				},
			});

			const refresh_templates = () => {
				const channel = dialog.get_value('channel');
				if (!channel) return;
				frappe.call({ method: 'takion_whatsapp.client.inbox.list_templates', args: { channel } }).then((tr) => {
					const templates = tr.message || [];
					dialog.set_df_property('template', 'options', templates.map((t) => t.name).join('\n'));
					if (templates.length) dialog.set_value('template', templates[0].name);
				});
			};
			dialog.fields_dict.channel.df.onchange = refresh_templates;
			dialog.show();
			refresh_templates();
		});
	}

	// Group creation is asynchronous on Meta's side (see client/groups.py's module
	// docstring) -- this dialog only submits the request; the group itself only
	// shows up in the conversation list once client/groups.py confirms it (webhook
	// or the periodic safety-net sweep), via the same whatsapp_inbox_update
	// realtime event every other flow already listens for.
	open_new_group_dialog() {
		frappe.call({ method: 'frappe.client.get_list', args: { doctype: 'WhatsApp Channel', fields: ['name'] } }).then((r) => {
			const channels = r.message || [];
			const dialog = new frappe.ui.Dialog({
				title: 'Novo Grupo',
				fields: [
					{ fieldname: 'channel', label: 'Canal', fieldtype: 'Select', reqd: 1, options: channels.map((c) => c.name).join('\n'), default: channels[0] && channels[0].name },
					{ fieldname: 'subject', label: 'Assunto', fieldtype: 'Data', reqd: 1 },
					{ fieldname: 'description', label: 'Descrição', fieldtype: 'Small Text' },
					{
						fieldname: 'join_approval_mode', label: 'Aprovação de entrada', fieldtype: 'Select', reqd: 1,
						options: 'auto_approve\napproval_required', default: 'auto_approve',
						description: 'Não pode ser alterado depois da criação.',
					},
				],
				primary_action_label: 'Criar',
				primary_action: (values) => {
					frappe.call({
						method: 'takion_whatsapp.client.groups.create_group',
						args: values,
					}).then(() => {
						dialog.hide();
						frappe.show_alert({
							message: __('Grupo em criação — a Meta confirma isso de forma assíncrona, pode levar alguns instantes até aparecer na lista.'),
							indicator: 'blue',
						});
					});
				},
			});
			dialog.show();
		});
	}

	// Reusable "+ add role" picker: search an existing Customer/Supplier/Employee/
	// Lead/Opportunity/Prospect to link, or create a new one via Frappe's own
	// quick-entry (so mandatory fields per doctype — e.g. Employee's — are always
	// respected). Used both from the contact panel's "+" badge and right after
	// "Novo Contato" creates a bare Contact with no roles yet.
	open_role_picker(contact, on_linked, suggest_phone) {
		const dialog = new frappe.ui.Dialog({
			title: 'Vincular papel',
			fields: [
				{ fieldname: 'link_doctype', label: 'Tipo', fieldtype: 'Select', reqd: 1, options: 'Customer\nSupplier\nEmployee\nLead\nOpportunity\nProspect' },
				{ fieldname: 'search', label: 'Buscar existente', fieldtype: 'Data' },
				{ fieldname: 'results', fieldtype: 'HTML' },
			],
			primary_action_label: 'Criar novo',
			primary_action: () => {
				const link_doctype = dialog.get_value('link_doctype');
				dialog.hide();

				// Lead's own controller (LeadMixin, see client/pipeline.py) dedups
				// against an existing Contact by whatsapp_no/mobile_no/phone before
				// creating a new one — prefilling whatsapp_no here is what lets that
				// dedup find THIS Contact instead of spawning a disconnected one.
				let quick_entry_doc = null;
				if (link_doctype === 'Lead' && suggest_phone) {
					quick_entry_doc = frappe.model.get_new_doc('Lead');
					quick_entry_doc.whatsapp_no = suggest_phone;
				}

				// frappe.new_doc's public callback only fires on load, not after save —
				// make_quick_entry's `after_insert` is the one that fires post-save, with
				// the created doc, which is what we need to link right after creation.
				frappe.ui.form.make_quick_entry(link_doctype, (doc) => {
					frappe.call({
						method: 'takion_whatsapp.client.contacts.link_existing_role',
						args: { contact, link_doctype, link_name: doc.name },
					}).then(() => on_linked());
				}, null, quick_entry_doc);
			},
		});

		const $results = () => $(dialog.fields_dict.results.wrapper);

		const render_results = (rows, on_pick) => {
			if (!rows.length) {
				$results().html('<div class="wa-role-picker-empty">Nenhum resultado</div>');
				return;
			}
			const $list = $('<div class="wa-role-picker-results"></div>');
			rows.forEach((row) => {
				$(`<div class="wa-role-picker-result">${frappe.utils.escape_html(row.title || row.name)}</div>`)
					.on('click', () => on_pick(row))
					.appendTo($list);
			});
			$results().html($list);
		};

		const run_search = frappe.utils.debounce(() => {
			const link_doctype = dialog.get_value('link_doctype');
			const txt = dialog.get_value('search') || '';
			frappe.call({
				method: 'takion_whatsapp.client.contacts.search_linkable',
				args: { link_doctype, txt },
			}).then((r) => {
				render_results(r.message || [], (row) => {
					frappe.call({
						method: 'takion_whatsapp.client.contacts.link_existing_role',
						args: { contact, link_doctype, link_name: row.name },
					}).then(() => {
						dialog.hide();
						on_linked();
					});
				});
			});
		}, 300);

		dialog.fields_dict.link_doctype.df.onchange = () => {
			if (dialog.get_value('link_doctype') === 'Employee' && suggest_phone) {
				frappe.call({
					method: 'takion_whatsapp.client.contacts.find_party_matches',
					args: { raw_number: suggest_phone },
				}).then((r) => render_results(r.message || [], (row) => {
					frappe.call({
						method: 'takion_whatsapp.client.contacts.link_existing_role',
						args: { contact, link_doctype: row.doctype, link_name: row.name },
					}).then(() => {
						dialog.hide();
						on_linked();
					});
				}));
			} else {
				run_search();
			}
		};
		dialog.fields_dict.search.df.onchange = run_search;

		dialog.show();
		dialog.set_value('link_doctype', 'Customer');
	}
};
