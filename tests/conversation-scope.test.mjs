import test from "node:test";
import assert from "node:assert/strict";
import { NON_CUSTOMER_LIKE, isNonCustomerConversation } from "../lib/platform/conversation-scope.ts";
import { MemoryConversationsRepository } from "../lib/platform/conversations-service.ts";

test("grupo do WhatsApp não é atendimento", () => {
  // Estes são identificadores reais que entraram em produção pelo caminho antigo.
  assert.equal(isNonCustomerConversation("120363373173147301@g.us"), true);
  assert.equal(isNonCustomerConversation("557998996397-1611943118@g.us"), true);
});

test("transmissão e lista também não são", () => {
  assert.equal(isNonCustomerConversation("status@broadcast"), true);
  // Qualquer coisa com "@" é identificador do WhatsApp, não telefone de pessoa.
  assert.equal(isNonCustomerConversation("241489032540249@lid"), true);
});

test("conversa de cliente é só dígitos, e passa", () => {
  assert.equal(isNonCustomerConversation("5579998307232"), false);
  assert.equal(isNonCustomerConversation("557999151289"), false);
});

test("identificador vazio não conta como atendimento", () => {
  // Sem dono, a conversa não é de ninguém — contá-la infla a métrica.
  assert.equal(isNonCustomerConversation(""), true);
  assert.equal(isNonCustomerConversation("   "), true);
});

test("o padrão SQL cobre os mesmos casos que a função", () => {
  // A lista sai do banco e as métricas saem do banco: se os dois filtros
  // divergirem, a tela mostra uma conversa que a métrica não conta.
  const like = (value) => value.includes("@");
  for (const value of ["120363373173147301@g.us", "status@broadcast", "5579998307232", "557999151289"]) {
    assert.equal(like(value), isNonCustomerConversation(value), value);
  }
  assert.equal(NON_CUSTOMER_LIKE, "%@%");
});

test("a lista de atendimentos não mostra conversa de grupo", async () => {
  const repository = new MemoryConversationsRepository();
  const add = (id, content) => repository.add({
    channel: "n8n-whatsapp", externalConversationId: id, role: "customer",
    content, createdAt: "2026-08-25T12:00:00.000Z",
  });
  add("5579998307232", "minha internet caiu");
  add("120363373173147301@g.us", "papo de grupo");
  add("status@broadcast", "recado");

  const lista = await repository.listConversations(20);
  assert.deepEqual(lista.map((item) => item.externalConversationId), ["5579998307232"]);
});

test("filtrar não apaga: a conversa de grupo continua legível pelo id", async () => {
  // Preservar o histórico é o motivo de filtrar na leitura em vez de deletar.
  const repository = new MemoryConversationsRepository();
  repository.add({
    channel: "n8n-whatsapp", externalConversationId: "120363373173147301@g.us",
    role: "customer", content: "papo de grupo", createdAt: "2026-08-25T12:00:00.000Z",
  });
  const mensagens = await repository.getMessages("n8n-whatsapp", "120363373173147301@g.us", 10);
  assert.equal(mensagens.length, 1);
});
