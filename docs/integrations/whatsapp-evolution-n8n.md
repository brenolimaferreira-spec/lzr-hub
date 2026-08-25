# Canal de WhatsApp: Evolution API → n8n → LZR HUB

Este documento existe porque o container da Evolution foi perdido em 16/08/2026 e
**o passo a passo não estava escrito em lugar nenhum** — nem a chave, nem as
variáveis, nem qual instância o n8n usava. Reconstruir custou mais que teria
custado escrever isto antes.

## O caminho

```
Cliente no WhatsApp
      ↓
Número da BBNET, conectado na Evolution API (local, Docker)
      ↓  webhook
n8n  (monta o payload e chama o HUB)
      ↓  POST /api/channels/n8n  com Bearer
LZR HUB em produção (Railway)
```

O **LZR HUB não conhece o próprio número.** Ele só recebe o número de quem
escreveu, como `externalConversationId`. Trocar o chip é mudança do lado
Evolution/n8n: não exige deploy nem variável nova no Railway.

## 1. Subir a Evolution

```bash
cp .env.evolution.example .env.evolution   # e preencha
docker compose -f docker-compose.evolution.yml --env-file .env.evolution up -d
```

Confere se subiu:

```bash
curl http://127.0.0.1:8081/
```

Deve responder `"Welcome to the Evolution API, it is working!"` com a versão.

⚠️ **A porta de fora é 8081, não 8080.** Nesta máquina há um Apache na 8080, e o
Windows recusa o bind com uma mensagem de permissão que não parece conflito de
porta. A porta é configurável em `EVOLUTION_PORT`.

⚠️ A Evolution v2 **exige Postgres**; ela não sobe sem banco. O compose sobe um
Postgres próprio, separado do banco do LZR HUB de propósito — são dois sistemas
com ciclos de vida diferentes. Sem o `healthcheck`, a API sobe antes do banco
aceitar conexão e morre com `P1001`.

## 2. Conectar o número

Abra o Manager: **http://127.0.0.1:8081/manager**

Entre com o valor de `EVOLUTION_API_KEY` do seu `.env.evolution`. Crie a
instância (canal **Baileys**) e escaneie o QR com o celular do número da BBNET.

Convenção: a instância se chama **`LZR-HUB`**. O nome importa porque é ele que o
fluxo do n8n referencia — se você criar com outro nome, o n8n precisa ser
atualizado, e esse foi um problema real que ficou pendente por dias.

⚠️ A sessão do WhatsApp mora no volume `evolution_instances`. `docker compose
down` preserva; **`down -v` apaga**, e o QR precisa ser escaneado de novo.

## 3. Webhook da Evolution para o n8n

Na instância, aponte o webhook para a URL do seu fluxo no n8n e habilite o evento
de mensagem recebida (`MESSAGES_UPSERT`).

## 4. O que o n8n manda para o LZR HUB

Este é o contrato, e ele está no código (`app/api/channels/n8n/route.ts`):

```
POST https://lzr-hub-production.up.railway.app/api/channels/n8n
Authorization: Bearer <N8N_CHANNEL_SECRET>
Content-Type: application/json

{
  "externalConversationId": "5579998307232",
  "text": "minha internet ta lenta",
  "idempotencyKey": "<id único da mensagem>"
}
```

| Campo | Origem | O que quebra se errar |
|---|---|---|
| `Authorization` | `N8N_CHANNEL_SECRET` do Railway | 401, e nada chega |
| `externalConversationId` | número de quem escreveu, dígitos com o 55 | conversa sem dono |
| `idempotencyKey` | id da mensagem na Evolution (`data.key.id`) | **mensagem repetida é tratada como reenvio** e devolve a resposta anterior sem processar |
| `text` | corpo da mensagem | limite de 5000 caracteres |

## 5. A trava que o fluxo precisa respeitar

A resposta traz `autoReply`. Com `FEATURE_N8N_AUTOREPLY` desligada — que é o
estado atual — ela vem `false` e **`response` vem `null`**.

**O fluxo tem que checar `autoReply` antes de enviar qualquer coisa ao cliente.**
O `null` é deliberado: um fluxo que ignore o campo falha em vez de mandar
mensagem vazia para o cliente.

## 6. Conferir que funcionou

| Tela | O que deve aparecer |
|---|---|
| **Atendimentos** | a conversa, com a resposta marcada *"Sugestão da IA — não enviada ao cliente"* |
| **Comercial → Funil** | cartão novo em "Novo contato" — **só se o número não for cliente no IXC** |
| **Administração → Auditoria** | `channel.message.processed` |

## Depurar quando nada chega

Na ordem:

1. **A instância está conectada?** `curl -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8081/instance/fetchInstances`
2. **O webhook aponta para o n8n certo?** Instância errada é o erro mais comum aqui
3. **O n8n manda o Bearer?** Sem ele a rota responde 401
4. **A `idempotencyKey` é única por mensagem?** Se for fixa, só a primeira mensagem é processada

## Por que a captação de lead às vezes não cria nada

É comportamento correto, não defeito. Só vira lead quem **não** é cliente no IXC.
O número `(79) 99830-7232`, usado nos testes, é o cliente **21857** — mensagens
dele nunca criam lead. Para testar a captação é preciso um número fora da base.

Ver `captureLeadFromContact` em `lib/platform/crm-service.ts`.
