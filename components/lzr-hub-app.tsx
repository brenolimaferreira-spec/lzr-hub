"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentResult, ChatMessage } from "@/lib/agent/types";
import { navigation, viewTitles, type View } from "@/lib/platform/navigation";
import { Customer360Module } from "@/components/modules/customer360";
import { SupportModule } from "@/components/modules/support";
import { BillingModule } from "@/components/modules/billing";
import { SalesModule } from "@/components/modules/sales";
import { IntelligenceModule } from "@/components/modules/intelligence";
import { AdminModule } from "@/components/modules/admin";
import { QualityModule } from "@/components/modules/quality";
import { InternalChatModule } from "@/components/modules/internal-chat";

type UiMessage = ChatMessage & { time: string; result?: AgentResult };

function Avatar({ initials = "JP" }: { initials?: string }) { return <div className="avatar">{initials}</div>; }

type Theme = "system" | "light" | "dark";
const THEME_KEY = "lzr-theme";
const THEME_LABELS: Record<Theme, [string, string]> = { system: ["◐", "Tema do sistema"], light: ["☀", "Tema claro"], dark: ["☾", "Tema escuro"] };
const NEXT_THEME: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

/**
 * O tema vive no elemento raiz, não no estado do React — o script do `layout`
 * já o aplicou antes da primeira pintura. Aqui a gente apenas **lê** de lá, com
 * `useSyncExternalStore`, que existe para esse caso: um valor que mora fora do
 * React e precisa disparar renderização quando muda.
 */
const themeListeners = new Set<() => void>();
function subscribeTheme(callback: () => void) {
  themeListeners.add(callback);
  // Trocar o tema numa aba passa a valer nas outras: o evento `storage` só
  // chega nas abas que não fizeram a alteração, então elas aplicam aqui.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_KEY) return;
    if (event.newValue === "light" || event.newValue === "dark") document.documentElement.dataset.theme = event.newValue;
    else delete document.documentElement.dataset.theme;
    callback();
  };
  window.addEventListener("storage", onStorage);
  return () => { themeListeners.delete(callback); window.removeEventListener("storage", onStorage); };
}
function readTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}
/** No servidor não há elemento raiz para consultar: "sistema" é o padrão. */
const readThemeOnServer = (): Theme => "system";

/**
 * Alterna entre tema do sistema, claro e escuro.
 *
 * "Sistema" é o padrão e é uma opção de verdade, não a ausência de escolha:
 * quem trabalha de dia e de noite quer acompanhar o sistema operacional. Ele é
 * representado pela **ausência** de `data-theme` — aí o `color-scheme: light dark`
 * do CSS decide sozinho.
 */
function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, readThemeOnServer);

  function change() {
    const next = NEXT_THEME[theme];
    try {
      if (next === "system") { window.localStorage.removeItem(THEME_KEY); delete document.documentElement.dataset.theme; }
      else { window.localStorage.setItem(THEME_KEY, next); document.documentElement.dataset.theme = next; }
    } catch {
      // Armazenamento bloqueado: o tema ainda vale nesta aba, só não persiste.
      if (next === "system") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = next;
    }
    for (const listener of themeListeners) listener();
  }

  const [icon, label] = THEME_LABELS[theme];
  return <button className="theme-toggle" onClick={change} title={`${label} — clique para trocar`} aria-label={`${label}. Clique para trocar de tema.`}>
    <i aria-hidden="true">{icon}</i><span>{label}</span>
  </button>;
}

type SessionState = { authenticated: boolean; authRequired: boolean; mustChangePassword?: boolean; user?: { name: string; email: string; role: string } };

function initialsOf(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "??";
}

/**
 * Só redireciona depois que a sessão é consultada no cliente. A primeira
 * renderização é sempre a aplicação normal — o HTML inicial é verificado pelos
 * testes do ambiente de demonstração e não pode virar uma tela de carregamento.
 */
function useSessionRedirect() {
  const [session, setSession] = useState<SessionState | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: SessionState) => {
        if (!active) return;
        setSession(data);
        if (data.authRequired && !data.authenticated) window.location.href = "/login";
      })
      .catch(() => { if (active) setSession(null); });
    return () => { active = false; };
  }, []);
  return session;
}

export function LzrHubApp({ ixcMode = "disabled" }: { ixcMode?: string }) {
  const [view, setView] = useState<View>("dashboard");
  const [changingPassword, setChangingPassword] = useState(false);
  const session = useSessionRedirect();
  const user = session?.user;
  // Senha gerada pelo sistema: a pessoa define a dela antes de usar qualquer tela.
  const forced = session?.mustChangePassword === true;
  // Só existe dado real quando o IXC está de fato ligado. Fora disso a tela
  // continua avisando que é demonstração, que é a verdade nesse modo.
  const live = ixcMode === "staging-readonly" || ixcMode === "production-readonly";

  function signOut() {
    fetch("/api/auth/logout", { method: "POST" })
      .then(() => { window.location.href = "/login"; })
      .catch(() => { window.location.href = "/login"; });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">L</div><div className="brand-copy"><strong>LZR HUB</strong><small>BBNET Intelligence</small></div></div>
        {/* Em tela estreita a barra vira só ícones. O `title` e o `aria-label` são
            o que impede isso de virar 23 glifos indecifráveis. */}
        <nav className="nav-scroll" aria-label="Navegação principal">{navigation.map((item) => <div key={item.id}>{item.group ? <div className="nav-label">{item.group}</div> : null}<button className={`nav-item ${view === item.id ? "active" : ""}`} onClick={() => setView(item.id)} title={item.group ? `${item.group} › ${item.label}` : item.label} aria-label={item.label} aria-current={view === item.id ? "page" : undefined}><span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span></button></div>)}</nav>
        <div className="sidebar-footer">
          <div className="sidebar-identity">
            <Avatar initials={user ? initialsOf(user.name) : "AD"} />
            <div><strong>{user ? user.name : "Admin Demonstração"}</strong><span>{user ? user.role : "Usuário sintético"}</span></div>
            {user && <div style={{ display: "flex", gap: 6 }}>
              <button className="button secondary" onClick={() => setChangingPassword(true)}>Senha</button>
              <button className="button secondary" onClick={signOut}>Sair</button>
            </div>}
          </div>
          <ThemeToggle />
        </div>
      </aside>
      {(changingPassword || forced) && <PasswordDialog forced={forced} onClose={() => { setChangingPassword(false); if (forced) window.location.reload(); }} />}
      <section className="workspace">
        <header className="topbar"><div className="topbar-title"><strong>{viewTitles[view][0]}</strong><span>{live ? "Dados reais de produção • somente leitura" : viewTitles[view][1]}</span></div><div className="live-pill">{live ? "● IXC conectado • somente leitura" : "● Homologação protegida • demo mock"}</div></header>
        {live
          ? <div className="demo-notice" role="status"><strong>Leitura de produção</strong><span>o cadastro vem do IXC; nenhuma escrita é executada no ERP</span></div>
          : <div className="demo-notice" role="status"><strong>Ambiente de demonstração</strong><span>nenhuma ação real é executada</span></div>}
        {view === "dashboard" && <Dashboard onOpen={() => setView("atendimento")} />}
        {view === "atendimento" && <Conversation />}
        {view === "training" && <TrainingMode />}
        {["integracoes","equipes","usuarios","auditoria","configuracoes"].includes(view) && <AdminModule view={view as "integracoes"|"equipes"|"usuarios"|"auditoria"|"configuracoes"} />}
        {view === "clientes" && <Customer360Module />}
        {view === "chat-interno" && <InternalChatModule />}
        {["monitoramento","mapa-alertas","massivas","chamados"].includes(view) && <SupportModule view={view as "monitoramento"|"mapa-alertas"|"massivas"|"chamados"} onNavigateMassivas={() => setView("massivas")} />}
        {["cobranca","regua","relatorios-cobranca"].includes(view) && <BillingModule view={view as "cobranca"|"regua"|"relatorios-cobranca"} />}
        {["comercial","funil","metas","relatorios-comercial"].includes(view) && <SalesModule view={view as "comercial"|"funil"|"metas"|"relatorios-comercial"} />}
        {["churn","conhecimento"].includes(view) && <IntelligenceModule view={view as "churn"|"conhecimento"} />}
        {["avaliacoes","prompts"].includes(view) && <QualityModule view={view as "avaliacoes"|"prompts"} />}
      </section>
    </div>
  );
}

type OverviewMetrics = { conversations:number; resolvedWithoutHuman:number; resolutionRate:number|null; handoffs:number; suggestionsOnly:number; handoffReasons:Record<string,number>; intents:Record<string,number>; csatAverage:number|null; csatCount:number; csatDistribution:Record<string,number>; costPerConversation:null };
type ConversationSummary = { channel:string; externalConversationId:string; lastMessage:string; lastRole:"customer"|"agent"|"suggestion"; lastAt:string; messages:number; finalStatus?:string; intent?:string; handoff?:boolean };
type Overview = { period:string; available:boolean; detail?:string; metrics:OverviewMetrics|null; queue:ConversationSummary[]; averageHandlingSeconds:number|null; integrations:{ ixc:{mode:string;state:string}; channel:{enabled:boolean;configured:boolean;autoReply:boolean} } };

const INTENT_LABELS: Record<string,string> = {
  technical_no_connection:"Sem conexão", technical_slow:"Lentidão", technical_wifi:"Wi-Fi", technical_restart:"Reinício de equipamento",
  technical_ticket:"Abertura de chamado", technical_visit:"Visita técnica", financial_invoice:"Fatura / segunda via", financial_pix:"PIX",
  financial_payment:"Pagamento", financial_unlock:"Desbloqueio", financial_discount_request:"Pedido de desconto", complaint:"Reclamação", cancellation_risk:"Risco de cancelamento",
  human_handoff:"Pedido de atendente", unauthorized_request:"Pedido não autorizado", out_of_scope:"Fora de escopo", general_information:"Informação geral",
};
const HANDOFF_LABELS: Record<string,string> = {
  low_intent_confidence:"Baixa confiança na intenção", customer_requested_human:"Cliente pediu atendente", customer_irritated:"Cliente irritado",
  unauthorized_request:"Pedido não autorizado", cancellation_risk:"Risco de cancelamento", "não informado":"Não informado",
};
const intentLabel = (key:string) => INTENT_LABELS[key] ?? key;
const handoffLabel = (key:string) => HANDOFF_LABELS[key] ?? key;

/** Telefone do WhatsApp: mostra em formato legível, sem esconder dígito de quem atende. */
function conversationLabel(id:string) {
  const digits = id.replace(/\D/g,"");
  if (digits.length < 12 || digits.length > 13) return id;
  const ddd = digits.slice(2,4); const rest = digits.slice(4);
  return `(${ddd}) ${rest.slice(0,rest.length-4)}-${rest.slice(-4)}`;
}
function relativeTime(iso:string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "—";
  const minutes = Math.round(diff/60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes/60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours/24)} d`;
}

const PERIOD_LABELS: [string,string][] = [["24h","24 horas"],["7d","7 dias"],["30d","30 dias"]];

type CockpitMetric = { value:number|null; detail:string };
type Cockpit = {
  available:boolean; period:string;
  activeCustomers:CockpitMetric; openInvoices:CockpitMetric; overdueInvoices:CockpitMetric;
  conversations:CockpitMetric; resolutionRate:CockpitMetric; csat:CockpitMetric;
  openIncidents:CockpitMetric; affectedCustomers:CockpitMetric; goalProgressPercent:CockpitMetric; aiCost:CockpitMetric;
  recentActivity:Array<{id:string;action:string;entity:string;result:string;createdAt:string;actorId:string}>;
  degraded:string[];
};

const brl = (value:number) => `R$ ${value.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`;

/**
 * Cartão do cockpit. Indisponível nunca vira zero: mostra "—" e o motivo, para
 * um painel de gestor não ser lido como "não há inadimplente" quando na verdade
 * a fonte não respondeu.
 */
function CockpitCard({ label, metric, icon, format }: { label:string; metric:CockpitMetric; icon:string; format?:(value:number)=>string }) {
  return <Metric label={label} value={metric.value===null?"—":(format?format(metric.value):metric.value.toLocaleString("pt-BR"))} detail={metric.detail} icon={icon} />;
}

function Dashboard({ onOpen }: { onOpen: () => void }) {
  const [period,setPeriod] = useState("7d");
  const [data,setData] = useState<Overview|null>(null);
  const [state,setState] = useState<"loading"|"ready"|"error">("loading");
  useEffect(() => {
    let active = true;
    fetch(`/api/operation/overview?period=${period}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: Overview) => { if (active) { setData(payload); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [period]);

  const metrics = data?.metrics ?? null;
  const percent = (value:number|null) => value===null ? "—" : `${Math.round(value*100)}%`;
  return <main className="content">
    <div className="page-heading"><div><h1>Olá, equipe BBNET.</h1><p>Números medidos em cada módulo. O que não é medido aparece como não medido.</p></div><button className="button" onClick={onOpen}>Abrir central de atendimento</button></div>
    <section className="filter-bar"><select value={period} onChange={(e)=>{setState("loading");setPeriod(e.target.value)}}>{PERIOD_LABELS.map(([value,label])=><option key={value} value={value}>Últimos {label}</option>)}</select></section>
    <CockpitPanel period={period} />
    {state==="loading" && <div className="state-card">Carregando indicadores…</div>}
    {state==="error" && <div className="state-card error">Não foi possível carregar os indicadores.</div>}
    {state==="ready" && data && !data.available && <div className="state-card error">{data.detail ?? "Fonte de indicadores indisponível"} — nenhum número é exibido para não induzir a erro.</div>}
    {state==="ready" && data?.available && metrics && <>
      {data.integrations.channel.enabled && !data.integrations.channel.autoReply && <div className="state-card" style={{marginBottom:14}}><strong>Canal em modo observação.</strong> As mensagens são recebidas e classificadas, mas a IA não responde ao cliente. Por isso a taxa de resolução fica em zero: sugestão não é atendimento resolvido.</div>}
      <section className="metrics">
        <Metric label="Conversas no período" value={String(metrics.conversations)} detail={metrics.conversations?`Canal ${data.integrations.channel.enabled?(data.integrations.channel.autoReply?"respondendo":"em observação"):"desligado"}`:"Nenhuma conversa registrada"} icon="◫" />
        <Metric label="Resolvidas sem humano" value={percent(metrics.resolutionRate)} detail={metrics.conversations?`${metrics.resolvedWithoutHuman} de ${metrics.conversations}`:"Sem base para calcular"} icon="✦" />
        {data.integrations.channel.autoReply
          ? <Metric label="Transbordos" value={String(metrics.handoffs)} detail={metrics.handoffs?"Passaram para humano":"Nenhum no período"} icon="⇄" />
          : <Metric label="Sugestões sem envio" value={String(metrics.suggestionsOnly)} detail={metrics.handoffs?`${metrics.handoffs} recomendariam transbordo`:"Nenhuma recomendação de transbordo"} icon="◐" />}
        <Metric label="CSAT médio" value={metrics.csatAverage===null?"—":metrics.csatAverage.toFixed(1).replace(".",",")} detail={metrics.csatCount?`${metrics.csatCount} avaliação(ões)`:"Nenhuma avaliação recebida"} icon="✓" />
      </section>
      <section className="dashboard-grid">
        <div className="card"><div className="card-header"><strong>Últimas conversas</strong><span className={`badge ${data.integrations.channel.enabled?"green":"amber"}`}>{data.integrations.channel.enabled?"● Canal ativo":"● Canal desligado"}</span></div><div className="card-body">
          {data.queue.length===0
            ? <p style={{fontSize:12,color:"var(--muted)",lineHeight:1.6}}>Nenhuma conversa registrada. {data.integrations.channel.enabled?"O canal está ligado e aguardando mensagens.":"O canal do WhatsApp está desligado (FEATURE_N8N_CHANNEL)."}</p>
            : data.queue.map((item)=><button className="queue-row" key={`${item.channel}:${item.externalConversationId}`} onClick={onOpen} style={{width:"100%",textAlign:"left",background:"none",border:"none",cursor:"pointer"}}>
                <Avatar initials={conversationLabel(item.externalConversationId).slice(-2)} />
                <div><p>{conversationLabel(item.externalConversationId)}</p><span>{item.intent?intentLabel(item.intent):"Sem desfecho registrado"} • {item.messages} mensagens</span></div>
                <span className={`badge ${item.handoff?"amber":"green"}`}>{relativeTime(item.lastAt)}</span>
              </button>)}
        </div></div>
        <div className="card"><div className="card-header"><strong>Conversas por intenção</strong><span className="badge blue">Últimos {PERIOD_LABELS.find(([v])=>v===period)?.[1]}</span></div><div className="card-body">
          {metrics.conversations===0
            ? <p style={{fontSize:12,color:"var(--muted)"}}>Sem conversas no período — nada a distribuir.</p>
            : Object.entries(metrics.intents).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([intent,count])=><Progress key={intent} label={`${intentLabel(intent)} (${count})`} value={Math.round(count/metrics.conversations*100)} />)}
          {metrics.handoffs>0 && <div style={{marginTop:22,padding:14,background:"var(--warn-bg)",borderRadius:10,fontSize:11,color:"var(--warn)",lineHeight:1.6}}><strong style={{display:"block",fontSize:12,color:"var(--warn)",marginBottom:4}}>Por que passou para humano</strong>{Object.entries(metrics.handoffReasons).sort((a,b)=>b[1]-a[1]).map(([reason,count])=>`${handoffLabel(reason)}: ${count}`).join(" • ")}</div>}
          <div style={{marginTop:14,padding:14,background:"var(--blue-soft)",borderRadius:10,fontSize:11,color:"var(--text-2)",lineHeight:1.6}}><strong style={{display:"block",fontSize:12,color:"var(--blue)",marginBottom:4}}>Ainda não medimos</strong>Tempo médio de atendimento e custo por conversa dependem da instrumentação do Langfuse. Em vez de estimar, ficam de fora.</div>
        </div></div>
      </section>
    </>}
  </main>;
}

/**
 * Troca da própria senha. Fica na barra lateral, junto do "Sair", porque
 * pertence à pessoa e não à Administração — um "Somente leitura" também precisa
 * conseguir trocar a sua, sem depender de alguém resetar por ele.
 */
function PasswordDialog({ onClose, forced = false }: { onClose: () => void; forced?: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (next !== confirm) { setMessage("A confirmação não confere com a nova senha."); return; }
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) { setMessage(payload.error ?? "Não foi possível trocar a senha."); return; }
      setDone(true); setCurrent(""); setNext(""); setConfirm("");
    } catch { setMessage("Falha ao falar com o servidor."); }
    finally { setBusy(false); }
  }

  // No primeiro acesso o diálogo não fecha: clicar fora ou apertar Esc deixaria
  // a pessoa navegando com uma senha que um administrador conhece.
  return <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "grid", placeItems: "center", zIndex: 50 }} onClick={forced ? undefined : onClose}>
    <div className="data-card" style={{ width: "min(420px, 92vw)", background: "white" }} onClick={(event) => event.stopPropagation()}>
      <div className="card-header"><strong>{forced ? "Defina a sua senha" : "Trocar minha senha"}</strong>{!forced && <button onClick={onClose}>Fechar</button>}</div>
      {forced && !done && <div className="state-card" style={{ margin: "0 14px" }}>A senha que você usou foi gerada pelo sistema e um administrador a conhece. Defina a sua para continuar.</div>}
      {done
        ? <div style={{ padding: 16, lineHeight: 1.7, fontSize: 12 }}><strong>Senha trocada.</strong><p style={{ marginTop: 6 }}>As suas outras sessões foram encerradas — se alguém estava logado na sua conta em outro lugar, perdeu o acesso agora. Esta continua valendo.</p><button className="button" style={{ marginTop: 10 }} onClick={onClose}>{forced ? "Entrar" : "Pronto"}</button></div>
        : <div className="wizard" style={{ display: "grid", gap: 8 }}>
            <input type="password" placeholder={forced ? "Senha que você recebeu" : "Senha atual"} value={current} onChange={(event) => { setCurrent(event.target.value); setMessage(null); }} />
            <input type="password" placeholder="Nova senha (mínimo 10 caracteres)" value={next} onChange={(event) => setNext(event.target.value)} />
            <input type="password" placeholder="Repita a nova senha" value={confirm} onChange={(event) => setConfirm(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} />
            {message && <p style={{ fontSize: 11, color: "var(--bad)", lineHeight: 1.5 }}>{message}</p>}
            <button className="button" disabled={busy || !current || !next} onClick={() => void submit()}>{busy ? "Trocando…" : "Trocar senha"}</button>
            <p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>Pedimos a senha atual de propósito: sem isso, um cookie roubado bastaria para trancar você fora da própria conta.</p>
          </div>}
    </div>
  </div>;
}

const ACTION_LABELS: Record<string,string> = {
  "billing.rule.save":"Régua salva", "billing.collections.dispatch":"Disparo da régua", "billing.promise.create":"Promessa registrada",
  "billing.promise.review":"Promessas revisadas", "ixc.write.invoice_reissue":"Segunda via de boleto",
  "support.incident.create":"Massiva registrada", "support.incident.close":"Massiva encerrada", "support.incident.notify":"Aviso de massiva",
  "sales.goal.save":"Meta salva", "channel.message.processed":"Mensagem do canal", "integrations.telegram.alert":"Alerta de rede",
};

/**
 * Cockpit do gestor (issue #22): os números de todos os módulos numa tela só,
 * cada fonte consultada em paralelo e com falha isolada. Uma fonte fora do ar
 * mostra "—" com o motivo, e as outras continuam aparecendo.
 */
function CockpitPanel({ period }: { period:string }) {
  const [data,setData] = useState<Cockpit|null>(null);
  const [state,setState] = useState<"loading"|"ready"|"error">("loading");
  useEffect(() => {
    let active = true;
    fetch(`/api/cockpit?period=${period}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: Cockpit) => { if (active) { setData(payload); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [period]);

  if (state==="loading") return <div className="state-card">Consultando os módulos…</div>;
  if (state==="error" || !data) return <div className="state-card error">Não foi possível montar o cockpit.</div>;

  return <>
    {data.degraded.length>0 && <div className="state-card" style={{marginBottom:14}}>
      <strong>Fonte(s) indisponível(is): {data.degraded.join(", ")}.</strong> Os cartões dessas fontes aparecem como não medidos — nenhum deles vira zero.
    </div>}
    <section className="metrics">
      <CockpitCard label="Clientes ativos" metric={data.activeCustomers} icon="◉" />
      <CockpitCard label="Faturas em aberto" metric={data.openInvoices} icon="$" />
      <CockpitCard label="Faturas vencidas" metric={data.overdueInvoices} icon="$" />
      <CockpitCard label="Meta do mês" metric={data.goalProgressPercent} icon="◎" format={(v)=>`${v}%`} />
    </section>
    {/* "Conversas no período" fica só na seção de atendimento, logo abaixo, que
        já a mostra junto de resolução e CSAT — repetir aqui era ruído. */}
    <section className="metrics" style={{marginTop:14,gridTemplateColumns:"repeat(3, 1fr)"}}>
      <CockpitCard label="Massivas abertas" metric={data.openIncidents} icon="⚠" />
      <CockpitCard label="Clientes impactados" metric={data.affectedCustomers} icon="⚠" />
      <CockpitCard label="Custo de IA" metric={data.aiCost} icon="✦" format={brl} />
    </section>
    {data.recentActivity.length>0 && <section className="card" style={{marginTop:14}}>
      <div className="card-header"><strong>Atividades recentes da operação</strong><span className="badge blue">Do rastro de auditoria</span></div>
      <div className="card-body">
        {data.recentActivity.map((item)=><div className="aging-row" key={item.id}>
          <div><strong>{ACTION_LABELS[item.action] ?? item.action}</strong><span>{item.actorId} • {item.entity}</span></div>
          <b style={{fontSize:11,color:item.result==="success"?"var(--ok)":"var(--muted)"}}>{relativeTime(item.createdAt)}</b>
        </div>)}
      </div>
    </section>}
  </>;
}

function Metric({ label, value, detail, icon }: { label:string; value:string; detail:string; icon:string }) { return <article className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></article>; }
function Progress({ label, value }: { label:string; value:number }) { return <div className="bar-row"><div className="bar-label"><span>{label}</span><strong>{value}%</strong></div><div className="bar"><span style={{width:`${value}%`}} /></div></div>; }

type ConversationMessage = { role:"customer"|"agent"|"suggestion"; content:string; createdAt:string };

type CopilotSource = { id:string; title:string; category:string; version:number; excerpt:string; score:number };
type CopilotResult = { kind:"answer"|"summary"; written:"llm"|"excerpt"|"none"; text:string; caveat:string|null; sources:CopilotSource[]; basedOn?:string };

/**
 * Copiloto do atendente (issue #11): pergunta à base de conhecimento, sugere
 * resposta para a conversa aberta e resume o caso para passar a um colega.
 *
 * O botão é "Copiar", não "Enviar": responder pela tela não existe, e um botão
 * de enviar que não envia seria a mentira mais cara desta tela. Copiar é o que
 * de fato acontece — e é isso que vai para a auditoria.
 */
function Copilot({ channel, conversationId }: { channel:string; conversationId:string }) {
  const [question,setQuestion] = useState("");
  const [busy,setBusy] = useState<null|"ask"|"suggest"|"summary">(null);
  const [result,setResult] = useState<CopilotResult|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [copied,setCopied] = useState(false);

  async function run(action:"ask"|"suggest"|"summary") {
    setBusy(action); setError(null); setCopied(false);
    try {
      const response = await fetch("/api/copilot", { method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify({ action, channel, conversationId, question }) });
      const payload = await response.json() as { answer?:string; summary?:string; written?:"llm"|"excerpt"|"none"; caveat?:string|null; sources?:CopilotSource[]; question?:string; error?:string; detail?:string };
      if (!response.ok) { setError(payload.error ?? payload.detail ?? "O copiloto não respondeu."); setResult(null); return; }
      setResult(action==="summary"
        ? { kind:"summary", written:"none", text:payload.summary ?? "", caveat:null, sources:[] }
        // `basedOn` é a fala do cliente que o servidor escolheu responder. Sem
        // mostrá-la, uma sugestão fora de contexto vira mistério — e foi o que
        // aconteceu na primeira versão, respondendo à nota de avaliação.
        : { kind:"answer", written:payload.written ?? "none", text:payload.answer ?? "", caveat:payload.caveat ?? null, sources:payload.sources ?? [], basedOn:payload.question });
    } catch { setError("O copiloto não respondeu."); setResult(null); }
    finally { setBusy(null); }
  }

  async function copy() {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.text); }
    // Sem cópia não houve uso: registrar "usada" aqui gravaria o que não aconteceu.
    catch { setError("Não consegui copiar. Selecione o texto acima e copie à mão."); return; }
    setCopied(true); setError(null);
    void fetch("/api/copilot", { method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({ action:"used", channel, conversationId, kind:result.kind }) });
  }

  return <div className="info-section">
    <h4>Copiloto</h4>
    <p className="copilot-note">Responde a partir da base de conhecimento e cita a fonte. Sem documento que sustente, diz que não sabe.</p>
    <div className="copilot-actions">
      <button className="button secondary" disabled={busy!==null} onClick={()=>void run("suggest")}>{busy==="suggest"?"Buscando…":"Sugerir resposta"}</button>
      <button className="button secondary" disabled={busy!==null} onClick={()=>void run("summary")}>{busy==="summary"?"Resumindo…":"Resumir para transferir"}</button>
    </div>
    <div className="copilot-ask">
      <input value={question} placeholder="Pergunte: como resolvo lentidão em fibra?" onChange={(e)=>setQuestion(e.target.value)}
        onKeyDown={(e)=>{ if(e.key==="Enter"&&question.trim().length>2&&busy===null){ e.preventDefault(); void run("ask"); } }} />
      <button className="button" disabled={busy!==null||question.trim().length<3} onClick={()=>void run("ask")}>{busy==="ask"?"…":"Perguntar"}</button>
    </div>
    {error && <p className="form-error" style={{marginTop:10}}>{error}</p>}
    {result && <div className="copilot-answer">
      {result.basedOn && <small className="copilot-basedon">Respondendo a: “{result.basedOn}”</small>}
      {/* Em modo trecho a resposta *é* a fonte logo abaixo — repetir o mesmo
          texto duas vezes faria o atendente ler duas vezes por engano. */}
      {result.written!=="excerpt" && <pre>{result.text}</pre>}
      {result.caveat && <small className="copilot-caveat">{result.caveat}</small>}
      {result.sources.map((source)=><div className="copilot-source" key={source.id}>
        <strong>{source.title}</strong><span>{source.category} • versão {source.version}</span>
        <em>{source.excerpt}</em>
      </div>)}
      <button className="button secondary" onClick={()=>void copy()}>{copied?"Copiado ✓":"Copiar"}</button>
    </div>}
  </div>;
}

/**
 * Atendimentos mostra o que realmente entrou pelos canais. Não há conversa de
 * exemplo: sem histórico gravado, a tela explica por quê. O envio pela tela
 * ainda não existe: ninguém envia resposta ao cliente hoje, então o campo fica
 * desabilitado em vez de fingir que mandou.
 */
function Conversation() {
  const [items,setItems] = useState<ConversationSummary[]>([]);
  const [channelState,setChannelState] = useState<{enabled:boolean;autoReply:boolean}>({enabled:false,autoReply:false});
  const [available,setAvailable] = useState(true);
  const [state,setState] = useState<"loading"|"ready"|"error">("loading");
  const [selected,setSelected] = useState<ConversationSummary|null>(null);
  const [messages,setMessages] = useState<ConversationMessage[]>([]);
  const [messagesState,setMessagesState] = useState<"idle"|"loading"|"ready">("idle");

  useEffect(() => {
    let active = true;
    fetch("/api/conversations")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload:{available:boolean;items:ConversationSummary[];channelState:{enabled:boolean;autoReply:boolean}}) => {
        if (!active) return;
        setAvailable(payload.available); setItems(payload.items ?? []); setChannelState(payload.channelState ?? {enabled:false,autoReply:false}); setState("ready");
        if (payload.items?.length) void open(payload.items[0]);
      })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, []);

  async function open(item:ConversationSummary) {
    setSelected(item); setMessagesState("loading"); setMessages([]);
    const response = await fetch(`/api/conversations?channel=${encodeURIComponent(item.channel)}&id=${encodeURIComponent(item.externalConversationId)}`);
    if (response.ok) { const payload = await response.json() as {messages:ConversationMessage[]}; setMessages(payload.messages ?? []); }
    setMessagesState("ready");
  }

  if (state==="loading") return <main className="content"><div className="state-card">Carregando conversas…</div></main>;
  if (state==="error") return <main className="content"><div className="state-card error">Não foi possível carregar as conversas.</div></main>;
  if (!available) return <main className="content"><div className="state-card error">Histórico de conversas indisponível. Nenhuma conversa de exemplo é exibida no lugar.</div></main>;
  if (items.length===0) return <main className="content"><div className="state-card"><strong>Nenhuma conversa registrada.</strong><p style={{marginTop:6,lineHeight:1.6}}>As conversas aparecem aqui assim que o canal do WhatsApp receber mensagens. Nada fictício é mostrado enquanto isso.</p></div></main>;

  return <main className="content" style={{paddingTop:18}}>
    {channelState.enabled && !channelState.autoReply && <div className="state-card" style={{marginBottom:14}}><strong>Modo observação.</strong> O canal recebe e registra as mensagens, e a IA propõe a resposta — mas nada é enviado ao cliente. As sugestões aparecem marcadas no histórico.</div>}
    <div className="conversation-layout">
    <aside className="conversation-list">
      {items.map((item)=><div className={`contact ${selected?.externalConversationId===item.externalConversationId?"active":""}`} key={`${item.channel}:${item.externalConversationId}`} onClick={()=>void open(item)} role="button" tabIndex={0} onKeyDown={(e)=>{if(e.key==="Enter")void open(item)}}>
        <Avatar initials={conversationLabel(item.externalConversationId).slice(-2)} />
        <div><p>{conversationLabel(item.externalConversationId)}</p><span>{item.lastRole==="agent"?"IA: ":item.lastRole==="suggestion"?"Sugestão: ":""}{item.lastMessage.slice(0,48)}</span></div>
        <time>{relativeTime(item.lastAt)}</time>
      </div>)}
    </aside>
    <section className="conversation-main">
      <div className="chat-header"><div className="person"><Avatar initials={selected?conversationLabel(selected.externalConversationId).slice(-2):"—"} /><div><strong>{selected?conversationLabel(selected.externalConversationId):"—"}</strong><span>● {selected?.channel ?? "canal"}</span></div></div><span className={`badge ${selected?.handoff?"amber":"blue"}`}>{selected?.handoff?"Transbordo":selected?.finalStatus ?? "Sem desfecho"}</span></div>
      <div className="messages">
        {messagesState==="loading" && <div className="message agent">Carregando histórico…</div>}
        {messagesState==="ready" && messages.length===0 && <div className="message agent">Conversa sem mensagens gravadas.</div>}
        {messages.map((message,index)=><div className={`message ${message.role==="customer"?"":"agent"}`} key={index} style={message.role==="suggestion"?{opacity:0.72,borderLeft:"3px solid var(--warn)"}:undefined}>
          {message.role==="suggestion" && <strong style={{display:"block",fontSize:11,color:"var(--warn)",textTransform:"uppercase",letterSpacing:0.4,marginBottom:4}}>Sugestão da IA — não enviada ao cliente</strong>}
          {message.content}
          <time>{new Date(message.createdAt).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</time>
        </div>)}
      </div>
      <div className="composer"><textarea disabled placeholder="Responder pela tela ainda não está ligado. Nenhuma resposta é enviada ao cliente — o canal está em modo observação." /><button aria-label="Enviar" disabled>➤</button></div>
    </section>
    <aside className="customer-panel">
      <div className="customer-head"><Avatar initials={selected?conversationLabel(selected.externalConversationId).slice(-2):"—"} /><h3>{selected?conversationLabel(selected.externalConversationId):"—"}</h3><p>Identificador do canal • {selected?.channel}</p></div>
      {/* `key` troca o copiloto inteiro ao mudar de conversa: sem isso a resposta
          de um cliente ficaria na tela ao lado do histórico de outro. */}
      {selected && <Copilot key={`${selected.channel}:${selected.externalConversationId}`} channel={selected.channel} conversationId={selected.externalConversationId} />}
      <Info title="Conversa" rows={[["Mensagens",String(selected?.messages ?? 0)],["Última",selected?relativeTime(selected.lastAt):"—"],["Intenção",selected?.intent?intentLabel(selected.intent):"Não registrada"],["Desfecho",selected?.finalStatus ?? "Não registrado"]]} />
      <Info title="Cadastro" rows={[["Vínculo com o IXC","Não associado"],["Como associar","Depende de casar o telefone do canal com o cadastro do IXC — ainda não implementado"]]} />
    </aside>
  </div></main>;
}

/** Usado só pelo AI Training Mode: conversa de treino, sem cliente real do outro lado. */
function ConversationWorkspace({ initial, onResult }: { initial: UiMessage[]; onResult?: (result: AgentResult) => void }) {
  const [messages, setMessages] = useState<UiMessage[]>(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior:"smooth" }), [messages, busy]);
  async function send() {
    const value = input.trim(); if (!value || busy) return;
    const customer: UiMessage = { role:"customer", content:value, time:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) };
    const updated = [...messages, customer]; setMessages(updated); setInput(""); setBusy(true);
    try {
      const response = await fetch("/api/agent", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({message:value,history:updated.map(({role,content})=>({role,content}))}) });
      const result = await response.json() as AgentResult;
      if (!response.ok) throw new Error("Falha na análise");
      setMessages((current) => [...current, { role:"agent", content:result.response, time:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}), result }]);
      onResult?.(result);
    } catch { setMessages((current) => [...current,{role:"agent",content:"Tive uma falha ao consultar as ferramentas. Registrei o contexto e não vou confirmar nenhuma ação que não tenha sido concluída.",time:"agora"}]); }
    finally { setBusy(false); }
  }
  return <>
    <div className="training-messages">
      {messages.map((message,index) => <Message key={index} message={message} />)}
      {busy && <div className="message agent">Estou consultando isso aqui para você…</div>}
      <div ref={endRef} />
    </div>
    <div className="composer"><textarea value={input} onChange={(e)=>setInput(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send();}}} placeholder="Digite qualquer mensagem como um cliente…"/><button aria-label="Enviar" onClick={()=>void send()}>➤</button></div>
  </>;
}

function Message({ message }: { message: UiMessage }) { const artifacts=message.result?.tools.flatMap(t=>t.artifact?[t.artifact]:[])??[]; return <div className={`message ${message.role==="agent"?"agent":""}`}>{message.content}{artifacts.map((a,i)=><div className="artifact" key={i}><strong>✓ {a.label}</strong><code>{a.value}</code></div>)}<time>{message.time} {message.role==="agent"?"✓✓":""}</time></div>; }
function Info({ title, rows }: { title:string; rows:string[][] }) { return <div className="info-section"><h4>{title}</h4>{rows.map(([a,b])=><div className="info-line" key={a}><span>{a}</span><strong>{b}</strong></div>)}</div>; }

function TrainingMode() {
  const [result,setResult]=useState<AgentResult|null>(null);
  const [accepted,setAccepted]=useState(false);
  return <main className="content"><div className="page-heading"><div><h1>AI Training Mode</h1><p>Converse livremente. A análise é posterior e não muda o pipeline operacional.</p></div><span className="badge blue">Mesmo pipeline da produção</span></div><div className="training-grid">
    <section className="training-chat"><div className="training-header"><div><strong>Cliente de treinamento</strong><p>Gírias, erros, ironia e mudança de assunto são aceitos.</p></div><button className="button secondary" onClick={()=>location.reload()}>Nova conversa</button></div><ConversationWorkspace initial={[]} onResult={(r)=>{setResult(r);setAccepted(false)}} /></section>
    <aside className="analysis-panel"><div className="card-header"><strong>Supervisor de Qualidade</strong><span className="badge green">Automático</span></div>{!result?<div className="analysis-empty">Envie uma mensagem para visualizar intenção, execução, qualidade e a melhor resposta possível.</div>:<Analysis result={result} accepted={accepted} onAccept={()=>setAccepted(true)} />}</aside>
  </div></main>;
}

function Analysis({result,accepted,onAccept}:{result:AgentResult;accepted:boolean;onAccept:()=>void}) { const e=result.evaluation; const scores=[["Naturalidade",e.naturalness],["Precisão",e.precision],["Empatia",e.empathy],["Segurança",e.safety],["Continuidade",e.continuity],["Memória",e.memory],["Novidade",e.noveltyScore*10],["Progresso",e.progressScore*10]] as const; return <>
  <div className="analysis-block"><div className="analysis-main"><div><h4>Intenção detectada</h4><strong>{result.intent}</strong><div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>{result.goal} • confiança {Math.round(result.confidence*100)}%</div></div><div className="score"><span>{e.score}</span></div></div></div>
  <div className="analysis-block"><h4>Estado e execução</h4><div className="analysis-status"><span className="badge blue">{result.state}</span><span className={`badge ${result.actionExecuted?"amber":"green"}`}>{result.actionExecuted?"Ação externa":"Zero ação real"}</span><span className="badge">{result.finalStatus}</span></div><div className="correlation">{result.correlationId}</div></div>
  <div className="analysis-block"><h4>Ferramentas</h4><div className="tool-list">{result.tools.length?result.tools.map(t=><span className="tool-chip" key={t.tool}>{t.status==="completed"?"✓":"!"} {t.tool} • {t.outcome}</span>):<span className="analysis-muted">Nenhuma ferramenta necessária.</span>}</div></div>
  <div className="analysis-block"><h4>Evidências</h4>{result.evidence.length?<div className="evidence-list">{result.evidence.map((evidence)=><div className="evidence-item" key={evidence.id}><strong>{evidence.kind} • {evidence.source}</strong><span>{evidence.summary}</span><small>{evidence.simulated?"Evidência simulada e identificada":"Evidência validada"}</small></div>)}</div>:<p className="analysis-muted">Nenhuma evidência foi produzida; o agente não pode alegar sucesso.</p>}</div>
  <div className="analysis-block"><h4>Transbordo</h4><div className={`handoff-card ${result.handoff.required?"required":""}`}><strong>{result.handoff.required?"Necessário":"Não necessário"}</strong><span>{result.handoff.reason??"O fluxo demonstrativo pode continuar com segurança."}</span>{result.handoff.summary&&<small>{result.handoff.summary}</small>}</div></div>
  <div className="analysis-block"><h4>Avaliação</h4>{scores.map(([label,value])=><div className="score-row" key={label}><div><div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span>{label}</span><strong>{value}</strong></div><div className="mini-bar"><span style={{width:`${value*10}%`}} /></div></div><span>/10</span></div>)}</div>
  <div className="analysis-block"><h4>Resumo e próximo passo</h4><p style={{fontSize:11,lineHeight:1.55,color:"var(--text-2)"}}>{result.conversationSummary}</p><p style={{fontSize:11,lineHeight:1.55}}><strong>Próximo:</strong> {result.nextStep}</p></div>
  <div className="analysis-block"><h4>Resposta considerada perfeita</h4><div className="ideal">{e.idealResponse}</div><p style={{fontSize:11,color:"var(--muted)",lineHeight:1.5}}>{e.suggestion}</p><button className={`button ${accepted?"success":""}`} style={{width:"100%"}} onClick={onAccept}>{accepted?"✓ Melhoria salva como caso aprovado":"Aceitar melhoria"}</button></div>
  </>; }
