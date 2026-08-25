/**
 * Traduz o webhook da Evolution API para o que o canal do LZR HUB espera.
 *
 * Existe porque o n8n saiu do caminho: ele só repassava o webhook, e a Evolution
 * sabe mandar cabeçalho customizado — dá para chamar a nossa API direto,
 * autenticada, sem um serviço no meio. Menos peça, menos coisa para cair.
 *
 * O envelope foi confirmado contra a Evolution 2.3.7 rodando localmente:
 *
 *   { event, instance, data, destination, date_time, server_url, apikey }
 *
 * Os caminhos dentro de `data` são os do Baileys, conferidos no código da
 * Evolution: `key.remoteJid`, `key.fromMe`, `key.id`, `pushName`,
 * `message.conversation` e `message.extendedTextMessage.text`.
 */

/** Só mensagem recebida interessa. O resto do que a Evolution emite é ruído para o canal. */
export const MESSAGE_EVENT = "messages.upsert";

export interface EvolutionMessage {
  /** Número de quem escreveu, só dígitos, com o código do país. */
  phone: string;
  text: string;
  /** Id da mensagem na Evolution — é a chave de idempotência. */
  messageId: string;
  pushName?: string;
}

export type SkipReason =
  | "outro-evento"
  | "mensagem-propria"
  | "grupo"
  | "transmissao"
  | "sem-texto"
  | "sem-remetente"
  | "sem-id";

export type ParseResult =
  | { ok: true; message: EvolutionMessage }
  | { ok: false; skip: SkipReason };

const digits = (value: string) => value.replace(/\D/g, "");

/**
 * Extrai o texto da mensagem.
 *
 * Só texto puro e texto formatado. Áudio, imagem e figurinha ficam de fora
 * porque o pipeline lê texto — mandar a legenda de uma foto como se fosse a
 * mensagem do cliente faria a IA responder a outra coisa.
 */
function extractText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const plain = message.conversation;
  if (typeof plain === "string" && plain.trim()) return plain.trim();
  const extended = message.extendedTextMessage as { text?: unknown } | undefined;
  if (extended && typeof extended.text === "string" && extended.text.trim()) return extended.text.trim();
  return "";
}

/**
 * Decide se este webhook vira uma mensagem de atendimento.
 *
 * As recusas importam mais que o caminho feliz:
 *
 * - **`fromMe`**: mensagem que nós mesmos enviamos. Processá-la faria a IA
 *   responder à própria resposta.
 * - **`@g.us`**: grupo. Isto **já aconteceu em produção** pelo caminho antigo —
 *   havia conversas de grupo na tela de Atendimentos, com intenção classificada
 *   e transbordo contado, como se fossem cliente. Grupo não é atendimento.
 * - **`status@broadcast`**: status/recado, não conversa.
 */
export function parseEvolutionWebhook(payload: unknown): ParseResult {
  const body = (payload ?? {}) as Record<string, unknown>;
  const event = String(body.event ?? "").toLowerCase();
  if (event !== MESSAGE_EVENT) return { ok: false, skip: "outro-evento" };

  const data = (body.data ?? {}) as Record<string, unknown>;
  const key = (data.key ?? {}) as Record<string, unknown>;

  if (key.fromMe === true) return { ok: false, skip: "mensagem-propria" };

  const remoteJid = String(key.remoteJid ?? "").trim();
  if (!remoteJid) return { ok: false, skip: "sem-remetente" };
  if (remoteJid.endsWith("@g.us")) return { ok: false, skip: "grupo" };
  if (remoteJid.startsWith("status@")) return { ok: false, skip: "transmissao" };

  const phone = digits(remoteJid.split("@")[0]);
  // Menos de 10 dígitos não é telefone brasileiro nem com o país junto; deixar
  // passar criaria conversa com identificador que nunca casa com cadastro.
  if (phone.length < 10) return { ok: false, skip: "sem-remetente" };

  const messageId = String(key.id ?? "").trim();
  if (!messageId) return { ok: false, skip: "sem-id" };

  const text = extractText(data.message as Record<string, unknown> | undefined);
  if (!text) return { ok: false, skip: "sem-texto" };

  const pushName = typeof data.pushName === "string" && data.pushName.trim() ? data.pushName.trim() : undefined;
  return { ok: true, message: { phone, text, messageId, pushName } };
}
