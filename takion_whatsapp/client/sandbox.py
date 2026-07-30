"""Sandbox de teste manual — cria e gerencia um WhatsApp Account/Channel/Conversation
FICTÍCIOS, claramente rotulados, pra exercitar as funções já construídas (enviar
texto/áudio/imagem/vídeo/documento, receber mensagem, SLA, custo, funil) sem
depender do número real de teste da Meta (WA-1, ver takion_whatsapp_wa1_status
na memória do projeto — ainda pendente).

O WhatsApp Account do sandbox nunca é marcado como default
(is_default_incoming/is_default_outgoing ficam 0) -- não deve interferir
quando uma conta real for configurada depois. Isso também significa que
ENVIAR (Outgoing) a partir da conversa de sandbox continua batendo na mesma
trava real de "nenhuma conta padrão configurada" que qualquer outra conversa
bate hoje -- intencional, é o limite real do sistema, não um bug do sandbox.
Só RECEBER (simulate_incoming) contorna essa trava, porque ali somos nós
mesmos simulando o papel do Meta, e setamos o whatsapp_account explicitamente
em vez de depender do lookup de conta padrão.

Restrito a System Manager: simular uma mensagem recebida insere um WhatsApp
Message "Incoming" de verdade (mesmo caminho de código de um webhook real,
incluindo os hooks de after_insert) -- não deve ficar disponível pra qualquer
operador injetar mensagens fabricadas em conversas de verdade.
"""
import frappe
from frappe import _
from frappe.desk.doctype.tag.tag import add_tag

from takion_whatsapp.client.conversation import get_or_create_conversation

SANDBOX_ACCOUNT_NAME = "Sandbox de Teste (não usar em produção)"
SANDBOX_PHONE_ID = "sandbox-000000000000"
SANDBOX_PHONE_NUMBER = "000000000000"
SANDBOX_DISPLAY_NAME = "🧪 Sandbox de Teste"
SANDBOX_TAG = "WhatsApp Sandbox"

SIMULATABLE_CONTENT_TYPES = ("text", "image", "video", "document", "audio")


@frappe.whitelist()
def ensure_sandbox_conversation():
	"""Idempotent: creates the sandbox account/channel/conversation on first call,
	just returns the existing conversation name on every call after that."""
	frappe.only_for("System Manager")

	if not frappe.db.exists("WhatsApp Account", SANDBOX_ACCOUNT_NAME):
		frappe.get_doc({
			"doctype": "WhatsApp Account",
			"account_name": SANDBOX_ACCOUNT_NAME,
			"phone_id": SANDBOX_PHONE_ID,
			"status": "Inactive",
			"is_default_incoming": 0,
			"is_default_outgoing": 0,
		}).insert(ignore_permissions=True)

	channel_name = frappe.db.get_value("WhatsApp Channel", {"whatsapp_account": SANDBOX_ACCOUNT_NAME}, "name")
	if not channel_name:
		channel_name = frappe.get_doc({
			"doctype": "WhatsApp Channel",
			"whatsapp_account": SANDBOX_ACCOUNT_NAME,
			"phone_number_id": SANDBOX_PHONE_ID,
			"internal_shared_secret": frappe.generate_hash(length=16),
		}).insert(ignore_permissions=True).name

	conv = get_or_create_conversation(channel_name, SANDBOX_PHONE_NUMBER, SANDBOX_PHONE_NUMBER)
	if conv.phone_number_display != SANDBOX_DISPLAY_NAME:
		conv.phone_number_display = SANDBOX_DISPLAY_NAME
		conv.save(ignore_permissions=True)
	if SANDBOX_TAG not in (conv.get("_user_tags") or ""):
		add_tag(SANDBOX_TAG, "WhatsApp Conversation", conv.name)

	return conv.name


@frappe.whitelist()
def simulate_incoming(conversation, content_type, message=None, file_url=None):
	"""Inserts an Incoming WhatsApp Message exactly as the real webhook would
	(same after_insert hooks: conversation linking, pricing, SLA, optout),
	skipping only the "download the file from Meta's servers" step -- file_url
	is whatever the sandbox dialog already uploaded via upload_file, standing
	in for what a real download would have produced.
	"""
	frappe.only_for("System Manager")
	_assert_sandbox_conversation(conversation)

	if content_type not in SIMULATABLE_CONTENT_TYPES:
		frappe.throw(_("Tipo não suportado para simulação: {0}").format(content_type))

	doc = frappe.new_doc("WhatsApp Message")
	doc.type = "Incoming"
	doc.whatsapp_account = SANDBOX_ACCOUNT_NAME  # bypasses the default-account lookup entirely
	doc.content_type = content_type
	doc.set("from", SANDBOX_PHONE_NUMBER)
	doc.message = message
	if file_url:
		doc.attach = file_url
	doc.insert(ignore_permissions=True)
	return doc.name


@frappe.whitelist()
def clear_sandbox_messages(conversation):
	"""Wipes messages so the sandbox conversation can be reused clean, without
	tearing down the account/channel/conversation themselves."""
	frappe.only_for("System Manager")
	_assert_sandbox_conversation(conversation)

	for name in frappe.get_all(
		"WhatsApp Message",
		filters={"reference_doctype": "WhatsApp Conversation", "reference_name": conversation},
		pluck="name",
	):
		frappe.delete_doc("WhatsApp Message", name, ignore_permissions=True, force=True)

	frappe.db.set_value(
		"WhatsApp Conversation",
		conversation,
		{"last_message_preview": "", "last_direction": None, "first_unanswered_inbound_at": None, "sla_state": "OK"},
		update_modified=False,
	)


def _assert_sandbox_conversation(conversation):
	if not frappe.db.exists("WhatsApp Conversation", {"name": conversation, "phone_number": SANDBOX_PHONE_NUMBER}):
		frappe.throw(_("Esta ação só é permitida na conversa de sandbox."))
