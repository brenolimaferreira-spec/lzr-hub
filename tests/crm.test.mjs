import test from "node:test";
import assert from "node:assert/strict";
import {
  CrmValidationError, MemoryCrmRepository, captureLeadFromContact,
  funnelMetrics, isStage, maskPhone, parseLeadInput,
} from "../lib/platform/crm-service.ts";
import { ixcPhoneFormat, phoneCandidates } from "../lib/integrations/ixc/readonly-provider.ts";

test("telefone do canal vira o formato que o IXC guarda", () => {
  // Foi isto que fez a busca parecer impossível: o canal manda 5579998307232,
  // o IXC guarda "(79) 99830-7232", e dígitos puros devolvem zero em silêncio.
  assert.equal(ixcPhoneFormat("5579998307232"), "(79) 99830-7232");
  assert.equal(ixcPhoneFormat("79998307232"), "(79) 99830-7232");
  assert.equal(ixcPhoneFormat("7933334444"), "(79) 3333-4444", "fixo de 10 dígitos");
  assert.equal(ixcPhoneFormat("123"), undefined, "sem formato conhecido, nada é chutado");
});

test("celular é procurado com e sem o nono dígito", () => {
  // Medido no canal real: o WhatsApp entregou 557999151289 — DDD mais oito
  // dígitos. Se o IXC guardar o formato longo, procurar só o curto não acha, e
  // um cliente antigo vira lead.
  assert.deepEqual(phoneCandidates("557999151289"), ["(79) 9915-1289", "(79) 99915-1289"]);
  assert.deepEqual(phoneCandidates("5579999151289"), ["(79) 99915-1289", "(79) 9915-1289"]);
});

test("fixo não ganha nono dígito", () => {
  // Só celular tem nono dígito; inventar um em fixo procuraria número que não existe.
  assert.deepEqual(phoneCandidates("557933334444"), ["(79) 3333-4444"]);
});

test("número sem formato conhecido não vira candidato nenhum", () => {
  assert.deepEqual(phoneCandidates("123"), []);
});

test("telefone aparece mascarado no funil", () => {
  // O funil é lido por quem não está no atendimento; lista de telefone completo
  // é lista de contato pronta para sair de casa.
  assert.equal(maskPhone("5579998307232"), "(79) •••••-7232");
  assert.equal(maskPhone("abc"), "número não informado");
});

test("lead novo não pode nascer ganho", () => {
  // Nascer ganho daria ciclo zero e conversão de 100% sem venda nenhuma.
  assert.throws(() => parseLeadInput({ name: "Maria", stage: "ganho" }), CrmValidationError);
  assert.throws(() => parseLeadInput({ name: "M" }), CrmValidationError);
  assert.equal(parseLeadInput({ name: "  Maria  " }).stage, "novo");
  assert.equal(parseLeadInput({ name: "Maria" }).city, "não informada", "campo vazio não vira string vazia");
});

test("etapa inválida é recusada", () => {
  assert.equal(isStage("proposta"), true);
  assert.equal(isStage("quase-fechando"), false);
});

const lead = (over = {}) => ({
  id: "l1", name: "Maria", maskedPhone: "(79) •••••-7232", city: "Aracaju", neighborhood: "Centro",
  source: "whatsapp", stage: "novo", ownerId: null, contactKey: null, note: null,
  closedAt: null, lostReason: null, createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z",
  ...over,
});

test("conversão é sobre encerrados, não sobre todos", () => {
  // Dividir pelo total puniria a operação por captar: cada contato novo
  // derrubaria a taxa sem nada ter piorado.
  const leads = [
    lead({ id: "a", stage: "ganho", closedAt: "2026-08-06T12:00:00.000Z" }),
    lead({ id: "b", stage: "perdido", closedAt: "2026-08-03T12:00:00.000Z" }),
    lead({ id: "c", stage: "novo" }),
    lead({ id: "d", stage: "proposta" }),
  ];
  const metrics = funnelMetrics(leads, leads);
  assert.equal(metrics.conversionRate, 0.5, "1 ganho de 2 encerrados");
  assert.equal(metrics.open, 2);
});

test("sem lead encerrado, conversão é 'não sei', não zero", () => {
  const leads = [lead({ stage: "novo" }), lead({ id: "x", stage: "proposta" })];
  const metrics = funnelMetrics(leads, leads);
  assert.equal(metrics.conversionRate, null);
  assert.equal(metrics.averageCycleDays, null);
});

test("ciclo médio conta do primeiro contato ao ganho", () => {
  const leads = [
    lead({ id: "a", stage: "ganho", createdAt: "2026-08-01T12:00:00.000Z", closedAt: "2026-08-06T12:00:00.000Z" }),
    lead({ id: "b", stage: "ganho", createdAt: "2026-08-01T12:00:00.000Z", closedAt: "2026-08-04T12:00:00.000Z" }),
    // Perdido não entra no ciclo: ciclo de venda é o tempo até vender.
    lead({ id: "c", stage: "perdido", createdAt: "2026-08-01T12:00:00.000Z", closedAt: "2026-08-30T12:00:00.000Z" }),
  ];
  assert.equal(funnelMetrics(leads, leads).averageCycleDays, 4);
});

test("o quadro conta todos os leads, e o período só os criados nele", () => {
  const todos = [lead({ id: "a", stage: "ganho", closedAt: "2026-07-02T12:00:00.000Z", createdAt: "2026-07-01T12:00:00.000Z" }), lead({ id: "b", stage: "novo" })];
  const doPeriodo = [todos[1]];
  const metrics = funnelMetrics(todos, doPeriodo);
  assert.equal(metrics.byStage.ganho, 1, "o quadro mostra o estado atual de tudo");
  assert.equal(metrics.created, 1, "o período conta só o que entrou nele");
  assert.equal(metrics.conversionRate, null, "nada encerrou no período");
});

test("mover para perdido guarda o motivo; reabrir limpa o fechamento", async () => {
  const repository = new MemoryCrmRepository();
  const created = await repository.create({ name: "Maria", phone: "5579998307232", city: "Aracaju", neighborhood: "Centro", source: "whatsapp", stage: "novo", note: null, actorId: "ana" });
  await repository.move({ leadId: created.id, toStage: "perdido", detail: "sem viabilidade na rua", actorId: "ana" });
  assert.equal((await repository.get(created.id)).lostReason, "sem viabilidade na rua");
  assert.ok((await repository.get(created.id)).closedAt);
  await repository.move({ leadId: created.id, toStage: "qualificado", detail: "voltou a procurar", actorId: "ana" });
  const reaberto = await repository.get(created.id);
  // Deixar a data de fechamento para trás faria o ciclo contar tempo que não terminou.
  assert.equal(reaberto.closedAt, null);
  assert.equal(reaberto.lostReason, null);
});

test("cada movimento fica no histórico, com de-onde e para-onde", async () => {
  const repository = new MemoryCrmRepository();
  const created = await repository.create({ name: "Maria", phone: "79998307232", city: "-", neighborhood: "-", source: "site", stage: "novo", note: null, actorId: "ana" });
  await repository.move({ leadId: created.id, toStage: "qualificado", detail: "tem viabilidade", actorId: "bruno" });
  const history = await repository.activities([created.id]);
  assert.equal(history.length, 2, "a criação também é história");
  assert.equal(history[1].fromStage, "novo");
  assert.equal(history[1].toStage, "qualificado");
  assert.equal(history[1].actorId, "bruno");
});

test("contato registrado no cartão não muda a etapa", async () => {
  const repository = new MemoryCrmRepository();
  const created = await repository.create({ name: "Maria", phone: "79998307232", city: "-", neighborhood: "-", source: "site", stage: "proposta", note: null, actorId: "ana" });
  await repository.addActivity(created.id, "contact", "liguei, pediu para retornar quinta", "ana");
  assert.equal((await repository.get(created.id)).stage, "proposta");
  assert.equal((await repository.activities([created.id])).length, 2);
});

/* --------------------------------------------------- captação pelo canal --- */

const semCliente = async () => undefined;

test("contato desconhecido no WhatsApp vira lead", async () => {
  const repository = new MemoryCrmRepository();
  const lead = await captureLeadFromContact(repository, { contactKey: "5579998307232", text: "quanto custa a fibra?" }, semCliente);
  assert.ok(lead);
  assert.equal(lead.source, "whatsapp");
  assert.equal(lead.stage, "novo");
  assert.equal(lead.maskedPhone, "(79) •••••-7232");
  assert.equal(lead.contactKey, "5579998307232");
});

test("quem já é cliente não vira lead", async () => {
  // Senão o funil encheria de gente que comprou há cinco anos, e a conversão
  // passaria a medir outra coisa.
  const repository = new MemoryCrmRepository();
  const lead = await captureLeadFromContact(repository, { contactKey: "5579998307232", text: "minha fatura" }, async () => ({ id: "21857" }));
  assert.equal(lead, undefined);
  assert.equal(repository.rows.length, 0);
});

test("o mesmo contato escrevendo de novo não duplica o lead", async () => {
  const repository = new MemoryCrmRepository();
  await captureLeadFromContact(repository, { contactKey: "5579998307232", text: "oi" }, semCliente);
  await captureLeadFromContact(repository, { contactKey: "5579998307232", text: "ainda quero saber" }, semCliente);
  assert.equal(repository.rows.length, 1);
});

test("com o IXC fora do ar, ninguém vira lead", async () => {
  // Na dúvida não cria: um ERP caindo criaria lead de cliente antigo em série,
  // e o funil passaria a mentir sem ninguém perceber.
  const repository = new MemoryCrmRepository();
  const lead = await captureLeadFromContact(repository, { contactKey: "5579998307232", text: "oi" }, async () => { throw new Error("IXC_TIMEOUT"); });
  assert.equal(lead, undefined);
  assert.equal(repository.rows.length, 0);
});
