import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Traduz o webhook do **WhatsApp Business Platform (Cloud API)** da Meta para o
 * que o canal do LZR HUB espera.
 *
 * Existe porque a Evolution API usa Baileys — uma reimplementação **não oficial**
 * do WhatsApp Web — e usá-la para automação viola os Termos de Serviço. A Meta
 * detectou e avisou que a conta pode ser restringida. Este é o caminho oficial;
 * o outro só adiava o banimento do número que atende os clientes.
 *
 * Formato confirmado na documentação da Meta:
 *
 *   { object, entry[].changes[].value.{ messaging_product, metadata,
 *     contacts[], messages[] }, field }
 *
 * ⚠️ O **mesmo** webhook entrega recibo de entrega e leitura, num array
 * `statuses` em vez de `messages`. Tratar recibo como mensagem faria a IA
 * responder ao próprio "entregue".
 */

export const MESSAGE_FIELD = "messages";
export const EXPECTED_OBJECT = "whatsapp_business_account";

export interface MetaMessage {
  /** Número de quem escreveu, só dígitos, com o código do país. */
  phone: string;
  text: string;
  /** `wamid...` — id da mensagem na Meta, e a chave de idempotência. */
  messageId: string;
  profileName?: string;
  /** Telefone da BBNET que recebeu. Guardado para saber por qual número entrou. */
  phoneNumberId?: string;
}

export type SkipReason =
  | "outro-objeto"
  | "outro-campo"
  | "recibo-de-status"
  | "sem-mensagem"
  | "sem-texto"
  | "sem-remetente"
  | "sem-id";

export type ParseResult =
  | { ok: true; message: MetaMessage }
  | { ok: false; skip: SkipReason };

/**
 * Confere a assinatura `X-Hub-Signature-256`.
 *
 * É a segurança de verdade deste webhook, e é melhor que o Bearer que a Evolution
 * usava: a Meta assina o **corpo** com o segredo do aplicativo, então nem um
 * segredo vazado em log de proxy permite forjar mensagem sem saber o corpo.
 *
 * Comparação de tempo constante porque comparar assinatura com `===` vaza,
 * byte a byte, quanto do palpite estava certo.
 */
export function signatureIsValid(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [algorithm, offered] = header.split("=");
  if (algorithm !== "sha256" || !offered) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(offered, "hex");
  // `timingSafeEqual` lança se os tamanhos diferem — e tamanho diferente já é
  // assinatura inválida, então a recusa vem antes.
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

const digits = (value: string) => value.replace(/\D/g, "");

export function parseMetaWebhook(payload: unknown): ParseResult {
  const body = (payload ?? {}) as Record<string, unknown>;
  if (body.object !== EXPECTED_OBJECT) return { ok: false, skip: "outro-objeto" };

  const entry = Array.isArray(body.entry) ? body.entry[0] as Record<string, unknown> | undefined : undefined;
  const change = Array.isArray(entry?.changes) ? entry.changes[0] as Record<string, unknown> | undefined : undefined;
  if (!change) return { ok: false, skip: "sem-mensagem" };
  if (change.field !== MESSAGE_FIELD) return { ok: false, skip: "outro-campo" };

  const value = (change.value ?? {}) as Record<string, unknown>;
  // Recibo de entrega/leitura chega pelo mesmo caminho, com `statuses` no lugar
  // de `messages`. Sem esta checagem a IA responderia ao próprio "entregue".
  if (Array.isArray(value.statuses) && value.statuses.length > 0) return { ok: false, skip: "recibo-de-status" };

  const message = Array.isArray(value.messages) ? value.messages[0] as Record<string, unknown> | undefined : undefined;
  if (!message) return { ok: false, skip: "sem-mensagem" };

  const phone = digits(String(message.from ?? ""));
  if (phone.length < 10) return { ok: false, skip: "sem-remetente" };

  const messageId = String(message.id ?? "").trim();
  if (!messageId) return { ok: false, skip: "sem-id" };

  // Só texto. Áudio, imagem, documento e botão têm outra forma; mandar a
  // legenda de uma foto como se fosse a fala do cliente faria a IA responder a
  // outra coisa — mesma decisão que já valia no caminho da Evolution.
  const text = message.type === "text"
    ? String(((message.text ?? {}) as Record<string, unknown>).body ?? "").trim()
    : "";
  if (!text) return { ok: false, skip: "sem-texto" };

  const contact = Array.isArray(value.contacts) ? value.contacts[0] as Record<string, unknown> | undefined : undefined;
  const profileName = contact && typeof (contact.profile as Record<string, unknown> | undefined)?.name === "string"
    ? String((contact.profile as Record<string, unknown>).name).trim()
    : undefined;
  const metadata = (value.metadata ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    message: {
      phone, text, messageId, profileName,
      phoneNumberId: typeof metadata.phone_number_id === "string" ? metadata.phone_number_id : undefined,
    },
  };
}
