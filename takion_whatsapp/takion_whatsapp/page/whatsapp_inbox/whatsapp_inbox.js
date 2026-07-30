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
// Distinct from stickers (WebP image messages, a real gap — see
// [[takion_whatsapp_feature_backlog]]).
const WA_EMOJI_CATEGORY_ICONS = ['😀', '👋', '🐶', '🍔', '✈️', '⚽', '💡', '🔣', '🚩'];

takion_whatsapp.WhatsAppInbox = class WhatsAppInbox {
	constructor(page) {
		this.page = page;
		this.current_conversation = null;
		this.filters = { status: [], tag: '', assigned_to: '' };
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
		this.MEDIA_MAX_BYTES = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, document: 100 * 1024 * 1024 };
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

	inject_styles() {
		if ($('#whatsapp-inbox-styles').length) return;
		$(`<style id="whatsapp-inbox-styles">
			/* height: calc(100vh - 180px) fallback for the instant before JS measures the
			   real available space (resize_layout()) — 180px is only a guess at how tall
			   Frappe's own navbar/breadcrumb chrome is, and doesn't hold for every zoom
			   level/window size, leaving unused page background below the widget when it
			   overestimates. resize_layout() always overrides this with a real measurement. */
			.whatsapp-inbox { display: flex; height: calc(100vh - 180px); border: 1px solid var(--border-color); border-radius: var(--border-radius); overflow: hidden; }
			.wa-conversations { width: 300px; border-right: 1px solid var(--border-color); display: flex; flex-direction: column; overflow: hidden; }
			.wa-conversations-filters { padding: 8px; display: flex; gap: 4px; border-bottom: 1px solid var(--border-color); }
			.wa-conversations-filters select, .wa-conversations-filters input { font-size: 12px; padding: 2px 4px; }
			.wa-conversations-list { flex: 1; overflow-y: auto; }
			.wa-conversation-item { padding: 10px 12px; border-bottom: 1px solid var(--border-color); cursor: pointer; }
			.wa-conversation-item:hover { background: var(--fg-hover-color); }
			.wa-conversation-item.active { background: var(--fg-hover-color); }
			.wa-conversation-title { font-weight: 600; display: flex; justify-content: space-between; }
			.wa-conversation-time { font-weight: 400; font-size: 11px; color: var(--text-muted); }
			.wa-conversation-preview { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.wa-conversation-meta { margin-top: 4px; display: flex; gap: 4px; align-items: center; }
			.wa-thread { flex: 1; display: flex; flex-direction: column; background: var(--subtle-fg); min-width: 0; }
			.wa-thread-header { padding: 10px 14px; border-bottom: 1px solid var(--border-color); font-weight: 600; }
			.wa-thread-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 6px; }
			.wa-bubble-row { display: flex; }
			.wa-bubble-row.out { justify-content: flex-end; }
			/* Bubble/checkmark colors below are placeholders only — final palette will be
			   set later during the Takion frontend refinement pass, not WhatsApp's own. */
			.wa-bubble { max-width: 65%; padding: 6px 9px; border-radius: 8px; background: var(--card-bg, #fff); box-shadow: 0 1px 1px rgba(0,0,0,.08); }
			.wa-bubble-row.out .wa-bubble { background: var(--gray-100, #eee); }
			.wa-bubble-text { white-space: pre-wrap; word-break: break-word; font-size: 13px; }
			.wa-bubble-time { text-align: right; font-size: 10px; color: var(--text-muted); margin-top: 2px; }
			.wa-bubble-time .wa-check { margin-left: 3px; }
			.wa-check-read { color: var(--blue-500, #2490ef); }
			.wa-audio-bubble { display: flex; align-items: center; gap: 8px; min-width: 220px; }
			.wa-audio-play { width: 30px; height: 30px; border-radius: 50%; background: var(--gray-500); color: #fff; border: none; flex-shrink: 0; }
			.wa-audio-wave { flex: 1; height: 24px; }
			.wa-audio-duration { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
			.wa-thread-compose { padding: 10px; border-top: 1px solid var(--border-color); }
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
			.wa-compose-mic, .wa-compose-send, .wa-compose-attach, .wa-record-cancel, .wa-record-stop,
			.wa-preview-play, .wa-preview-cancel, .wa-preview-send,
			.wa-media-cancel, .wa-media-send {
				width: 34px; height: 34px; padding: 0; flex-shrink: 0;
				display: flex; align-items: center; justify-content: center;
				border-radius: 50%; line-height: 1;
			}
			.wa-media-preview { flex-shrink: 0; }
			.wa-media-preview img, .wa-media-preview video { max-height: 40px; max-width: 60px; border-radius: 4px; display: block; }
			.wa-media-preview span { font-size: 12px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
			.wa-compose-media-row .wa-media-caption { flex: 1; }
			.wa-record-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--red-500, #e03131); flex-shrink: 0; animation: wa-record-pulse 1.2s infinite; }
			@keyframes wa-record-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
			.wa-record-timer, .wa-preview-duration { font-size: 12px; color: var(--text-muted); flex-shrink: 0; min-width: 34px; }
			.wa-record-wave, .wa-preview-wave { flex: 1; height: 34px; }
			.wa-optimistic-audio .wa-bubble-text { font-style: italic; }
			/* Collapsed by default (display:none) — opened by clicking the contact chip
			   in the thread header, closed via its own × button, same interaction as
			   WhatsApp Web's "Dados do contato" panel (a real column, not an overlay:
			   .wa-thread's flex:1 already reclaims the width the instant this hides). */
			.wa-contact-panel { display: none; width: 300px; border-left: 1px solid var(--border-color); padding: 14px; overflow-y: auto; }
			.wa-contact-panel h5 { margin-bottom: 2px; }
			.wa-contact-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
			.wa-contact-panel-header h5 { margin: 0; }
			.wa-contact-panel-close { cursor: pointer; font-size: 20px; line-height: 1; color: var(--text-muted); padding: 0 4px; }
			.wa-contact-panel-close:hover { color: var(--text-color); }
			.wa-thread-title { cursor: pointer; display: flex; align-items: center; gap: 8px; }
			.wa-thread-avatar {
				width: 32px; height: 32px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
				background: var(--gray-500, #888); color: #fff; display: flex; align-items: center;
				justify-content: center; font-size: 14px; font-weight: 600;
			}
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
			}
			.wa-media-tab.active { color: var(--text-color); border-bottom-color: var(--primary, #5b8def); font-weight: 600; }
			.wa-media-link-item { display: block; padding: 8px 2px; border-bottom: 1px solid var(--border-color); font-size: 12px; }
			.wa-media-link-text { word-break: break-word; }
			.wa-media-link-date { color: var(--text-muted); font-size: 11px; margin-top: 2px; }
			.wa-contact-field { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
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
			.wa-search-group { border-bottom: 1px solid var(--border-color); padding: 6px 0; }
			.wa-search-group-title { font-weight: 600; font-size: 12px; padding: 4px 12px; }
			.wa-search-result { padding: 4px 12px; font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.wa-search-result:hover { background: var(--fg-hover-color); }
			.wa-search-match { background: var(--yellow-200, #fff3b0); border-radius: 2px; }
			.wa-active-match-row .wa-bubble { outline: 2px solid var(--orange-400, #ff9f43); }
			.wa-thread-header-top { display: flex; justify-content: space-between; align-items: center; }
			.wa-bubble-img { cursor: zoom-in; }
			.wa-lightbox-overlay {
				position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 1100;
				display: flex; align-items: center; justify-content: center; cursor: zoom-out;
			}
			.wa-lightbox-overlay img { max-width: 90vw; max-height: 90vh; border-radius: 4px; box-shadow: 0 4px 24px rgba(0,0,0,.5); }
			.wa-sandbox-banner { background: var(--yellow-100, #fff9db); border-bottom: 1px solid var(--border-color); padding: 6px 10px; font-size: 12px; }
			.wa-sandbox-banner button { margin-left: 6px; }
			.wa-emoji-picker-wrap { position: relative; }
			.wa-emoji-picker {
				position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 10;
				background: var(--card-bg, #fff); border: 1px solid var(--border-color);
				border-radius: var(--border-radius); width: 260px; max-height: 260px;
				box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.15));
				display: flex; flex-direction: column; overflow: hidden;
			}
			.wa-emoji-tabs { display: flex; border-bottom: 1px solid var(--border-color); padding: 4px; flex-shrink: 0; }
			.wa-emoji-tab { flex: 1; text-align: center; cursor: pointer; padding: 4px 0; border-radius: 4px; font-size: 15px; }
			.wa-emoji-tab:hover { background: var(--fg-hover-color); }
			.wa-emoji-tab.active { background: var(--fg-hover-color); }
			.wa-emoji-grid { flex: 1; overflow-y: auto; padding: 6px; display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; align-content: start; }
			.wa-emoji-option { cursor: pointer; text-align: center; padding: 3px; border-radius: 4px; font-size: 16px; line-height: 1.4; }
			.wa-emoji-option:hover { background: var(--fg-hover-color); }
			.wa-emoji-loading { padding: 10px; font-size: 12px; color: var(--text-muted); }
			.wa-status-filter { position: relative; }
			.wa-status-filter-toggle { white-space: nowrap; }
			.wa-status-filter-menu {
				position: absolute; top: 100%; left: 0; z-index: 10; margin-top: 2px;
				background: var(--card-bg, #fff); border: 1px solid var(--border-color);
				border-radius: var(--border-radius); padding: 4px 0; min-width: 170px;
				box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.15));
			}
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
					<div class="wa-conversations-toolbar" style="padding: 8px; display: flex; gap: 4px; border-bottom: 1px solid var(--border-color);">
						<button class="btn btn-default btn-sm wa-new-contact" style="flex:1;">+ Novo Contato</button>
						<button class="btn btn-default btn-sm wa-new-conversation" style="flex:1;">+ Nova Conversa</button>
						${this.is_system_manager ? '<button class="btn btn-default btn-sm wa-open-sandbox" style="flex:1;" title="Conversa de teste, sem depender do número real da Meta">🧪 Sandbox</button>' : ''}
					</div>
					<div class="wa-conversations-search">
						<input class="form-control form-control-sm wa-global-search-input" placeholder="🔍 Buscar em todas as conversas">
					</div>
					<div class="wa-conversations-filters">
						<div class="wa-status-filter">
							<button type="button" class="btn btn-default btn-sm wa-status-filter-toggle">Status: Todos</button>
							<div class="wa-status-filter-menu" style="display:none;">
								<label class="wa-status-filter-option"><input type="checkbox" value="Novo"> Novo</label>
								<label class="wa-status-filter-option"><input type="checkbox" value="Em andamento"> Em andamento</label>
								<label class="wa-status-filter-option"><input type="checkbox" value="Aguardando cliente"> Aguardando cliente</label>
								<label class="wa-status-filter-option"><input type="checkbox" value="Resolvido"> Resolvido</label>
							</div>
						</div>
						<input class="form-control wa-filter-tag" placeholder="Tag">
						<input class="form-control wa-filter-agent" placeholder="Agente">
					</div>
					<div class="wa-conversations-list"></div>
				</div>
				<div class="wa-thread">
					<div class="wa-thread-header">
						<div class="wa-thread-header-top">
							<span class="wa-thread-title"><span class="wa-empty-state" style="height:auto;">Selecione uma conversa</span></span>
							<button class="btn btn-default btn-xs wa-thread-search-toggle" style="display:none;" title="Buscar nesta conversa">🔍</button>
						</div>
						<div class="wa-thread-search-bar" style="display:none;">
							<input class="form-control form-control-sm wa-thread-search-input" placeholder="Buscar nesta conversa">
							<span class="wa-thread-search-counter">0/0</span>
							<button class="btn btn-default btn-xs wa-thread-search-prev" title="Anterior">↑</button>
							<button class="btn btn-default btn-xs wa-thread-search-next" title="Próxima">↓</button>
							<button class="btn btn-default btn-xs wa-thread-search-close" title="Fechar">×</button>
						</div>
						<div class="wa-sandbox-banner" style="display:none;">
							🧪 Conversa de sandbox — envio real (texto/áudio/imagem/vídeo/documento) só
							funciona depois de configurar uma WhatsApp Account real (aguardando número
							de teste da Meta).
							${this.is_system_manager ? `
								<button class="btn btn-default btn-xs wa-sandbox-simulate">Simular recebimento</button>
								<button class="btn btn-default btn-xs wa-sandbox-clear">Limpar mensagens de teste</button>
							` : ''}
						</div>
					</div>
					<div class="wa-thread-messages"></div>
					<div class="wa-thread-compose" style="display:none;">
						<div class="wa-compose-row wa-compose-text-row">
							<textarea class="form-control wa-compose-input" rows="1" placeholder="Digite uma mensagem"></textarea>
							<div class="wa-emoji-picker-wrap">
								<button class="btn btn-default btn-sm wa-compose-emoji" title="Emoji">😀</button>
								<div class="wa-emoji-picker" style="display:none;"></div>
							</div>
							<button class="btn btn-default btn-sm wa-compose-attach" title="Anexar imagem, vídeo ou documento">📎</button>
							<input type="file" class="wa-media-file-input" style="display:none;">
							<button class="btn btn-default btn-sm wa-compose-mic" title="Gravar áudio">🎤</button>
							<button class="btn btn-primary btn-sm wa-compose-send" style="display:none;" title="Enviar">➤</button>
						</div>
						<div class="wa-compose-row wa-compose-record-row" style="display:none;">
							<span class="wa-record-dot"></span>
							<span class="wa-record-timer">0:00</span>
							<div class="wa-record-wave"></div>
							<button class="btn btn-default btn-sm wa-record-cancel" title="Cancelar gravação">🗑</button>
							<button class="btn btn-primary btn-sm wa-record-stop" title="Parar gravação">⏹</button>
						</div>
						<div class="wa-compose-row wa-compose-preview-row" style="display:none;">
							<button class="btn btn-default btn-sm wa-preview-play" title="Ouvir">▶</button>
							<div class="wa-preview-wave"></div>
							<span class="wa-preview-duration">0:00</span>
							<button class="btn btn-default btn-sm wa-preview-cancel" title="Descartar">🗑</button>
							<button class="btn btn-primary btn-sm wa-preview-send" title="Enviar áudio">➤</button>
						</div>
						<div class="wa-compose-row wa-compose-media-row" style="display:none;">
							<div class="wa-media-preview"></div>
							<input class="form-control form-control-sm wa-media-caption" placeholder="Legenda (opcional)">
							<button class="btn btn-default btn-sm wa-media-cancel" title="Descartar">🗑</button>
							<button class="btn btn-primary btn-sm wa-media-send" title="Enviar">➤</button>
						</div>
					</div>
				</div>
				<div class="wa-contact-panel">
					<div class="wa-contact-panel-header">
						<h5>Dados do contato</h5>
						<span class="wa-contact-panel-close" title="Fechar">×</span>
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
			this.page.body.find('.wa-status-filter-menu').toggle();
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
		main.on('click', '.wa-compose-emoji', (e) => {
			e.stopPropagation();
			this.toggle_emoji_picker();
		});
		main.on('click', '.wa-emoji-picker', (e) => e.stopPropagation());
		main.on('click', '.wa-emoji-tab', (e) => this.render_emoji_picker(+$(e.currentTarget).data('index')));
		main.on('click', '.wa-emoji-option', (e) => this.insert_emoji_at_cursor($(e.currentTarget).text()));
		// Closes any open dropdown (status filter, emoji picker) on a click outside
		// it — namespaced since this page instance is created once per session and
		// never torn down (same as every other listener in this class).
		$(document).on('click.wa-dropdowns', () => {
			this.page.body.find('.wa-status-filter-menu, .wa-emoji-picker').hide();
		});
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

		main.on('click', '.wa-compose-attach', () => this.page.body.find('.wa-media-file-input').trigger('click'));
		main.on('change', '.wa-media-file-input', (e) => this.on_media_file_selected(e.target.files[0]));
		main.on('click', '.wa-media-cancel', () => this.discard_media());
		main.on('click', '.wa-media-send', () => this.send_media());

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
			this.refresh_conversations();
			if (data.conversation && data.conversation === this.current_conversation) {
				this.load_thread(this.current_conversation);
			}
		});
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
					options: ['text', 'image', 'video', 'document', 'audio'].join('\n'),
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
			const when = c.last_message_at ? frappe.datetime.str_to_user(c.last_message_at, true) : '';
			const active = c.name === this.current_conversation ? ' active' : '';
			const direction_icon = c.last_direction === 'Outbound' ? '↗' : '↙';
			const tags = (c._user_tags || '').split(',').map((t) => t.trim()).filter(Boolean);
			let assignees = [];
			try { assignees = JSON.parse(c._assign || '[]'); } catch (e) { assignees = []; }

			return `
				<div class="wa-conversation-item${active}" data-name="${c.name}">
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
		this.pending_jump_message = jump_to_message || null;
		this.thread_search_query = '';
		this.thread_search_matches = [];
		this.thread_search_index = -1;
		this.page.body.find('.wa-thread-search-bar').hide();
		this.page.body.find('.wa-thread-search-input').val('');
		this.page.body.find('.wa-conversation-item').removeClass('active');
		this.page.body.find(`.wa-conversation-item[data-name="${name}"]`).addClass('active');
		this.page.body.find('.wa-thread-compose').show();
		this.page.body.find('.wa-compose-input').val('');
		this.autosize_compose_input();
		this.update_compose_buttons();

		this.load_thread(name);
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
				$button.text('▶');
				$duration.text(this.format_duration(ws.getDuration()));
			});

			$button.on('click', () => {
				this.waveforms.filter((w) => w !== ws).forEach((w) => w.pause());
				this.page.body.find('.wa-audio-play').not($button).text('▶');
				ws.playPause();
				$button.text(ws.isPlaying() ? '⏸' : '▶');
			});

			this.waveforms.push(ws);
		});
	}

	render_message(msg) {
		const out = msg.type === 'Outgoing';
		const time = frappe.datetime.str_to_user(msg.creation, true);
		const check = out ? this.render_check(msg.status) : '';
		const body = msg.content_type === 'audio'
			? this.render_audio_bubble(msg)
			: this.render_generic_bubble(msg);

		return `
			<div class="wa-bubble-row ${out ? 'out' : 'in'}" data-message="${frappe.utils.escape_html(msg.name)}">
				<div class="wa-bubble">
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
		if (status === 'read') return ' <span class="wa-check wa-check-read">✓✓</span>';
		if (status === 'delivered') return ' <span class="wa-check">✓✓</span>';
		if (status === 'failed') return ' <span class="wa-check text-danger">!</span>';
		return ' <span class="wa-check">✓</span>';
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
		if (msg.content_type === 'image' && msg.attach) {
			return `<img class="wa-bubble-img" src="${frappe.utils.escape_html(msg.attach)}" style="max-width:220px;border-radius:4px;">${caption}`;
		}
		if (msg.content_type === 'video' && msg.attach) {
			return `<video src="${frappe.utils.escape_html(msg.attach)}" controls style="max-width:220px;border-radius:4px;"></video>${caption}`;
		}
		if (msg.attach && msg.content_type === 'document') {
			return `<a href="${frappe.utils.escape_html(msg.attach)}" target="_blank">📎 ${frappe.utils.escape_html(msg.attach.split('/').pop())}</a>`;
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
				<button class="wa-audio-play">▶</button>
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
	async toggle_emoji_picker() {
		const $picker = this.page.body.find('.wa-emoji-picker');
		if ($picker.is(':visible')) {
			$picker.hide();
			return;
		}
		if (!this.emoji_categories) {
			$picker.html('<div class="wa-emoji-loading">Carregando…</div>').show();
			try {
				const res = await fetch('/assets/takion_whatsapp/js/lib/emoji-data.json');
				this.emoji_categories = await res.json();
			} catch (e) {
				$picker.html('<div class="wa-emoji-loading">Não foi possível carregar os emojis.</div>');
				return;
			}
		}
		this.render_emoji_picker(this.emoji_active_category || 0);
		$picker.show();
	}

	render_emoji_picker(category_index) {
		this.emoji_active_category = category_index;
		const $picker = this.page.body.find('.wa-emoji-picker');
		const tabs = this.emoji_categories
			.map((cat, i) => `<span class="wa-emoji-tab${i === category_index ? ' active' : ''}" data-index="${i}" title="${frappe.utils.escape_html(cat.name)}">${WA_EMOJI_CATEGORY_ICONS[i] || '•'}</span>`)
			.join('');
		const grid = this.emoji_categories[category_index].emojis
			.map(([emoji, name]) => `<span class="wa-emoji-option" title="${frappe.utils.escape_html(name)}">${emoji}</span>`)
			.join('');
		$picker.html(`<div class="wa-emoji-tabs">${tabs}</div><div class="wa-emoji-grid">${grid}</div>`);
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
			this.page.body.find('.wa-preview-play').text('▶');
			$duration.text(this.format_duration(ws.getDuration()));
		});

		this.preview_wavesurfer = ws;
	}

	toggle_preview_playback() {
		if (!this.preview_wavesurfer) return;
		this.preview_wavesurfer.playPause();
		this.page.body.find('.wa-preview-play').text(this.preview_wavesurfer.isPlaying() ? '⏸' : '▶');
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
				<div class="wa-bubble"><div class="wa-bubble-text text-muted">🎙️ ${__('Enviando áudio…')}</div></div>
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

		// Anything that isn't image/video goes through as a generic WhatsApp
		// "document" — frappe_whatsapp already sends/receives that content_type
		// exactly like image/video (link + caption), just with a bigger size cap.
		const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'document';
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

		if (kind === 'document') {
			this._media_preview_url = null;
			$preview.append(`<span title="${frappe.utils.escape_html(file.name)}">📄 ${frappe.utils.escape_html(file.name)}</span>`);
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
				return frappe.call({
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
		const icon = kind === 'image' ? '🖼️' : kind === 'video' ? '🎬' : '📄';
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
			this.page.body.find('.wa-sandbox-banner').toggle(conversation.phone_number === SANDBOX_PHONE_NUMBER);
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
		const $panel = this.page.body.find('.wa-contact-panel-body');
		const tags = (conversation._user_tags || '').split(',').map((t) => t.trim()).filter(Boolean);
		let assignees = [];
		try { assignees = JSON.parse(conversation._assign || '[]'); } catch (e) { assignees = []; }

		const name = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : conversation.phone_number_display;
		const role_labels = { Customer: 'Cliente', Supplier: 'Fornecedor', Employee: 'Funcionário', Lead: 'Lead', Opportunity: 'Oportunidade', Prospect: 'Prospect' };
		const paper_roles = roles.filter((r) => !WA_FUNNEL_DOCTYPES.includes(r.doctype));

		$panel.html(`
			<h5>${frappe.utils.escape_html(name || '')}</h5>
			<div class="wa-contact-field">${frappe.utils.escape_html(conversation.phone_number_display || '')}</div>
			${contact && contact.email_id ? `<div class="wa-contact-field">${frappe.utils.escape_html(contact.email_id)}</div>` : ''}
			${contact && contact.company_name ? `<div class="wa-contact-field">${frappe.utils.escape_html(contact.company_name)}</div>` : ''}

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
		const icon = m.content_type === 'video' ? '🎬' : '📄';
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
				<div class="wa-media-link-date">${frappe.datetime.str_to_user(m.creation, true)}</div>
			</a>
		`;
	}

	// Avatar + name (+ phone, when it isn't already the displayed name) in the
	// thread header — clickable to open the contact drawer, same as WhatsApp
	// Web's own header chip.
	render_thread_contact_chip(conversation, contact) {
		const name = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : (conversation.phone_number_display || conversation.name);
		const phone = conversation.phone_number_display || '';
		// Array.from (not charAt(0)) so a name starting with a surrogate-pair
		// character (an emoji, e.g. the sandbox's own "🧪 Sandbox de Teste") yields
		// the whole glyph instead of a mangled half-surrogate.
		const initial = Array.from((name || '?').trim())[0].toUpperCase();
		const avatar = contact && contact.image
			? `<img src="${frappe.utils.escape_html(contact.image)}">`
			: `<span>${frappe.utils.escape_html(initial)}</span>`;
		this.page.body.find('.wa-thread-title').html(`
			<span class="wa-thread-avatar">${avatar}</span>
			<span>${frappe.utils.escape_html(name)}${phone && phone !== name ? ` <small class="text-muted">${frappe.utils.escape_html(phone)}</small>` : ''}</span>
		`);
	}

	toggle_contact_panel(force) {
		const $panel = this.page.body.find('.wa-contact-panel');
		const show = force !== undefined ? force : !$panel.is(':visible');
		$panel.toggle(show);
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
