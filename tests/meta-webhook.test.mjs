import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseMetaWebhook, signatureIsValid } from "../lib/integrations/meta/webhook-parser.ts";

/** Formato conferido na documentação da Meta (Cloud API → webhooks → payload examples). */
const webhook = (value) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "102290129340398", changes: [{ value, field: "messages" }] }],
});

const texto = (over = {}) => webhook({
  messaging_product: "whatsapp",
  metadata: { display_phone_number: "5579936180547", phone_number_id: "106540352242922" },
  contacts: [{ profile: { name: "Vinicius" }, wa_id: "557999151289" }],
  messages: [{
    from: "557999151289", id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQ=",
    timestamp: "1749416383", type: "text", text: { body: "minha internet ta lenta" },
  }],
  ...over,
});

test("mensagem de texto vira entrada do canal", () => {
  const parsed = parseMetaWebhook(texto());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.message.phone, "557999151289");
  assert.equal(parsed.message.text, "minha internet ta lenta");
  assert.equal(parsed.message.messageId, "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQ=", "o wamid é a chave de idempotência");
  assert.equal(parsed.message.profileName, "Vinicius");
  assert.equal(parsed.message.phoneNumberId, "106540352242922");
});

test("recibo de entrega e leitura não é mensagem", () => {
  // Chega pelo MESMO webhook, com `statuses` no lugar de `messages`. Sem separar,
  // a IA responderia ao próprio "entregue".
  const parsed = parseMetaWebhook(webhook({
    messaging_product: "whatsapp",
    metadata: { phone_number_id: "106540352242922" },
    statuses: [{ id: "wamid.X", status: "delivered", timestamp: "1749416383", recipient_id: "557999151289" }],
  }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.skip, "recibo-de-status");
});

test("áudio, imagem e documento são ignorados", () => {
  // O pipeline lê texto; mandar legenda de foto como fala do cliente faria a IA
  // responder a outra coisa.
  for (const type of ["audio", "image", "document", "sticker", "button"]) {
    const parsed = parseMetaWebhook(texto({
      messages: [{ from: "557999151289", id: "wamid.Y", type, [type]: { id: "media-id" } }],
    }));
    assert.equal(parsed.skip, "sem-texto", type);
  }
});

test("outro objeto ou outro campo não é do canal", () => {
  assert.equal(parseMetaWebhook({ object: "page", entry: [] }).skip, "outro-objeto");
  const outroCampo = { object: "whatsapp_business_account", entry: [{ changes: [{ value: {}, field: "message_template_status_update" }] }] };
  assert.equal(parseMetaWebhook(outroCampo).skip, "outro-campo");
});

test("remetente curto demais ou sem id não processa", () => {
  assert.equal(parseMetaWebhook(texto({ messages: [{ from: "123", id: "wamid.Z", type: "text", text: { body: "oi" } }] })).skip, "sem-remetente");
  assert.equal(parseMetaWebhook(texto({ messages: [{ from: "557999151289", id: "", type: "text", text: { body: "oi" } }] })).skip, "sem-id");
});

test("corpo estranho não derruba a rota", () => {
  for (const value of [null, undefined, {}, { object: "whatsapp_business_account" }, "texto", 42]) {
    assert.equal(parseMetaWebhook(value).ok, false);
  }
});

/* ------------------------------------------------------- assinatura --- */

const SEGREDO = "segredo-do-aplicativo";
const assinar = (corpo) => `sha256=${createHmac("sha256", SEGREDO).update(corpo, "utf8").digest("hex")}`;

test("assinatura correta é aceita", () => {
  const corpo = JSON.stringify(texto());
  assert.equal(signatureIsValid(corpo, assinar(corpo), SEGREDO), true);
});

test("corpo alterado invalida a assinatura", () => {
  // É o ponto todo: a Meta assina o conteúdo, não só a origem.
  const corpo = JSON.stringify(texto());
  const adulterado = corpo.replace("minha internet ta lenta", "quero cancelar tudo");
  assert.equal(signatureIsValid(adulterado, assinar(corpo), SEGREDO), false);
});

test("segredo errado não passa", () => {
  const corpo = JSON.stringify(texto());
  assert.equal(signatureIsValid(corpo, assinar(corpo), "outro-segredo"), false);
});

test("assinatura ausente, vazia ou de outro algoritmo é recusada", () => {
  const corpo = JSON.stringify(texto());
  assert.equal(signatureIsValid(corpo, null, SEGREDO), false);
  assert.equal(signatureIsValid(corpo, "", SEGREDO), false);
  assert.equal(signatureIsValid(corpo, "sha1=abcdef", SEGREDO), false);
  assert.equal(signatureIsValid(corpo, "sha256=", SEGREDO), false);
  // Tamanho diferente não pode lançar: `timingSafeEqual` explode com buffers
  // de tamanhos distintos, e uma exceção aqui viraria 500 em vez de 401.
  assert.equal(signatureIsValid(corpo, "sha256=aabb", SEGREDO), false);
});

test("sem segredo configurado nada é aceito", () => {
  const corpo = JSON.stringify(texto());
  assert.equal(signatureIsValid(corpo, assinar(corpo), ""), false);
});
