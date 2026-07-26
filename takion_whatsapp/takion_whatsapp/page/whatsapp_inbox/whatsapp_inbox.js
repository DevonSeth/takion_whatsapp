frappe.pages['whatsapp-inbox'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'WhatsApp Inbox',
		single_column: true,
	});

	new takion_whatsapp.WhatsAppInbox(page);
};

frappe.provide('takion_whatsapp');

takion_whatsapp.WhatsAppInbox = class WhatsAppInbox {
	constructor(page) {
		this.page = page;
		this.current_conversation = null;
		this.filters = { status: '', tag: '', assigned_to: '' };

		this.inject_styles();
		this.make_layout();
		this.bind_events();
		this.setup_realtime();
		this.refresh_conversations();
	}

	inject_styles() {
		if ($('#whatsapp-inbox-styles').length) return;
		$(`<style id="whatsapp-inbox-styles">
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
			.wa-audio-wave { flex: 1; height: 24px; display: flex; align-items: center; gap: 1.5px; }
			.wa-audio-wave span { width: 2px; background: var(--gray-400); border-radius: 1px; }
			.wa-audio-duration { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
			.wa-thread-compose { padding: 10px; border-top: 1px solid var(--border-color); display: flex; gap: 8px; }
			.wa-thread-compose textarea { flex: 1; resize: none; }
			.wa-contact-panel { width: 260px; border-left: 1px solid var(--border-color); padding: 14px; overflow-y: auto; }
			.wa-contact-panel h5 { margin-bottom: 2px; }
			.wa-contact-field { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
			.wa-tag-chip, .wa-assign-chip { display: inline-flex; align-items: center; background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 10px; padding: 1px 8px; font-size: 11px; margin: 2px 4px 2px 0; }
			.wa-tag-chip .remove, .wa-assign-chip .remove { cursor: pointer; margin-left: 5px; color: var(--text-muted); }
			.wa-empty-state { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); }
		</style>`).appendTo('head');
	}

	make_layout() {
		this.page.body.html(`
			<div class="whatsapp-inbox">
				<div class="wa-conversations">
					<div class="wa-conversations-filters">
						<select class="form-control wa-filter-status">
							<option value="">Status: Todos</option>
							<option value="Novo">Novo</option>
							<option value="Em andamento">Em andamento</option>
							<option value="Aguardando cliente">Aguardando cliente</option>
							<option value="Resolvido">Resolvido</option>
						</select>
						<input class="form-control wa-filter-tag" placeholder="Tag">
						<input class="form-control wa-filter-agent" placeholder="Agente">
					</div>
					<div class="wa-conversations-list"></div>
				</div>
				<div class="wa-thread">
					<div class="wa-thread-header"><span class="wa-empty-state" style="height:auto;">Selecione uma conversa</span></div>
					<div class="wa-thread-messages"></div>
					<div class="wa-thread-compose" style="display:none;">
						<textarea class="form-control wa-compose-input" rows="1" placeholder="Digite uma mensagem"></textarea>
						<button class="btn btn-primary btn-sm wa-compose-send">Enviar</button>
					</div>
				</div>
				<div class="wa-contact-panel"><div class="wa-empty-state">Nenhum contato selecionado</div></div>
			</div>
		`);
	}

	bind_events() {
		const main = this.page.body;

		main.on('change', '.wa-filter-status', (e) => {
			this.filters.status = e.target.value;
			this.refresh_conversations();
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

		main.on('click', '.wa-compose-send', () => this.send_message());
		main.on('keydown', '.wa-compose-input', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.send_message();
			}
		});

		main.on('click', '.wa-audio-play', (e) => this.toggle_audio(e.currentTarget));

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
	}

	setup_realtime() {
		frappe.realtime.on('whatsapp_inbox_update', (data) => {
			this.refresh_conversations();
			if (data.conversation && data.conversation === this.current_conversation) {
				this.load_thread(this.current_conversation);
			}
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

	open_conversation(name) {
		this.current_conversation = name;
		this.page.body.find('.wa-conversation-item').removeClass('active');
		this.page.body.find(`.wa-conversation-item[data-name="${name}"]`).addClass('active');
		this.page.body.find('.wa-thread-compose').show();

		this.load_thread(name);
		this.load_contact_panel(name);
	}

	load_thread(name) {
		frappe.call({
			method: 'takion_whatsapp.client.inbox.get_thread',
			args: { conversation: name },
		}).then((r) => this.render_thread(r.message || []));
	}

	render_thread(messages) {
		const $header = this.page.body.find('.wa-thread-header');
		$header.text(this.current_conversation);

		const $messages = this.page.body.find('.wa-thread-messages');
		$messages.html(messages.map((m) => this.render_message(m)).join(''));
		$messages.scrollTop($messages[0].scrollHeight);
	}

	render_message(msg) {
		const out = msg.type === 'Outgoing';
		const time = frappe.datetime.str_to_user(msg.creation, true);
		const check = out ? this.render_check(msg.status) : '';
		const body = msg.content_type === 'audio'
			? this.render_audio_bubble(msg)
			: this.render_generic_bubble(msg);

		return `
			<div class="wa-bubble-row ${out ? 'out' : 'in'}">
				<div class="wa-bubble">
					${body}
					<div class="wa-bubble-time">${time}${check}</div>
				</div>
			</div>
		`;
	}

	render_check(status) {
		if (status === 'read') return ' <span class="wa-check wa-check-read">✓✓</span>';
		if (status === 'delivered') return ' <span class="wa-check">✓✓</span>';
		if (status === 'failed') return ' <span class="wa-check text-danger">!</span>';
		return ' <span class="wa-check">✓</span>';
	}

	render_generic_bubble(msg) {
		if (msg.content_type === 'image' && msg.attach) {
			return `<img src="${frappe.utils.escape_html(msg.attach)}" style="max-width:220px;border-radius:4px;">`;
		}
		if (msg.attach && ['document', 'video'].includes(msg.content_type)) {
			return `<a href="${frappe.utils.escape_html(msg.attach)}" target="_blank">📎 ${frappe.utils.escape_html(msg.attach.split('/').pop())}</a>`;
		}
		const $text = $('<div class="wa-bubble-text"></div>').text(msg.message || '');
		return $text.prop('outerHTML');
	}

	render_audio_bubble(msg) {
		// Simplified static waveform (visual only, not decoded from the actual audio
		// samples) — matches the WhatsApp look without adding Web Audio analysis, which
		// is out of scope for this Entrega.
		const bars = Array.from({ length: 28 }, () => Math.round(6 + Math.random() * 18));
		const wave = bars.map((h) => `<span style="height:${h}px"></span>`).join('');

		return `
			<div class="wa-audio-bubble">
				<audio class="wa-audio-el" src="${frappe.utils.escape_html(msg.attach || '')}" preload="metadata" style="display:none;"></audio>
				<button class="wa-audio-play">▶</button>
				<div class="wa-audio-wave">${wave}</div>
				<span class="wa-audio-duration">--:--</span>
			</div>
		`;
	}

	toggle_audio(button) {
		const $bubble = $(button).closest('.wa-audio-bubble');
		const audio = $bubble.find('.wa-audio-el')[0];
		const $duration = $bubble.find('.wa-audio-duration');

		if (!audio.dataset.bound) {
			audio.addEventListener('loadedmetadata', () => {
				if (isFinite(audio.duration)) $duration.text(this.format_duration(audio.duration));
			});
			audio.addEventListener('timeupdate', () => {
				$duration.text(this.format_duration(audio.duration - audio.currentTime));
			});
			audio.addEventListener('ended', () => {
				$(button).text('▶');
				$duration.text(this.format_duration(audio.duration));
			});
			audio.dataset.bound = '1';
		}

		if (audio.paused) {
			$('.wa-audio-el').not(audio).each((i, el) => el.pause());
			audio.play();
			$(button).text('⏸');
		} else {
			audio.pause();
			$(button).text('▶');
		}
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
		frappe.call({
			method: 'takion_whatsapp.client.inbox.send_message',
			args: { conversation: this.current_conversation, message: text },
		}).then(() => {
			$input.prop('disabled', false).focus();
			this.load_thread(this.current_conversation);
			this.refresh_conversations();
		}).catch(() => $input.prop('disabled', false));
	}

	load_contact_panel(name) {
		frappe.db.get_doc('WhatsApp Conversation', name).then((conversation) => {
			if (conversation.contact) {
				frappe.db.get_doc('Contact', conversation.contact)
					.then((contact) => this.render_contact_panel(conversation, contact));
			} else {
				this.render_contact_panel(conversation, null);
			}
		});
	}

	render_contact_panel(conversation, contact) {
		const $panel = this.page.body.find('.wa-contact-panel');
		const tags = (conversation._user_tags || '').split(',').map((t) => t.trim()).filter(Boolean);
		let assignees = [];
		try { assignees = JSON.parse(conversation._assign || '[]'); } catch (e) { assignees = []; }

		const name = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : conversation.phone_number_display;

		$panel.html(`
			<h5>${frappe.utils.escape_html(name || '')}</h5>
			<div class="wa-contact-field">${frappe.utils.escape_html(conversation.phone_number_display || '')}</div>
			${contact && contact.email_id ? `<div class="wa-contact-field">${frappe.utils.escape_html(contact.email_id)}</div>` : ''}
			${contact && contact.company_name ? `<div class="wa-contact-field">${frappe.utils.escape_html(contact.company_name)}</div>` : ''}

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
};
