# Canal de WhatsApp: Evolution API → LZR HUB

Este documento existe porque o container da Evolution foi perdido em 16/08/2026 e
**o passo a passo não estava escrito em lugar nenhum** — nem a chave, nem as
variáveis, nem qual instância o n8n usava. Reconstruir custou mais que teria
custado escrever isto antes.

## O caminho

```
Cliente no WhatsApp
      ↓
Número da BBNET, conectado na Evolution API (local, Docker)
      ↓  webhook, com Authorization: Bearer
LZR HUB em produção — POST /api/channels/evolution
```

**O n8n saiu do caminho** (25/08/2026). Ele só repassava o webhook, e a Evolution
manda cabeçalho customizado — confirmado na 2.3.7, o campo `headers` da
configuração de webhook chega intacto. Um serviço a menos para cair, atualizar e
pagar.

Se um dia for preciso enfileirar, transformar ou distribuir o evento, o n8n volta
a fazer sentido — e ele é **gratuito para auto-hospedar**; só a nuvem é paga. A
rota antiga `/api/channels/n8n` continua funcionando para quem tiver fluxo
apontado para ela.

O **LZR HUB não conhece o próprio número.** Ele só recebe o número de quem
escreveu, como `externalConversationId`. Trocar o chip é mudança do lado da
Evolution: não exige deploy nem variável nova no Railway.

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

Convenção: a instância se chama **`LZR-HUB`**. O nome entra na URL de
configuração do webhook, então trocá-lo obriga a reconfigurar.

⚠️ A sessão do WhatsApp mora no volume `evolution_instances`. `docker compose
down` preserva; **`down -v` apaga**, e o QR precisa ser escaneado de novo.

## 3. Apontar o webhook para o HUB

Com a instância já criada e conectada.

⚠️ **No PowerShell, `curl` é apelido do `Invoke-WebRequest` e não aceita `-H`.**
Use o bloco nativo abaixo, ou chame `curl.exe` (com o `.exe`) para o curl de verdade.

```powershell
$env = Get-Content "$PSScriptRoot\..\..\.env.evolution" -ErrorAction SilentlyContinue
$key = ($env | Where-Object { $_ -like 'EVOLUTION_API_KEY=*' }) -replace '^EVOLUTION_API_KEY=',''
$secret = 'COLE_AQUI_O_N8N_CHANNEL_SECRET_DO_RAILWAY'

$body = @{ webhook = @{
    enabled = $true
    url     = 'https://lzr-hub-production.up.railway.app/api/channels/evolution'
    headers = @{ Authorization = "Bearer $secret" }
    byEvents = $false
    base64   = $false
    events   = @('MESSAGES_UPSERT')
} } | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8081/webhook/set/LZR-HUB' `
  -Headers @{ apikey = $key } -ContentType 'application/json' -Body $body
```

Em bash (WSL, Git Bash):

```bash
KEY=$(grep '^EVOLUTION_API_KEY=' .env.evolution | cut -d= -f2)
curl -X POST http://127.0.0.1:8081/webhook/set/LZR-HUB   -H "apikey: $KEY" -H "content-type: application/json"   -d '{"webhook":{"enabled":true,
       "url":"https://lzr-hub-production.up.railway.app/api/channels/evolution",
       "headers":{"Authorization":"Bearer <N8N_CHANNEL_SECRET>"},
       "byEvents":false,"base64":false,
       "events":["MESSAGES_UPSERT"]}}'
```

O segredo é o `N8N_CHANNEL_SECRET` **do Railway** — o do `.env.local` é outro, e
usar o errado dá 401. Dá para separar os dois definindo `EVOLUTION_WEBHOOK_SECRET`
em produção, que tem preferência quando existe.

Para saber se acertou sem mandar mensagem nenhuma, chame a rota de produção com
um evento que ela ignora: **401** é segredo errado, **503** é segredo ausente lá,
e `{"ignored":true,"reason":"outro-evento"}` é o segredo certo.

⚠️ **Só `MESSAGES_UPSERT`.** A Evolution emite dezenas de eventos por minuto
(conexão, presença, status); os outros são ignorados pela rota, mas assinar só o
que interessa evita tráfego à toa.

⚠️ A Evolution inclui a **própria chave de API** no corpo de todo webhook
(campo `apikey`). Não aponte webhook para URL em que você não confia.

## 4. O que a rota faz com o que chega

`app/api/channels/evolution/route.ts` traduz o webhook e chama o mesmo pipeline
de sempre. As recusas importam mais que o caminho feliz:

| Situação | O que acontece |
|---|---|
| Sem `Authorization: Bearer` correto | **401** |
| Mensagem de **grupo** (`@g.us`) | ignorada — grupo não é atendimento |
| Mensagem **nossa** (`fromMe`) | ignorada — senão a IA responde à própria resposta |
| Status/transmissão | ignorada |
| Áudio, imagem, figurinha | ignorada — o pipeline lê texto |
| Outros eventos | ignorados, com **200** para não encher o log da Evolution |
| Mesmo webhook reentregue | não processa duas vezes (`key.id` é a chave de idempotência) |

⚠️ Grupo entrando como atendimento **aconteceu de verdade** pelo caminho antigo:
havia conversas `@g.us` na tela de Atendimentos, com intenção classificada e
transbordo contado. É por isso que a recusa é explícita e tem teste.

## 5. A trava do envio

A resposta traz `autoReply`. Com `FEATURE_N8N_AUTOREPLY` desligada — o estado
atual — ela vem `false` e **`response` vem `null`**.

Hoje **ninguém envia nada ao cliente**: o HUB registra e sugere. Quando o envio
for ligado, quem envia passa a ser o próprio HUB chamando a Evolution
(`/message/sendText/{instance}`) — antes era o n8n. Isso ainda não existe.

⚠️ E não deve ser ligado enquanto as respostas do pipeline forem de homologação
("preparei a segunda via *fictícia*"). Ver a seção da IA no CLAUDE.md.

## ⚠️ Mudou o webhook? Reinicie a instância

A Evolution **guarda a configuração do webhook em cache**. Alterar a URL ou o
cabeçalho **não afeta a instância que já está rodando** — ela continua entregando
com a configuração antiga até reiniciar.

Isso já custou uma sessão inteira de depuração: um Bearer vazio foi corrigido às
15:22, a mensagem de teste chegou às 15:31 e mesmo assim saiu com o valor velho,
tomou 401 na nossa API e **sumiu sem deixar rastro em lugar nenhum**.

Depois de qualquer mudança no webhook:

```bash
curl -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8081/instance/restart/LZR-HUB
```

A instância reconecta sozinha em poucos segundos, sem QR novo.

### Como saber se uma mensagem se perdeu assim

A Evolution registra o payload que **montou**, não o resultado da entrega — um
401 do outro lado não aparece no log dela. O jeito de conferir é pela
idempotência: reenvie o mesmo payload para a rota e compare o `correlationId`.

- `correlationId` **igual** ao de uma reentrega anterior → a mensagem estava
  gravada, a entrega original funcionou
- `correlationId` **novo** → aquela mensagem nunca tinha sido processada, e a
  entrega original se perdeu

O payload completo sai do log:

```bash
docker logs evolution_api --since 30m | grep -A 25 "messages.upsert"
```

## Trocar o segredo sem derrubar o canal

O segredo vive em dois lugares que não dá para salvar ao mesmo tempo: a variável
no Railway e o cabeçalho do webhook na Evolution. Por isso a rota aceita
`EVOLUTION_WEBHOOK_SECRET` **e** `N8N_CHANNEL_SECRET` — nesta ordem, os dois
válidos ao mesmo tempo.

A rotação, sem janela de 401:

1. No Railway, **adicione** `EVOLUTION_WEBHOOK_SECRET` com o valor novo. O antigo
   continua valendo, então nada para de funcionar
2. Espere o deploy terminar
3. Atualize o webhook da Evolution com o valor novo (comando do passo 3)
4. Confirme com o evento ignorado — tem que responder `200`
5. Só então **remova** `N8N_CHANNEL_SECRET` do Railway

Gerar um segredo novo:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 })) -replace '[+/=]',''
```

⚠️ Um segredo que apareceu em print, chat ou log **já vazou**, mesmo que o canal
siga funcionando. Trocar é barato; descobrir depois quem usou não é.

## 6. Conferir que funcionou

| Tela | O que deve aparecer |
|---|---|
| **Atendimentos** | a conversa, com a resposta marcada *"Sugestão da IA — não enviada ao cliente"* |
| **Comercial → Funil** | cartão novo em "Novo contato" — **só se o número não for cliente no IXC** |
| **Administração → Auditoria** | `channel.message.processed` |

## Depurar quando nada chega

Na ordem:

1. **A instância está conectada?** `curl -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8081/instance/fetchInstances`
2. **O webhook está configurado?** `curl -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8081/webhook/find/LZR-HUB` — responder `null` significa que não há webhook na instância
3. **O Bearer está certo?** Sem ele a rota responde 401, e a Evolution registra a falha no log dela
4. **A rota respondeu `ignored`?** Aí não é falha de entrega: veja o `reason` na tabela acima

## O nono dígito

⚠️ O WhatsApp entrega o número **sem o nono dígito** em alguns casos. Medido no
canal real: chegou `557999151289` — DDD mais **oito** dígitos — para um celular.
O próprio log da Evolution mostra os dois formatos convivendo:

```
Register exists for [5579999151289@s.whatsapp.net, 557999151289@s.whatsapp.net]?
```

Se o cliente escrever pelo formato curto e o IXC guardar o longo, a busca não
acha e **um cliente antigo vira lead**. Por isso `findCustomerByPhone` procura os
dois formatos — e continua valendo a regra de **exatamente um resultado**: se os
dois formatos apontarem para cadastros diferentes, alguém digitou errado num
deles, e escolher um seria escolher no escuro.

Ver `phoneCandidates` em `lib/integrations/ixc/readonly-provider.ts`.

## Por que a captação de lead às vezes não cria nada

É comportamento correto, não defeito. Só vira lead quem **não** é cliente no IXC.
O número `(79) 99830-7232`, usado nos testes, é o cliente **21857** — mensagens
dele nunca criam lead. Para testar a captação é preciso um número fora da base.

Ver `captureLeadFromContact` em `lib/platform/crm-service.ts`.
