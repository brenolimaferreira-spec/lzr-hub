import { randomUUID } from "node:crypto";
import { and, eq, gte, notLike } from "drizzle-orm";
import { NON_CUSTOMER_LIKE } from "./conversation-scope.ts";
import { conversationOutcomes, csatRatings } from "../../db/schema.ts";

/** Pergunta enviada ao cliente no fim da conversa. A resposta seguinte vira nota. */
export const CSAT_QUESTION = "Antes de encerrar: de 1 a 5, como você avalia este atendimento?";
export const CSAT_THANKS = "Obrigado pela avaliação! Ela ajuda a melhorar o atendimento.";
export const CSAT_MIN = 1;
export const CSAT_MAX = 5;

/** Desfechos em que a IA concluiu sozinha, sem passar para humano. */
const RESOLVED_WITHOUT_HUMAN = new Set(["resolved", "simulated"]);
/** Modo observação: a IA propôs uma resposta que ninguém enviou ao cliente. */
const SUGGESTED = "suggested";

export interface ConversationOutcomeRow {
  channel: string;
  externalConversationId: string;
  intent: string;
  finalStatus: string;
  handoff: boolean;
  handoffReason: string | null;
  correlationId: string;
}

export interface CsatRow { channel: string; externalConversationId: string; score: number }

export interface SupportMetricsRepository {
  saveOutcome(outcome: ConversationOutcomeRow): Promise<void>;
  saveRating(rating: CsatRow): Promise<void>;
  listOutcomes(sinceIso: string): Promise<Array<{ intent: string; finalStatus: string; handoff: boolean; handoffReason: string | null }>>;
  listRatings(sinceIso: string): Promise<Array<{ score: number }>>;
}

export interface SupportMetrics {
  conversations: number;
  resolvedWithoutHuman: number;
  resolutionRate: number | null;
  handoffs: number;
  /** Conversas em que a IA só sugeriu, sem responder ao cliente (resposta automática desligada). */
  suggestionsOnly: number;
  handoffReasons: Record<string, number>;
  /** Quantas conversas por intenção detectada — é o que a Visão geral mostra no lugar de barras fixas. */
  intents: Record<string, number>;
  csatAverage: number | null;
  csatCount: number;
  csatDistribution: Record<string, number>;
  /** Depende do Langfuse (issue #6); nunca inventamos um número aqui. */
  costPerConversation: null;
}

/**
 * Interpreta a resposta do cliente à pergunta de CSAT.
 * Aceita "4", "nota 4", "4/5" — recusa qualquer coisa fora de 1..5.
 */
export function parseCsatScore(text: string): number | null {
  const match = text.trim().match(/(?:^|\D)([1-5])(?:\s*\/\s*5)?(?:\D|$)/);
  if (!match) return null;
  const score = Number(match[1]);
  return score >= CSAT_MIN && score <= CSAT_MAX ? score : null;
}

/** Só perguntamos a nota quando a IA concluiu sozinha — transbordo não é avaliado pela IA. */
export function shouldAskCsat(finalStatus: string, handoff: boolean): boolean {
  return !handoff && RESOLVED_WITHOUT_HUMAN.has(finalStatus);
}

export function isAwaitingCsat(lastAgentMessage: string | undefined): boolean {
  return !!lastAgentMessage && lastAgentMessage.includes(CSAT_QUESTION);
}

export async function getSupportMetrics(
  repository: SupportMetricsRepository,
  sinceIso: string,
): Promise<SupportMetrics> {
  const [outcomes, ratings] = await Promise.all([
    repository.listOutcomes(sinceIso),
    repository.listRatings(sinceIso),
  ]);

  const resolvedWithoutHuman = outcomes.filter((item) => !item.handoff && RESOLVED_WITHOUT_HUMAN.has(item.finalStatus)).length;
  const handoffReasons: Record<string, number> = {};
  const intents: Record<string, number> = {};
  for (const item of outcomes) {
    const intent = item.intent || "não classificada";
    intents[intent] = (intents[intent] ?? 0) + 1;
    if (!item.handoff) continue;
    const reason = item.handoffReason ?? "não informado";
    handoffReasons[reason] = (handoffReasons[reason] ?? 0) + 1;
  }

  const csatDistribution: Record<string, number> = {};
  for (const rating of ratings) {
    const key = String(rating.score);
    csatDistribution[key] = (csatDistribution[key] ?? 0) + 1;
  }

  return {
    conversations: outcomes.length,
    resolvedWithoutHuman,
    resolutionRate: outcomes.length ? resolvedWithoutHuman / outcomes.length : null,
    handoffs: outcomes.filter((item) => item.handoff).length,
    suggestionsOnly: outcomes.filter((item) => item.finalStatus === SUGGESTED).length,
    handoffReasons,
    intents,
    csatAverage: ratings.length ? ratings.reduce((sum, item) => sum + item.score, 0) / ratings.length : null,
    csatCount: ratings.length,
    csatDistribution,
    costPerConversation: null,
  };
}

export class DbSupportMetricsRepository implements SupportMetricsRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async saveOutcome(outcome: ConversationOutcomeRow): Promise<void> {
    await this.db.insert(conversationOutcomes).values({
      id: randomUUID(), ...outcome, createdAt: new Date().toISOString(),
    });
  }

  async saveRating(rating: CsatRow): Promise<void> {
    await this.db.insert(csatRatings).values({
      id: randomUUID(), ...rating, comment: null, createdAt: new Date().toISOString(),
    }).onConflictDoNothing();
  }

  async listOutcomes(sinceIso: string) {
    return this.db.select({
      intent: conversationOutcomes.intent,
      finalStatus: conversationOutcomes.finalStatus,
      handoff: conversationOutcomes.handoff,
      handoffReason: conversationOutcomes.handoffReason,
    }).from(conversationOutcomes).where(and(
      gte(conversationOutcomes.createdAt, sinceIso),
      // Conversa de grupo não é atendimento. Ver lib/platform/conversation-scope.ts.
      notLike(conversationOutcomes.externalConversationId, NON_CUSTOMER_LIKE),
    ));
  }

  async listRatings(sinceIso: string) {
    return this.db.select({ score: csatRatings.score }).from(csatRatings).where(gte(csatRatings.createdAt, sinceIso));
  }

  async hasRating(channel: string, externalConversationId: string): Promise<boolean> {
    const rows = await this.db.select().from(csatRatings)
      .where(and(eq(csatRatings.channel, channel), eq(csatRatings.externalConversationId, externalConversationId)))
      .limit(1);
    return rows.length > 0;
  }
}

export class MemorySupportMetricsRepository implements SupportMetricsRepository {
  readonly outcomes: Array<ConversationOutcomeRow & { createdAt: string }> = [];
  readonly ratings: Array<CsatRow & { createdAt: string }> = [];
  async saveOutcome(outcome: ConversationOutcomeRow) { this.outcomes.push({ ...outcome, createdAt: new Date().toISOString() }); }
  async saveRating(rating: CsatRow) {
    if (this.ratings.some((item) => item.channel === rating.channel && item.externalConversationId === rating.externalConversationId)) return;
    this.ratings.push({ ...rating, createdAt: new Date().toISOString() });
  }
  async listOutcomes(sinceIso: string) {
    return this.outcomes.filter((item) => item.createdAt >= sinceIso)
      .map(({ intent, finalStatus, handoff, handoffReason }) => ({ intent, finalStatus, handoff, handoffReason }));
  }
  async listRatings(sinceIso: string) {
    return this.ratings.filter((item) => item.createdAt >= sinceIso).map(({ score }) => ({ score }));
  }
}
