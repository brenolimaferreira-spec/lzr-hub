/**
 * Conta o que entrou como atendimento sem ser cliente — conversa de grupo do
 * WhatsApp, principalmente.
 *
 * O caminho antigo (Evolution → n8n → HUB) repassava qualquer mensagem, e a tela
 * de Atendimentos ficou com identificadores `@g.us` ao lado de clientes reais,
 * com intenção classificada e transbordo contado. A rota nova recusa grupo na
 * entrada, e as telas já filtram o que está gravado — este script existe para
 * medir o tamanho do resíduo.
 *
 * **Só lê.** Não apaga nem altera nada.
 *
 * A URL do banco vem do ambiente, nunca de argumento: senha em linha de comando
 * fica no histórico do shell.
 *
 *   $env:DATABASE_URL = "<DATABASE_PUBLIC_URL do Railway>"
 *   node scripts/contar-grupos.mjs
 */
import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("Falta DATABASE_URL no ambiente.");
  console.error('PowerShell:  $env:DATABASE_URL = "postgresql://..."');
  console.error("bash:        export DATABASE_URL='postgresql://...'");
  console.error("\nUse o DATABASE_PUBLIC_URL do Railway — o DATABASE_URL de lá é da rede");
  console.error("privada e não responde fora da infraestrutura deles.");
  process.exit(1);
}

// O Postgres do Railway exige TLS e usa certificado que a cadeia local não valida.
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const pct = (part, total) => total === 0 ? "—" : `${((part / total) * 100).toFixed(1)}%`;

try {
  await client.connect();

  const { rows: [mensagens] } = await client.query(`
    SELECT
      count(DISTINCT external_conversation_id) FILTER (WHERE external_conversation_id LIKE '%@%') AS conversas_nao_cliente,
      count(DISTINCT external_conversation_id) AS conversas_total,
      count(*) FILTER (WHERE external_conversation_id LIKE '%@%') AS mensagens_nao_cliente,
      count(*) AS mensagens_total
    FROM channel_messages`);

  const { rows: [desfechos] } = await client.query(`
    SELECT
      count(*) FILTER (WHERE external_conversation_id LIKE '%@%') AS nao_cliente,
      count(*) AS total,
      count(*) FILTER (WHERE external_conversation_id LIKE '%@%' AND handoff) AS transbordos_nao_cliente,
      count(*) FILTER (WHERE handoff) AS transbordos_total
    FROM conversation_outcomes`);

  const { rows: exemplos } = await client.query(`
    SELECT external_conversation_id, count(*) AS mensagens, max(created_at) AS ultima
    FROM channel_messages WHERE external_conversation_id LIKE '%@%'
    GROUP BY 1 ORDER BY max(created_at) DESC LIMIT 10`);

  console.log("CONVERSAS");
  console.log(`  não-cliente : ${mensagens.conversas_nao_cliente} de ${mensagens.conversas_total} (${pct(mensagens.conversas_nao_cliente, mensagens.conversas_total)})`);
  console.log(`  mensagens   : ${mensagens.mensagens_nao_cliente} de ${mensagens.mensagens_total} (${pct(mensagens.mensagens_nao_cliente, mensagens.mensagens_total)})`);

  console.log("\nDESFECHOS (é o que alimenta as métricas de atendimento)");
  console.log(`  não-cliente : ${desfechos.nao_cliente} de ${desfechos.total} (${pct(desfechos.nao_cliente, desfechos.total)})`);
  console.log(`  transbordos : ${desfechos.transbordos_nao_cliente} de ${desfechos.transbordos_total} (${pct(desfechos.transbordos_nao_cliente, desfechos.transbordos_total)})`);

  if (exemplos.length > 0) {
    console.log("\nQUEM SÃO (mais recentes)");
    for (const row of exemplos) {
      console.log(`  ${String(row.external_conversation_id).slice(0, 44).padEnd(44)} ${String(row.mensagens).padStart(4)} msg  ${String(row.ultima).slice(0, 10)}`);
    }
  }

  console.log(`
Como ler:
  • Os números acima são o resíduo do caminho antigo. As telas já os ignoram
    (lib/platform/conversation-scope.ts), então isto mede o passado, não um
    problema em curso.
  • Se "desfechos não-cliente" for uma fatia grande, as métricas de atendimento
    exibidas ANTES desta correção estavam infladas nessa proporção.
  • Nada aqui foi apagado. Filtrar na leitura preserva o histórico, e apagar
    conversa é irreversível.`);
} catch (error) {
  console.error(`Falha ao consultar: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
