import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { D1ChannelRepository, MAX_MESSAGE_LENGTH, processChannelMessage } from "@/lib/platform/n8n-channel-service";
import { DbSupportMetricsRepository } from "@/lib/platform/support-metrics";
import { DbCrmRepository, captureLeadFromContact } from "@/lib/platform/crm-service";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { parseEvolutionWebhook } from "@/lib/integrations/evolution/webhook-parser";

/**
 * Webhook da Evolution API, direto — sem n8n no meio.
 *
 * O n8n só repassava o webhook, e a Evolution sabe mandar cabeçalho customizado
 * (confirmado na 2.3.7: o campo `headers` da configuração de webhook chega
 * intacto). Um serviço a menos no caminho é um a menos para cair, atualizar e
 * pagar.
 *
 * A rota `/api/channels/n8n` continua existindo e funcionando: quem já tiver um
 * fluxo apontado para lá não quebra por causa desta.
 *
 * ⚠️ `FEATURE_N8N_CHANNEL` continua sendo a chave do canal, apesar do nome. Ela
 * significa "o canal de WhatsApp está ligado", e renomear variável de produção
 * é mudança coordenada que derruba o canal se sair fora de ordem.
 */
const channelEnabled = () => process.env.FEATURE_N8N_CHANNEL === "true";
const autoReplyEnabled = () => process.env.FEATURE_N8N_AUTOREPLY === "true";

/**
 * O segredo é o mesmo do canal. `EVOLUTION_WEBHOOK_SECRET` tem preferência para
 * quem quiser separar os dois; sem ela, vale o que já existe no Railway — assim
 * a migração não depende de mudar variável e código na mesma janela.
 */
const channelSecret = () => process.env.EVOLUTION_WEBHOOK_SECRET?.trim() || process.env.N8N_CHANNEL_SECRET?.trim();

export async function POST(request: Request) {
  if (!channelEnabled()) return NextResponse.json({ error: "Canal de WhatsApp desativado" }, { status: 503 });
  const secret = channelSecret();
  if (!secret) return NextResponse.json({ error: "Canal mal configurado" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const parsed = parseEvolutionWebhook(payload);

  // Evento ignorado responde 200: a Evolution manda dezenas de eventos por
  // minuto (conexão, presença, status), e devolver erro para eles encheria o
  // log dela de falha por comportamento normal nosso.
  if (!parsed.ok) return NextResponse.json({ ignored: true, reason: parsed.skip });

  const { phone, text, messageId } = parsed.message;
  if (text.length > MAX_MESSAGE_LENGTH) return NextResponse.json({ ignored: true, reason: "mensagem-longa" });

  const correlationId = randomUUID();
  const db = await getDb();
  const result = await processChannelMessage(
    new D1ChannelRepository(db),
    // A chave de idempotência é o id da mensagem na Evolution: reentrega do
    // mesmo webhook (ela reenvia quando não recebe 200) não processa duas vezes.
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
