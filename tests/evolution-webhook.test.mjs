import test from "node:test";
import assert from "node:assert/strict";
import { parseEvolutionWebhook } from "../lib/integrations/evolution/webhook-parser.ts";

/** Envelope conferido contra a Evolution 2.3.7 rodando de verdade. */
const webhook = (data, event = "messages.upsert") => ({
  event, instance: "LZR-HUB", data,
  destination: "https://lzr-hub-production.up.railway.app/api/channels/evolution",
  date_time: "2026-08-25T14:57:31.527Z", server_url: "http://localhost:8081", apikey: "chave",
});

// `key` sai do resto de propósito: espalhar `over` por cima trocaria a chave
// inteira e apagaria o remetente, fazendo testes passarem pelo motivo errado.
const mensagem = ({ key = {}, ...over } = {}) => ({
  key: { remoteJid: "5579998307232@s.whatsapp.net", fromMe: false, id: "3EB0C1D2E3F4", ...key },
  pushName: "Wendel",
  message: { conversation: "minha internet ta lenta" },
  messageType: "conversation",
  ...over,
});

test("mensagem de cliente vira entrada do canal", () => {
  const parsed = parseEvolutionWebhook(webhook(mensagem()));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.message.phone, "5579998307232", "só dígitos, com o país");
  assert.equal(parsed.message.text, "minha internet ta lenta");
  assert.equal(parsed.message.messageId, "3EB0C1D2E3F4", "o id da mensagem é a chave de idempotência");
  assert.equal(parsed.message.pushName, "Wendel");
});

test("texto formatado também é lido", () => {
  const parsed = parseEvolutionWebhook(webhook(mensagem({
    message: { extendedTextMessage: { text: "  quanto custa a fibra?  " } },
  })));
  assert.equal(parsed.message.text, "quanto custa a fibra?");
});

test("grupo nunca vira atendimento", () => {
  // Isto aconteceu em produção pelo caminho antigo: havia conversas de grupo na
  // tela de Atendimentos, com intenção classificada e transbordo contado.
  const parsed = parseEvolutionWebhook(webhook(mensagem({ key: { remoteJid: "120363373173147301@g.us" } })));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.skip, "grupo");
});

test("mensagem que nós mesmos enviamos é ignorada", () => {
  // Sem isto a IA responderia à própria resposta.
  const parsed = parseEvolutionWebhook(webhook(mensagem({ key: { fromMe: true } })));
  assert.equal(parsed.skip, "mensagem-propria");
});

test("status e transmissão não são conversa", () => {
  const parsed = parseEvolutionWebhook(webhook(mensagem({ key: { remoteJid: "status@broadcast" } })));
  assert.equal(parsed.skip, "transmissao");
});

test("os outros eventos da Evolution são ignorados", () => {
  // Ela emite conexão, QR e presença o tempo todo.
  for (const event of ["connection.update", "qrcode.updated", "presence.update", "send.message"]) {
    assert.equal(parseEvolutionWebhook(webhook(mensagem(), event)).skip, "outro-evento", event);
  }
});

test("mensagem sem texto (áudio, figurinha, imagem) é ignorada", () => {
  // Mandar a legenda de uma foto como se fosse a fala do cliente faria a IA
  // responder a outra coisa.
  assert.equal(parseEvolutionWebhook(webhook(mensagem({ message: { audioMessage: { url: "..." } } }))).skip, "sem-texto");
  assert.equal(parseEvolutionWebhook(webhook(mensagem({ message: { conversation: "   " } }))).skip, "sem-texto");
});

test("sem id não dá para garantir idempotência, então não processa", () => {
  assert.equal(parseEvolutionWebhook(webhook(mensagem({ key: { id: "" } }))).skip, "sem-id");
});

test("remetente ausente ou curto demais é recusado", () => {
  assert.equal(parseEvolutionWebhook(webhook(mensagem({ key: { remoteJid: "" } }))).skip, "sem-remetente");
  // Número curto nunca casaria com cadastro; criaria conversa órfã.
  assert.equal(parseEvolutionWebhook(webhook(mensagem({ key: { remoteJid: "123@s.whatsapp.net" } }))).skip, "sem-remetente");
});

test("corpo estranho não derruba a rota", () => {
  for (const value of [null, undefined, {}, { event: "messages.upsert" }, "texto solto", 42]) {
    assert.equal(parseEvolutionWebhook(value).ok, false);
  }
});
