# LZR HUB — guia para quem (ou o que) vai mexer neste repositório

Este documento existe para que qualquer pessoa **e qualquer assistente de IA** trabalhando neste projeto tenha o mesmo entendimento da infraestrutura e das convenções. Leia antes de propor mudanças.

## O que é o produto

Plataforma de atendimento com IA para a **BBNET**, um provedor de internet (ISP). A IA atende o cliente final (N1: fatura, segunda via, sem conexão, lentidão), consulta o ERP do provedor e passa para um humano quando não deve decidir sozinha.

## Onde roda

| Coisa | Onde |
|---|---|
| Aplicação | **Railway** — https://lzr-hub-production.up.railway.app |
| Repositório | **github.com/LZRBBNET/lzr-hub** (organização, não conta pessoal) |
| Banco de dados | **Postgres** gerenciado pelo Railway, no mesmo projeto |
| Ponte com o ERP | VM própria (Proxmox) em `https://ixc-bridge.bbnetup.com.br` |

Deploy é **automático**: push na `main` dispara build e deploy no Railway. Não existe passo manual.

### Histórico que evita retrabalho

- **Não usamos mais Cloudflare Workers nem D1.** O projeto nasceu de um template `vinext` voltado a Workers; isso foi migrado para Node + Postgres. Se encontrar referência a D1, binding `DB` ou `cloudflare:workers`, é resíduo.
- **Não usamos mais "ChatGPT Sites".** Foi a hospedagem inicial, abandonada por ficar presa a uma conta pessoal com acesso restrito.
- O `wrangler.jsonc` ainda existe, mas serve apenas ao ambiente de demonstração mock; **não é o caminho de produção**.

## Stack

- **Next.js 16 / React 19** rodando via **`vinext`** (Next sobre Vite). O comando de produção é `vinext start`, não `next start`.
- **Drizzle ORM** com **`drizzle-orm/pg-core`** e driver `pg`. Dialeto é **postgresql**.
- Testes com o runner nativo do Node (`node --test`), sem framework externo.
- TypeScript com `--experimental-strip-types` nos testes (por isso **sintaxe de parameter property no construtor não funciona** — declare o campo e atribua no corpo).

## Comandos

```bash
npm run dev         # desenvolvimento local
npm run build       # build de produção
npm start           # roda migrações e sobe o servidor (é o que o Railway executa)
npm test            # build + suíte completa
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run db:generate # gera migração a partir do schema
npm run db:migrate  # aplica migrações no Postgres
```

`npm start` roda `scripts/migrate-postgres.mjs` **antes** de subir o servidor. Sem `DATABASE_URL` ele avisa e segue sem migrar, em vez de derrubar o boot.

### ⚠️ `npm run dev` só às vezes enxerga o Postgres

`npm run dev` sobe o Vite sobre o **runtime do Cloudflare Workers** (Miniflare). Ali o driver `pg` abre socket TCP e frequentemente trava: a rota devolve *"The Workers runtime canceled this request because it detected that your Worker's code had hung"*.

É **intermitente**, não determinístico — na mesma execução `/api/audit` e `/api/knowledge` responderam 200 enquanto `/api/support/metrics`, `/api/conversations` e `/api/sales/goals` travaram. Recarregar às vezes resolve, às vezes não. Não confie no resultado: uma tela vazia no `npm run dev` pode ser o runtime, não o seu código.

Produção não tem esse problema: o Railway roda `vinext start`, que é Node.

Consequência prática: **não dá para conferir tela de banco rodando só `npm run dev`.** Isso explica boa parte da ficção que sobreviveu tanto tempo nessas telas — ninguém conseguia ver o dado real localmente.

### Como conferir tela de banco na sua máquina

O caminho que funciona é rodar em **modo produção**, que usa Node de verdade — o mesmo runtime do Railway.

```bash
docker run -d --name lzr-dev-pg -e POSTGRES_PASSWORD=devlocal -e POSTGRES_DB=lzrhub -p 55432:5432 postgres:16-alpine
```

Aponte `DATABASE_URL` para `postgres://postgres:devlocal@localhost:55432/lzrhub` no `.env.local`, rode `npm run db:migrate` e `node scripts/seed-dev.mjs` (o seed **recusa** qualquer banco que não seja localhost). Depois:

```bash
npm run build
npm start                          # porta 3000, Node de verdade
node scripts/dev-static-bridge.mjs # porta 3100 — abra esta no navegador
```

A ponte existe por um motivo específico: o `vinext start` local devolve **404 para tudo em `/assets/*`**, então a página chega sem CSS nem JS e a tela fica ilegível. `scripts/dev-static-bridge.mjs` serve os estáticos de `dist/client` e repassa o resto para a porta 3000. No Railway isso não é preciso — lá o `vinext start` serve os estáticos corretamente.

⚠️ `npm start` roda `db:migrate` antes de subir, mas **esse script não lê o `.env.local`** — ele avisa que não há `DATABASE_URL` e segue. O servidor em si lê. Se precisar migrar, rode `npm run db:migrate` com a variável no ambiente.

O `npm run dev` continua ótimo para tudo que não toca banco: é mais rápido e tem recarga quente.

`scripts/seed-dev.mjs` cria 8 usuários, 46 conversas espalhadas em 30 dias, massivas, documentos e leads. É massa de desenvolvimento, não dado de demonstração embutido no produto.

## Banco de dados

Schema único em [`db/schema.ts`](db/schema.ts). Para mudar:

1. Edite o schema
2. `npm run db:generate` (gera SQL em `drizzle/`)
3. **Commite o SQL e o snapshot gerados** — o Railway aplica no deploy

Nunca edite um arquivo de migração já commitado.

`DATABASE_URL` é injetada pelo Railway via referência `${{Postgres.DATABASE_URL}}`. Esse endereço é da **rede privada** e não funciona fora do Railway — para rodar scripts da sua máquina, use o `DATABASE_PUBLIC_URL`.

## Feature flags e a regra do fail-closed

O sistema tem várias flags (`FEATURE_*`) e **nasceram todas desligadas**. Isso foi deliberado, não descuido: o ambiente publicado era acessível e ainda não tinha login em uso, então nada que produzisse efeito real no mundo podia estar ligado por padrão. Várias já foram ligadas em produção desde então — a tabela abaixo é o estado real, checado via `railway variables --service lzr-hub --environment production`, não o estado de nascença.

Flags relevantes:

| Flag | O que libera | Estado em produção |
|---|---|---|
| `FEATURE_AUTH` | Exige login e aplica RBAC nas rotas | **ligada** |
| `FEATURE_N8N_CHANNEL` | Canal WhatsApp recebe e registra mensagem (nome histórico: o n8n saiu do caminho, a Evolution chama a API direto) | **ligada** (modo observação — ver abaixo) |
| `FEATURE_N8N_AUTOREPLY` | A IA **responde ao cliente** pelo canal | desligada |
| `FEATURE_QUEUES` | Filas reais (Redis/BullMQ) | desligada |
| `FEATURE_IXC_WRITE` | Escrita no ERP — as 4 operações do catálogo (segunda via, OS, renegociação, cadastro de cliente) | **ligada** |
| `FEATURE_IXC_FULL_BASE` | Leitura da **base inteira** do IXC, não só da allowlist | **ligada** |
| `FEATURE_LLM_INTENT` | Classificação de intenção por modelo de linguagem (Groq) | **ligada** |
| `FEATURE_COPILOT_LLM` | O copiloto do atendente **redige** a resposta a partir dos trechos citados | desligada — sem ela o copiloto mostra os trechos como estão |
| `FEATURE_TELEGRAM_ALERTS` | Ingestão de alerta de rede real via webhook do Telegram | desligada — pendente criar o bot e chamar `setWebhook` (ver `app/api/integrations/telegram/webhook`) |
| `IXC_MODE` | `disabled` / `staging-readonly` | `staging-readonly` |

⚠️ Isto muda o que é verdade no resto deste documento: com `FEATURE_AUTH=true` já ligada, toda rota sabe quem está agindo — o pré-requisito do milestone M4 (escrita no IXC, cobrança, venda) está satisfeito nesse ponto específico. Com `FEATURE_IXC_FULL_BASE=true`, telas que diziam "exige leitura da base inteira" (Chamados, Churn, Relatórios comerciais) agora leem a base cheia de verdade em produção, não só a allowlist.

### Modo observação do canal (`FEATURE_N8N_CHANNEL` ligada, `FEATURE_N8N_AUTOREPLY` desligada)

Esse é o estado atual em produção e é deliberado: o canal recebe a mensagem do cliente, classifica a intenção e a IA **produz** a resposta — mas ninguém a envia. Ela fica gravada em `channel_messages` com `role = "suggestion"`, aparece na tela marcada como não enviada, e o desfecho é registrado como `suggested`, que **não** entra na conta de "resolvido sem humano". A pergunta de CSAT também não é feita: não dá para avaliar um atendimento que o cliente não recebeu.

⚠️ O fluxo do n8n precisa checar o campo `autoReply` da resposta antes de enviar qualquer coisa. Com a flag desligada, `response` volta `null` justamente para que um fluxo que ignore `autoReply` falhe em vez de mandar mensagem vazia ao cliente.

### Antes de ligar qualquer flag

Pergunte: *isso passa a produzir efeito no mundo real?* Se sim (mensagem enviada, cobrança gerada, cadastro alterado), a ação precisa estar protegida por login, auditada e idempotente antes de ser ligada.

## A "IA" e o classificador de intenção

⚠️ **Leia isto antes de mexer no agente.** O pipeline em `lib/agent/` **não usa modelo de linguagem** para responder: `analyzeIntent` é uma cadeia de expressões regulares e as respostas são textos fixos por intenção. Isso é deliberado no que toca à resposta — ela carrega garantias que o projeto não quer perder (nunca afirmar ação não executada, exigir evidência, transbordar quando não sabe).

O problema medido está na **classificação**: em 13 conversas reais, 11 transbordaram por `low_intent_confidence`. A cadeia é `analyzeIntent` não casa nenhuma regra → confiança 0,55 → `handoff.ts` corta em 0,6 → transborda. Cliente real não escreve como a regra espera.

`FEATURE_LLM_INTENT` liga um classificador com modelo de linguagem (Groq, camada gratuita) que escolhe **um item de uma lista fechada** de intenções. O modelo nunca escreve texto para o cliente — a saída é um enum validado contra `INTENTS`, e resposta fora da lista é descartada.

**Groq foi escolhido em vez do Gemini por privacidade**: na camada gratuita do Gemini o Google usa o conteúdo enviado para treinar modelos e revisor humano pode ver. A Groq não treina com dado de cliente em nenhuma camada. Ainda assim, a mensagem sai **sanitizada** (`sanitizeHandoffText` remove e-mail, CPF e telefone) — o provedor não precisa disso para entender a intenção.

Fail-closed em três camadas: sem `GROQ_API_KEY` não há chamada; erro ou demora acima de 4s cai na regex; resposta inválida é descartada. Em nenhum caso o atendimento para.

### O copiloto do atendente é outra coisa

`lib/platform/copilot-service.ts` **não usa** `runAgentPipeline`, e isso é deliberado. O pipeline escreve texto de homologação ("preparei a segunda via *fictícia*"); oferecer isso ao atendente como "resposta pronta para enviar" entregaria a palavra *fictícia* a um cliente real.

O copiloto responde a partir da **base de conhecimento** e cita título e versão do documento. Sem trecho que sustente, ele diz que não sabe — e o modelo nem chega a ser chamado. Com `FEATURE_COPILOT_LLM` ligada o modelo reescreve os trechos, mas recebe **só** eles, devolve `NAO_SEI` quando não dão conta, e os trechos continuam na tela ao lado da resposta.

A busca é por palavra, não semântica (`FEATURE_PGVECTOR` desligada). O cliente escreve "ta sem net" e o documento se chama "cliente sem conexão" — por isso a **intenção já classificada** entra como busca separada, fazendo a ponte entre os dois vocabulários. Somar os termos numa busca só não funcionaria: aumentaria o divisor da pontuação e afundaria o documento certo.

⚠️ `intentOverride` é **contexto operacional**: a rota do agente o recusa com 403 se vier do cliente, junto com `channel` e `simulationProfile`. Quem escolhe a própria intenção contorna a decisão de transbordo.

## A ponte com o IXC (ERP)

O IXC exige **IP liberado** para aceitar chamadas. Como a aplicação roda em nuvem sem IP fixo, existe um relay Node em VM própria com IP dedicado, atrás de HTTPS (Caddy + Let's Encrypt) e firewall.

Detalhes que economizam horas de depuração:
- O IXC exige método **GET com corpo JSON** para listagens (sim, GET com body) e cabeçalho `ixcsoft: listar`
- O endpoint de contratos é `cliente_contrato`, não `contrato`
- Ordens de serviço filtram por `id_cliente`, não `id_assunto`

Ver [`docs/integrations/ixc-data-mapping.md`](docs/integrations/ixc-data-mapping.md).

### Escrita no IXC: o que já existe e o que não

⚠️ **`FEATURE_IXC_WRITE` está ligada em produção** (conferido no painel do Railway em 13/08/2026). Não é ensaio: quem tem a permissão `ixc.write` — hoje **Administrador** e **Cobrança** — abre ordem de serviço, renegocia dívida e cadastra cliente **no ERP de verdade**, clicando na tela. `IXC_WRITE_ENABLED` (a trava de boot mais ampla, da "Fase 3A") continua desligada e não deve ser mexida.

As **quatro** operações do catálogo estão implementadas (`lib/platform/ixc-write-service.ts`): **segunda via de boleto** (`POST /webservice/v1/get_boleto`), **abertura de OS** (`POST /webservice/v1/su_oss_chamado`), **renegociação de dívida** (wizard de 5 passos) e **cadastro de cliente** (`POST /webservice/v1/cliente`).

O cadastro de cliente só nasce de um **lead ganho** do funil (issue #17) — era o gatilho que faltava, e sem ele um cadastro novo não teria origem. Antes de gravar, o documento é conferido pelos dígitos verificadores (`lib/platform/document-check.ts`) e o IXC é consultado pelo CPF/CNPJ: **duplicar cliente é dois fluxos de fatura e um contrato órfão**, e apagar cadastro com contrato pendurado não é opção. O documento fica gravado no IXC **com máscara**, igual ao telefone — a busca tenta os dois formatos, senão o "não existe" seria falso e autorizaria a duplicata.

⚠️ `cidade` e `uf` no cadastro são **códigos internos do IXC** (o cadastro 21857 tem `cidade: "1759"`, `uf: "28"`), não nomes nem IBGE. Por isso vêm de lista lida do ERP, nunca digitados.

⚠️ **A renegociação não é atômica, e isso muda como ela falha.** O primeiro passo (`renegociar_selecionados`) **já cria o registro no ERP** e devolve `id_renegociacao`; os passos seguintes calculam juro/multa e finalizam. Se algo falhar no meio, o cliente fica com uma renegociação pela metade grudada nas faturas reais, e a API do IXC não tem endpoint de desfazer. Por isso o ledger grava o `id_renegociacao` e o passo alcançado, com o detalhe começando em `PENDENTE DE CONFERÊNCIA MANUAL`. Um `failed` seco ali esconderia um rastro que ficou no ERP.

Nenhum valor é calculado por nós: o total é a soma das faturas lidas do IXC e o acréscimo é o que o próprio IXC devolve em `calcula_juros_multa`. `valor_descontos` é sempre `"0,00"` — conceder desconto é justamente o que o projeto se recusa a automatizar, e o pipeline do agente já transborda para humano nesse caso.

Quem dispara precisa reenviar o **total que viu na tela**; se não bater com o que o IXC devolve naquele instante, a operação é recusada. Tela com dado velho não renegocia.

Toda escrita passa pela mesma régua, nesta ordem: idempotência → política → `FEATURE_IXC_WRITE` → chamada. Bloqueio também entra no ledger `ixc_write_operations`: auditoria existe para provar decisão, não só sucesso.

⚠️ **Assunto, setor e filial não são constantes.** A base da BBNET tem **159 assuntos** (`su_oss_assunto`), **12 setores** (`empresa_setor`) e **21 filiais** (`filial`), com ids salteados. Assunto e setor são validados contra a lista lida do ERP no momento da chamada; a filial vem do `filial_id` do cadastro do cliente. Fixar qualquer um desses números abriria chamado real na fila errada — ou na empresa errada do grupo. `scripts/ixc-probe-os-catalog.mjs` foi o que levantou esses números antes de existir código.

⚠️ **O IXC recusa com HTTP 200 e `type: "error"` no corpo.** Sem checar isso, uma recusa viraria "sucesso" no ledger e ninguém iria atrás da OS que não existe.

O formato da **resposta de sucesso** das duas operações não está confirmado (a coleção Postman não tem exemplo salvo e nenhuma foi executada em produção). Por isso o ledger guarda a resposta crua em vez de campos inventados.

## Convenções de código

**Padrão de repositório com injeção de dependência.** Toda lógica que toca o banco fica atrás de uma interface, com duas implementações: uma real (`Db*Repository`) e uma em memória (`Memory*Repository`) usada nos testes. Isso permite testar regra de negócio sem banco. Exemplos: `lib/platform/auth.ts`, `lib/platform/support-metrics.ts`, `lib/platform/n8n-channel-service.ts`.

**Rotas de API são finas.** Elas validam entrada, chamam o serviço e devolvem a resposta. Regra de negócio não mora em `app/api/`.

**Degradar, não mentir.** Quando uma fonte de dados não está disponível, a resposta diz que está indisponível — nunca devolve zero ou valor inventado como se fosse real. O painel de métricas e a tela de auditoria seguem isso.

**Nada de dado pessoal em log ou resumo.** Há sanitização obrigatória (e-mail, CPF/CNPJ, telefone) antes de gravar qualquer texto vindo de conversa. Ver `sanitizeHandoffText` em `lib/agent/handoff.ts`.

**Contexto operacional vem do servidor.** Rotas nunca aceitam do cliente campos como `channel`, `simulationProfile` ou `role` — isso é rejeitado com 403 (`hasUntrustedOperationalContext` em `app/api/agent/route.ts`).

**Nada de cor fixa.** `app/globals.css` tem tema claro e escuro, e cada cor é declarada **uma vez** com `light-dark(claro, escuro)`. Escrever `#64748b` numa regra — ou num `style={{}}` de componente — produz algo que funciona no claro e some no escuro. Se a cor não existe como token, crie o token. Dois azuis existem de propósito: `--blue` é azul **como texto** (claro no tema escuro) e `--blue-solid` é azul **como fundo de botão** (escuro o bastante para texto branco em cima).

**Cliente não importa de servidor.** Componente com `"use client"` que importa um serviço de `lib/platform/` arrasta as dependências dele para o pacote do navegador. Já aconteceu: `billing.tsx` importava uma constante de `collection-rules-service.ts` e levou junto `node:crypto` e o schema do Drizzle — quebrava o `npm run dev` inteiro e mandava 40 KB de ORM para o navegador em produção. Quando a tela precisa de um tipo ou constante, ele mora num arquivo `*-shared.ts` sem dependência de servidor.

**Estilo.** Parte do código usa formatação bem compacta (várias instruções por linha). Ao editar um arquivo, siga o estilo dele em vez de reformatar.

**Comentários explicam o porquê, não o quê.** Especialmente decisões de segurança e escolhas não óbvias.

## Antes de abrir PR ou dar push

```bash
npm run typecheck && npm run lint && npm test
```

Os três precisam passar. Hoje a suíte tem **518 testes**.

## Segurança — pontos já decididos

- Senha com **scrypt** (nativo do Node — evita dependência compilada que quebraria o build), salt por usuário, comparação de tempo constante
- Sessão em cookie `HttpOnly`/`SameSite=Lax`/`Secure`; **o banco guarda só o SHA-256 do token**
- Login que falha sempre responde a mesma mensagem, e gasta o mesmo tempo mesmo com e-mail inexistente
- Segredos **nunca** vão para o repositório. `.env*` é ignorado, exceto os `.example`

Ver [`docs/security/authentication.md`](docs/security/authentication.md).

## Limites conhecidos (não são bugs a "descobrir")

- A tela de Usuários gerencia contas de verdade: criar, desativar/reativar, trocar perfil e resetar senha, tudo auditado. A senha é **sempre gerada pelo sistema** e mostrada uma única vez; ninguém escolhe senha de terceiro. Duas travas impedem auto-bloqueio: não dá para desativar ou rebaixar a própria conta, nem deixar o sistema sem nenhuma conta capaz de gerenciar usuários
- Troca de senha pelo próprio usuário fica no rodapé da barra lateral (botão "Senha"). Exige a senha atual e **derruba as outras sessões** — trocar a senha precisa expulsar quem estava dentro
- Conta criada ou senha resetada pelo admin nascem com `must_change_password`: no primeiro acesso a pessoa é obrigada a definir a sua, num diálogo que não fecha
- **Não há envio de e-mail no projeto** (sem SMTP, sem provedor). Por isso "esqueci minha senha" não manda link: registra um pedido que aparece na tela de Usuários, e quem administra gera a senha nova e entrega. O pedido é aceito mesmo para e-mail sem conta — recusar revelaria quais endereços têm conta
- O rate limit de login é **memória do processo**: com mais de uma instância cada uma conta a sua parte. Migra para Redis quando houver escala horizontal
- Custo por atendimento não é medido (depende do Langfuse, issue #6)
- Tempo médio de atendimento também não é medido — a Visão geral escreve isso em vez de estimar
- Responder pela tela de Atendimentos ainda não existe: quem responde é o fluxo do n8n, então o campo fica desabilitado. É por isso que o copiloto tem botão **"Copiar"** e não "Enviar", e por isso a auditoria registra `copilot.suggestion.used` como *copiada*, não como enviada
- A base de conhecimento **não é segmentada por perfil**: todo documento publicado é visível a quem tem `customer.read`. Não existe conceito de documento restrito
- A conversa do canal ainda **não é associada** ao cadastro do IXC na tela de Atendimentos, mas casar telefone com cliente **já funciona**: `findCustomerByPhone` em `lib/integrations/ixc/readonly-provider.ts`. O segredo é o formato — o canal manda `5579998307232` e o IXC guarda `(79) 99830-7232`; dígitos puros devolvem zero em silêncio. A regra é **exatamente um resultado ou nada**: buscar pelo final do número trouxe 4 clientes diferentes na base real, e identificar o cliente errado é pior que não identificar
- `FEATURE_IXC_FULL_BASE` está **ligada** em produção (exigia `FEATURE_AUTH=true`, o código recusa subir sem isso — e ambas já estão de pé). A lista de Clientes deixou de ser só a allowlist de homologação; Chamados mostra a fila real do provedor (OS não fechadas, paginadas). A OS não traz o nome do cliente — só `id_cliente` e endereço — e buscar o nome seria uma consulta por linha da página. `scripts/ixc-probe-listing.mjs` foi o que confirmou, antes de ligar, que a listagem paginada do IXC de fato funciona
- Churn é **realizado**, não previsto: medimos quem saiu, não quem vai sair. Não há score de saúde nem elegibilidade de upgrade — nada disso é calculado, e a tela diz o que faltaria
- O CRM passou a existir (issue #17): **Comercial → Funil** grava lead, etapa, origem e histórico de verdade. Conversão e ciclo médio são calculados do que está gravado, e valem `null` — não zero — enquanto nada tiver encerrado. **Valor de pipeline continua não existindo**: exigiria um valor estimado por lead, que ninguém preenche; somar plano suposto daria número bonito e falso
- As **etapas do funil são fixas** (`LEAD_STAGES` em `lib/platform/crm-shared.ts`), não configuráveis. A issue pedia configuráveis; a escolha foi consciente, porque etapa configurável só serve depois que a operação sabe qual é o funil dela — e ninguém nunca usou um aqui
- Contato desconhecido no WhatsApp vira lead sozinho. **Quem já é cliente no IXC não vira** — e, se o IXC não responder, ninguém vira: na dúvida o funil não cria, senão um ERP fora do ar encheria o funil de cliente antigo
- O motivo de cancelamento do IXC vem como código numérico e a API não expõe a tabela de tradução
- Não há integração de monitoramento de rede (alerta, potência em massa, correlação geográfica). Massivas são registradas por uma pessoa, na tela; o Mapa de Alertas agrupa só o que foi registrado
- O runtime de filas tem apenas um teste, e ele é pulado sem um Redis disponível

## Trabalhando em paralelo

Mais de uma pessoa (e mais de um assistente) mexe neste repositório ao mesmo tempo. Antes de começar:

```bash
git fetch origin && git log --oneline main..origin/main
```

Se houver commits novos, faça `git pull --rebase origin main` **antes** de trabalhar. Já houve caso de trabalho paralelo sobrescrever silenciosamente arquivo do outro durante rebase — depois de qualquer rebase, rode a suíte e confira se o que você esperava continua lá.

Existem duas frentes que convivem: a **funcionalidade real** (IXC, n8n, filas, autenticação) e o **ambiente de demonstração protegido**, que é mock-only e falha fechado. O `tests/staging-demo.test.mjs` valida a segunda e é sensível: ele exige que `/api/health` devolva exatamente 5 campos. Não adicione campos ali sem entender o que quebra.

## Onde achar o resto

- `docs/security/` — autenticação, revisão de RBAC e auditoria
- `docs/support/handoff-policy.md` — quando a IA passa para humano
- `docs/integrations/` — IXC (mapeamento de dados, segredos, ponte) e o **canal de WhatsApp** (Evolution → n8n → HUB), em `whatsapp-evolution.md`
- `docs/queues-bullmq.md` — filas
- Issues no GitHub descrevem o roadmap por milestone (M1 a M5)
