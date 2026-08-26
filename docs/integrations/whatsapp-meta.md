# Canal de WhatsApp oficial: Meta Cloud API → LZR HUB

Este é o **caminho oficial e recomendado**. O outro
([`whatsapp-evolution.md`](whatsapp-evolution.md)) usa Baileys, que é uma
reimplementação não oficial do WhatsApp Web — a Meta detectou e avisou que a
conta poderia ser restringida.

## Por que migrar não foi opção de estilo

O aviso que chegou no WhatsApp Business dizia, em resumo: *"parece que você pode
estar usando ferramentas que não seguem nossos termos de serviço para enviar
mensagens automáticas ou em massa; sua conta poderá ser restringida"*.

Não é falso positivo. Automação por Baileys viola os Termos de Serviço, e o
número em risco é **o que os clientes usam para falar com o provedor**. Perdê-lo
é perder o canal inteiro, de uma vez, sem aviso prévio.

## O caminho

```
Cliente no WhatsApp
      ↓
Número da BBNET no WhatsApp Business Platform (Cloud API)
      ↓  webhook assinado (X-Hub-Signature-256)
LZR HUB em produção — POST /api/channels/meta
```

Tudo **depois** do webhook é o mesmo pipeline já testado: classificação de
intenção, sugestão de resposta, captação de lead, métricas. Só o tradutor muda.

## 1. Do lado da Meta (o trabalho que não é código)

1. Conta no **Meta Business** e verificação da empresa
2. Criar um aplicativo em developers.facebook.com com o produto **WhatsApp**
3. Adicionar o número da BBNET (ou migrar o número existente do WhatsApp
   Business — a Meta tem processo próprio para isso)
4. Guardar o **App Secret** do aplicativo

⚠️ Migrar um número já em uso apaga o histórico de conversas do aparelho. O
histórico que interessa ao atendimento já está no LZR HUB, mas vale saber antes.

## 2. Variáveis no Railway

| Variável | O que é |
|---|---|
| `FEATURE_META_WHATSAPP` | `true` liga a rota |
| `META_VERIFY_TOKEN` | Você inventa. Repete no painel da Meta ao cadastrar o webhook |
| `META_APP_SECRET` | O **App Secret** do aplicativo |

⚠️ **Os dois segredos têm papéis diferentes, e confundi-los deixa a rota aberta.**
O `META_VERIFY_TOKEN` serve **só** ao handshake de cadastro do webhook. Quem
protege cada mensagem é a **assinatura** feita com o `META_APP_SECRET`.

## 3. Cadastrar o webhook

No painel do aplicativo → WhatsApp → Configuration → Webhook:

- **Callback URL**: `https://lzr-hub-production.up.railway.app/api/channels/meta`
- **Verify token**: o mesmo valor de `META_VERIFY_TOKEN`
- **Campos**: assine **`messages`**

A Meta chama a URL com `hub.challenge` e espera o valor de volta, cru. Se as
variáveis estiverem certas, a verificação passa na hora.

## 4. O que a rota faz

| Situação | O que acontece |
|---|---|
| Assinatura ausente, errada, ou **corpo adulterado** | **401** |
| Recibo de entrega/leitura | ignorado, com 200 |
| Áudio, imagem, documento, botão | ignorado — o pipeline lê texto |
| Outro objeto ou outro campo | ignorado |
| Mesmo `wamid` reentregue | não processa duas vezes |

⚠️ Evento ignorado responde **200** de propósito: a Meta reenfileira o que não
recebe 200, e recusar um recibo de leitura viraria reentrega infinita.

⚠️ O recibo de entrega chega pelo **mesmo** webhook, num array `statuses` em vez
de `messages`. Sem separar, a IA responderia ao próprio "entregue".

## 5. A diferença que muda a operação

Na Cloud API, **responder a quem te procurou é livre por 24 horas**. Passado
esse prazo, ou para iniciar conversa, é preciso **modelo aprovado** pela Meta.

Isso não afeta o modo observação atual (a IA não envia nada). Afeta quando o
envio for ligado: resposta de atendimento cabe na janela de 24h; a régua de
cobrança, que **inicia** conversa, vai exigir modelo aprovado.

## Conferir que funcionou

| Tela | O que deve aparecer |
|---|---|
| **Atendimentos** | a conversa, com a resposta marcada *"Sugestão da IA — não enviada ao cliente"* |
| **Comercial → Funil** | cartão novo — só se o número não for cliente no IXC |
| **Administração → Auditoria** | `channel.message.processed` |

## Depurar

1. **A verificação passou?** Sem ela a Meta nem começa a entregar
2. **401 nos logs?** Assinatura — confira o `META_APP_SECRET`, e que ele é o
   *App Secret*, não o token de acesso nem o verify token
3. **`ignored` com `reason`?** Não é falha de entrega; a razão diz o que era
4. **Nada chegando?** No painel da Meta, WhatsApp → Configuration, o webhook
   mostra as entregas recentes e o código de resposta que recebeu de nós

## E o caminho antigo

`/api/channels/evolution` e `/api/channels/n8n` continuam funcionando. Desligar
é decisão separada: enquanto o número não estiver migrado, ele ainda é o canal.
Quando estiver, vale remover para não manter porta aberta sem uso.
