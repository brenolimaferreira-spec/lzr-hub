/**
 * O que conta como atendimento de cliente — e o que não conta.
 *
 * Existe por um problema medido em produção: **conversas de grupo do WhatsApp
 * entraram como atendimento**. O caminho antigo (Evolution → n8n → HUB)
 * repassava qualquer mensagem, e a tela de Atendimentos ficou com identificadores
 * `@g.us` ao lado de clientes de verdade — com intenção classificada, desfecho
 * gravado e transbordo contado. Papo de grupo virou métrica de atendimento.
 *
 * A rota nova (`/api/channels/evolution`) recusa grupo na entrada. Isto aqui é a
 * outra metade: o que **já está gravado** continua no banco, mas fora das contas.
 *
 * Filtrar na leitura em vez de apagar é decisão deliberada:
 *
 * - não se perde histórico, e apagar conversa é irreversível
 * - não exige migração nem janela de manutenção
 * - vale para resíduo que ninguém mapeou ainda
 * - o mesmo filtro protege caso outro canal volte a mandar grupo um dia
 */

/** Sufixo de identificador de grupo no WhatsApp. */
const GROUP_SUFFIX = "@g.us";

/**
 * Identificador de conversa que **não** é de um cliente.
 *
 * Além do grupo, qualquer identificador com `@` é do WhatsApp e não é telefone
 * de pessoa — transmissão (`status@broadcast`) e listas caem aqui. Conversa de
 * cliente é sempre só dígitos.
 */
export function isNonCustomerConversation(externalConversationId: string): boolean {
  const value = externalConversationId.trim();
  if (!value) return true;
  return value.endsWith(GROUP_SUFFIX) || value.includes("@");
}

/** Padrão SQL `LIKE` equivalente, para filtrar no banco em vez de na aplicação. */
export const NON_CUSTOMER_LIKE = "%@%";
