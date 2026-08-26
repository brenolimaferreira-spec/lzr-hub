import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { D1ChannelRepository, MAX_MESSAGE_LENGTH, processChannelMessage } from "@/lib/platform/n8n-channel-service";
import { DbSupportMetricsRepository } from "@/lib/platform/support-metrics";
import { DbCrmRepository, captureLeadFromContact } from "@/lib/platform/crm-service";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { parseMetaWebhook, signatureIsValid } from "@/lib/integrations/meta/webhook-parser";

/**
 * Webhook oficial do **WhatsApp Business Platform (Cloud API)**.
 *
 * Substitui o caminho da Evolution/Baileys, que é não oficial e fez a Meta
 * avisar que a conta poderia ser restringida. Tudo depois do webhook é o mesmo
 * pipeline já testado: classificação, sugestão, captação de lead, métricas.
 *
 * `FEATURE_META_WHATSAPP` liga esta rota. A flag existia no `.env` desde o
 * início do projeto sem nada por trás; agora tem.
 */
const metaEnabled = () => process.env.FEATURE_META_WHATSAPP === "true";
const autoReplyEnabled = () => process.env.FEATURE_N8N_AUTOREPLY === "true";

/**
 * Verificação do webhook: a Meta chama com `hub.challenge` e espera o valor de
 * volta, cru. É o handshake que prova que a URL é nossa.
 *
 * ⚠️ O `hub.verify_token` é escolhido por você no painel da Meta e conferido
 * aqui. Ele **não** é o segredo que protege as mensagens — esse é a assinatura
 * do POST. Confundir os dois deixaria o webhook aberto.
 */
export async function GET(request: Request) {
  if (!metaEnabled()) return NextResponse.json({ error: "Canal Meta desativado" }, { status: 503 });
  const url = new URL(request.url);
  const verifyToken = process.env.META_VERIFY_TOKEN?.trim();
  if (!verifyToken) return NextResponse.json({ error: "META_VERIFY_TOKEN não configurado" }, { status: 503 });

  if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === verifyToken) {
    // Texto puro, não JSON: a Meta compara o corpo com o desafio que enviou.
    return new Response(url.searchParams.get("hub.challenge") ?? "", {
      status: 200, headers: { "content-type": "text/plain" },
    });
  }
  return NextResponse.json({ error: "Verificação recusada" }, { status: 403 });
}

export async function POST(request: Request) {
  if (!metaEnabled()) return NextResponse.json({ error: "Canal Meta desativado" }, { status: 503 });
  const appSecret = process.env.META_APP_SECRET?.trim();
  // Sem segredo não dá para verificar assinatura — e aceitar sem verificar
  // deixaria qualquer um postar mensagem de cliente na nossa fila.
  if (!appSecret) return NextResponse.json({ error: "META_APP_SECRET não configurado" }, { status: 503 });

  // O corpo precisa ser lido cru: a assinatura é sobre os bytes exatos, e
  // reserializar o JSON muda espaçamento e ordem, quebrando o HMAC.
  const rawBody = await request.text();
  if (!signatureIsValid(rawBody, request.headers.get("x-hub-signature-256"), appSecret)) {
    return NextResponse.json({ error: "Assinatura inválida" }, { status: 401 });
  }

  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return NextResponse.json({ error: "Corpo inválido" }, { status: 400 }); }

  const parsed = parseMetaWebhook(payload);
  // Evento ignorado responde 200: a Meta reenvia o que não recebe 200, e um
  // recibo de leitura recusado viraria reentrega infinita de algo que não
  // queremos processar.
  if (!parsed.ok) return NextResponse.json({ ignored: true, reason: parsed.skip });

  const { phone, text, messageId } = parsed.message;
  if (text.length > MAX_MESSAGE_LENGTH) return NextResponse.json({ ignored: true, reason: "mensagem-longa" });

  const correlationId = randomUUID();
  const db = await getDb();
  const result = await processChannelMessage(
    new D1ChannelRepository(db),
    // `wamid` é a chave de idempotência: a Meta reenvia o webhook quando não
    // recebe 200, e sem isso a reentrega viraria atendimento em dobro.
    { externalConversationId: phone, text, idempotencyKey: messageId, correlationId },
    new DbSupportMetricsRepository(db),
    { autoReply: autoReplyEnabled() },
    (input) => captureLeadFromContact(
      new DbCrmRepository(db),
      input,
      async (contactPhone) => {
        const runtime = getIxcRuntime();
        if (!runtime.provider) throw new Error("IXC indisponível");
        return runtime.provider.findCustomerByPhone(contactPhone, correlationId);
      },
    ),
  );

  return NextResponse.json(result);
}
