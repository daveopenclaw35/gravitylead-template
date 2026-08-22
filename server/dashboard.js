/* ============================================================================
 * GravityLead — Owner Dashboard
 *
 * Password-protected web UI. Mount in index.js with:
 *   const dashboard = require("./dashboard");
 *   dashboard.init(twilioClient, clients, BASE_URL);
 *   app.use("/dashboard", dashboard.router);
 *
 * Routes:
 *   GET  /dashboard            — main UI (auth required)
 *   GET  /dashboard/login      — login form
 *   POST /dashboard/login      — authenticate → set session cookie
 *   GET  /dashboard/logout     — revoke session → redirect
 *   GET  /dashboard/api/data   — JSON payload (auth required)
 *
 * .env:
 *   DASHBOARD_PASSWORD  — required; plain-text login password
 * ========================================================================== */
"use strict";

const { Router } = require("express");
const crypto     = require("crypto");
const rateLimit  = require("express-rate-limit");
const auth       = require("./auth");
const db         = require("./db");

/* ── Auth guard (shared session store with /ops) ─────────────────────────────── */
const guard = auth.guard("/dashboard/login");

/* ── Module state ───────────────────────────────────────────────────────────── */
let twilio   = null;
let clients  = {};
let BASE_URL = "";

function init(tw, cl, url) { twilio = tw; clients = cl; BASE_URL = url || ""; }

/* ── Data helpers ───────────────────────────────────────────────────────────── */
async function fetchBalance() {
  try {
    const b = await twilio.balance.fetch();
    return { ok: true, amount: parseFloat(b.balance).toFixed(2), currency: b.currency };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pingServer() {
  const target = BASE_URL ? `${BASE_URL.replace(/\/$/, "")}/health` : null;
  if (!target) return { status: "local", uptime: process.uptime() };
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(target, { signal: ctrl.signal });
    clearTimeout(tid);
    const j = await resp.json().catch(() => ({}));
    return { status: resp.ok ? "up" : "down", uptime: j.uptime ?? process.uptime() };
  } catch {
    return { status: "down", uptime: process.uptime() };
  }
}

function buildPayload() {
  const d = new Date();
  const y = d.getFullYear(), m = d.getMonth() + 1;

  const list = Object.entries(clients).map(([key, c]) => ({
    key,
    name:      c.business_name,
    ownerName: c.owner_name  ?? null,
    ownerPhone:c.owner_phone,
    trade:     c.trade,
    goLive:    c.go_live_date ?? null,
    fee:       c.monthly_fee  ?? 149,
    hasReview: !!c.google_review_link,
    stats:     db.getMonthlyStats(key, y, m),
  }));

  const mrr    = list.reduce((s, c) => s + c.fee, 0);
  const totals = list.reduce((t, c) => ({
    chat_leads:     t.chat_leads     + c.stats.chat_leads,
    missed_calls:   t.missed_calls   + c.stats.missed_calls,
    followups_sent: t.followups_sent + c.stats.followups_sent,
    reviews_sent:   t.reviews_sent   + c.stats.reviews_sent,
  }), { chat_leads: 0, missed_calls: 0, followups_sent: 0, reviews_sent: 0 });

  return {
    period:    { year: y, month: m },
    clients:   list,
    mrr,
    totals,
    leads:     db.getRecentLeads(20),
    followups: db.getUpcomingFollowups(20),
    textbacks: db.getRecentTextBacks(20),
  };
}

/* ── Router ─────────────────────────────────────────────────────────────────── */
const router = Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: "Too many login attempts. Please wait 15 minutes and try again.",
});

router.get("/login", (req, res) => {
  if (auth.okToken(auth.parseCookies(req)[auth.COOKIE])) return res.redirect("/dashboard");
  res.type("text/html").send(loginHtml());
});

router.post("/login", loginLimiter, (req, res) => {
  const DASHBOARD_PW = process.env.DASHBOARD_PASSWORD ?? "";
  if (!DASHBOARD_PW)
    return res.status(503).type("text/html").send(loginHtml("DASHBOARD_PASSWORD not set in .env"));

  const pw = String(req.body?.password ?? "").trim();
  let valid = false;
  try {
    valid = pw.length === DASHBOARD_PW.length &&
      crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(DASHBOARD_PW));
  } catch { /* length mismatch caught above */ }

  if (!valid) return res.type("text/html").send(loginHtml("Incorrect password. Try again."));

  const tok = auth.mkToken();
  auth.applyCookie(res, tok, BASE_URL.startsWith("https"));
  res.redirect("/dashboard");
});

router.get("/logout", (req, res) => {
  auth.rmToken(auth.parseCookies(req)[auth.COOKIE]);
  auth.wipeCookie(res);
  res.redirect("/dashboard/login");
});

router.get("/api/data", guard, async (req, res) => {
  try {
    const [server, balance] = await Promise.all([pingServer(), fetchBalance()]);
    const payload = buildPayload();
    res.json({ ok: true, ts: new Date().toISOString(), server, balance, ...payload });
  } catch (e) {
    console.error("[dashboard]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/", guard, (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.removeHeader("ETag");
  res.type("text/html").send(dashboardHtml());
});

/* ═══════════════════════════════════════════════════════════════════════════
 * HTML: Login page
 * ═══════════════════════════════════════════════════════════════════════════ */
function loginHtml(msg = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GravityLead — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:#07080f;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background-image:radial-gradient(ellipse at 60% 0%,rgba(124,58,237,.18) 0%,transparent 60%)}
.card{background:#0d0f1e;border:1px solid rgba(139,92,246,.3);border-radius:18px;
  padding:44px 40px;width:100%;max-width:400px;margin:20px;
  box-shadow:0 0 80px rgba(124,58,237,.15),0 20px 60px rgba(0,0,0,.5)}
.logo{font-size:24px;font-weight:800;color:#a78bfa;margin-bottom:4px;letter-spacing:-.3px}
.sub{font-size:13px;color:#475569;margin-bottom:32px;font-weight:500}
.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);
  color:#fca5a5;padding:11px 14px;border-radius:9px;font-size:13px;margin-bottom:20px}
label{display:block;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;
  letter-spacing:.6px;margin-bottom:8px}
input[type=password]{width:100%;background:#07080f;border:1.5px solid rgba(139,92,246,.25);
  border-radius:9px;padding:13px 15px;color:#e2e8f0;font-size:15px;outline:none;
  transition:border-color .2s,box-shadow .2s}
input[type=password]:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.15)}
button{width:100%;margin-top:16px;
  background:linear-gradient(135deg,#6d28d9 0%,#7c3aed 50%,#8b5cf6 100%);
  color:#fff;border:none;border-radius:9px;padding:14px;font-size:15px;font-weight:700;
  cursor:pointer;transition:opacity .15s,transform .15s;letter-spacing:.1px}
button:hover{opacity:.92;transform:translateY(-1px)}
button:active{transform:translateY(0)}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡ GravityLead</div>
  <div class="sub">Owner Dashboard</div>
  ${msg ? `<div class="err">⚠ ${msg}</div>` : ""}
  <form method="POST" action="/dashboard/login">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" placeholder="Enter dashboard password" autofocus required>
    <button type="submit">Access Dashboard →</button>
  </form>
</div>
</body></html>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * HTML: Dashboard page
 * ═══════════════════════════════════════════════════════════════════════════ */
function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GravityLead Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
:root{
  --bg:#07080f;--surf:#0d0f1e;--surf2:#141729;
  --border:rgba(139,92,246,.14);--border-hi:rgba(139,92,246,.35);
  --p:#7c3aed;--p-dim:rgba(124,58,237,.12);--p-glow:rgba(124,58,237,.22);
  --acc:#a78bfa;--text:#e2e8f0;--muted:#94a3b8;--dim:#475569;
  --ok:#10b981;--ok-d:rgba(16,185,129,.12);
  --warn:#f59e0b;--warn-d:rgba(245,158,11,.12);
  --err:#ef4444;--err-d:rgba(239,68,68,.12);
  --r:12px;--rs:8px
}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:var(--bg);color:var(--text);line-height:1.5;
  -webkit-font-smoothing:antialiased;min-height:100vh;
  background-image:radial-gradient(ellipse at 70% -10%,var(--p-glow) 0%,transparent 50%)}
a{color:inherit;text-decoration:none}

/* ── Nav ── */
.nav{position:sticky;top:0;z-index:50;
  background:color-mix(in srgb,var(--bg) 82%,transparent);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-bottom:1px solid var(--border);padding:0 20px}
.nav-inner{max-width:1300px;margin:0 auto;display:flex;align-items:center;
  justify-content:space-between;height:60px;gap:12px}
.logo{font-size:17px;font-weight:800;color:var(--acc);display:flex;align-items:center;
  gap:9px;white-space:nowrap;letter-spacing:-.2px}
.logo-badge{font-size:10px;font-weight:600;color:var(--dim);
  background:var(--surf2);border:1px solid var(--border);
  padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.6px}
.nav-right{display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:flex-end}
.nav-meta{font-size:12px;color:var(--dim)}
.btn-logout{font-size:12px;font-weight:600;color:var(--muted);
  border:1px solid var(--border);padding:6px 14px;border-radius:999px;
  transition:border-color .2s,color .2s}
.btn-logout:hover{border-color:var(--err);color:var(--err)}
.btn-refresh{font-size:12px;font-weight:600;color:var(--acc);
  background:none;border:none;cursor:pointer;padding:0;transition:opacity .2s}
.btn-refresh:hover{opacity:.75}

/* ── Page ── */
.page{max-width:1300px;margin:0 auto;padding:28px 20px 60px}

/* ── Health strip ── */
.health-strip{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:28px}
.h-pill{display:flex;align-items:center;gap:9px;
  background:var(--surf);border:1px solid var(--border);
  border-radius:999px;padding:8px 18px;font-size:13px;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot-ok{background:var(--ok);box-shadow:0 0 0 3px var(--ok-d);animation:pulse-ok 2.5s infinite}
.dot-err{background:var(--err);box-shadow:0 0 0 3px var(--err-d)}
.dot-warn{background:var(--warn);box-shadow:0 0 0 3px var(--warn-d)}
@keyframes pulse-ok{0%,100%{box-shadow:0 0 0 3px var(--ok-d)}50%{box-shadow:0 0 0 6px rgba(16,185,129,.04)}}

/* ── KPI row ── */
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:28px}
.kpi{background:var(--surf);border:1px solid var(--border);border-radius:var(--r);
  padding:22px 22px;position:relative;overflow:hidden;transition:border-color .2s}
.kpi:hover{border-color:var(--border-hi)}
.kpi::before{content:"";position:absolute;inset:0;
  background:radial-gradient(circle at top right,var(--p-dim),transparent 65%);pointer-events:none}
.kpi-icon{font-size:20px;margin-bottom:10px}
.kpi-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;
  font-weight:600;margin-bottom:5px}
.kpi-val{font-size:38px;font-weight:800;color:var(--acc);line-height:1}
.kpi-sub{font-size:11px;color:var(--dim);margin-top:5px}

/* ── Section head ── */
.sec-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.sec-title{font-size:14px;font-weight:700;color:var(--muted);
  text-transform:uppercase;letter-spacing:.6px}

/* ── Revenue bar ── */
.rev-bar{background:linear-gradient(130deg,
  color-mix(in srgb,var(--p) 18%,var(--surf)),var(--surf));
  border:1px solid var(--border-hi);border-radius:var(--r);
  padding:22px 28px;display:flex;flex-wrap:wrap;gap:28px;
  align-items:center;margin-bottom:20px}
.rev-main{flex:1;min-width:120px}
.rev-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:5px}
.rev-val{font-size:30px;font-weight:800;color:#fff;line-height:1}
.rev-suffix{font-size:13px;font-weight:400;color:var(--muted)}
.rev-sub{font-size:12px;color:var(--dim);margin-top:4px}
.rev-stat{text-align:center;min-width:72px}
.rev-stat-num{font-size:21px;font-weight:700;color:var(--acc)}
.rev-stat-label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px;margin-top:2px}

/* ── Client grid ── */
.client-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));
  gap:16px;margin-bottom:32px}
.c-card{background:var(--surf);border:1px solid var(--border);border-radius:var(--r);
  padding:20px;transition:border-color .2s}
.c-card:hover{border-color:var(--border-hi)}
.c-head{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:11px}
.c-name{font-size:14px;font-weight:700;line-height:1.3}
.trade-badge{font-size:10px;font-weight:600;white-space:nowrap;
  background:var(--p-dim);color:var(--acc);
  border:1px solid rgba(139,92,246,.2);padding:3px 9px;border-radius:999px}
.c-meta{font-size:12px;color:var(--muted);margin-bottom:3px}
.c-divider{border:none;border-top:1px solid var(--border);margin:12px 0}
.c-stats{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.c-stat{background:var(--surf2);border-radius:var(--rs);padding:9px 11px}
.c-stat-num{font-size:19px;font-weight:700;color:var(--acc);line-height:1}
.c-stat-label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px;margin-top:2px}

/* ── Activity ── */
.act-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:18px}
.act-col{background:var(--surf);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
.act-head{padding:13px 18px;border-bottom:1px solid var(--border);
  font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
.act-item{padding:11px 18px;border-bottom:1px solid rgba(255,255,255,.03);font-size:13px}
.act-item:last-child{border-bottom:none}
.act-phone{font-weight:600;color:var(--text)}
.act-meta{color:var(--dim);font-size:11px;margin-top:2px}
.badge{display:inline-block;font-size:10px;font-weight:600;
  padding:2px 7px;border-radius:999px;margin-left:5px}
.b-chat  {background:rgba(99,102,241,.14);color:#818cf8}
.b-miss  {background:rgba(245,158,11,.14);color:#fbbf24}
.b-form  {background:rgba(16,185,129,.14);color:#34d399}
.b-d0   {background:rgba(124,58,237,.14);color:#a78bfa}
.b-d3   {background:rgba(59,130,246,.14);color:#60a5fa}
.b-d7   {background:rgba(16,185,129,.14);color:#34d399}
.b-d30  {background:rgba(245,158,11,.14);color:#fbbf24}
.empty{padding:22px 18px;color:var(--dim);font-size:13px;text-align:center}

/* ── Loading / error ── */
#loading{min-height:100vh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:18px}
.load-logo{font-size:22px;font-weight:800;color:var(--acc)}
.spinner{width:30px;height:30px;border:3px solid var(--border);
  border-top-color:var(--p);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#errscreen{min-height:100vh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:12px;padding:20px;text-align:center}
#errscreen .icon{font-size:36px}
#errscreen p{color:var(--muted);max-width:380px;font-size:14px}
#errscreen a{color:var(--acc);font-size:13px;margin-top:8px}

/* ── Responsive ── */
@media(max-width:640px){
  .nav-meta{display:none}
  .kpi-val{font-size:30px}
  .rev-val{font-size:24px}
  .logo-badge{display:none}
}
</style>
</head>
<body>

<!-- Loading -->
<div id="loading">
  <div class="load-logo">⚡ GravityLead</div>
  <div class="spinner"></div>
</div>

<!-- Error -->
<div id="errscreen" style="display:none">
  <div class="icon">⚠️</div>
  <p id="errmsg">Failed to load dashboard data.</p>
  <a href="/dashboard/login">← Back to login</a>
</div>

<!-- Dashboard -->
<div id="dash" style="display:none">
  <nav class="nav">
    <div class="nav-inner">
      <div class="logo">⚡ GravityLead <span class="logo-badge">Dashboard</span></div>
      <div class="nav-right">
        <span class="nav-meta" id="updated"></span>
        <span class="nav-meta" id="countdown"></span>
        <button class="btn-refresh" onclick="manualRefresh()">↻ Refresh</button>
        <a href="/dashboard/logout" class="btn-logout">Logout</a>
      </div>
    </div>
  </nav>

  <div class="page">
    <!-- Health -->
    <div id="health" class="health-strip"></div>

    <!-- KPIs -->
    <div id="kpis" class="kpi-row"></div>

    <!-- Revenue -->
    <div class="sec-head"><span class="sec-title">💰 Revenue</span></div>
    <div id="revbar" class="rev-bar"></div>

    <!-- Clients -->
    <div class="sec-head"><span class="sec-title">👥 Clients</span></div>
    <div id="clients" class="client-grid"></div>

    <!-- Activity -->
    <div class="sec-head" style="margin-top:8px"><span class="sec-title">📡 Activity</span></div>
    <div class="act-grid">
      <div class="act-col">
        <div class="act-head">💬 Recent Leads</div>
        <div id="leads"></div>
      </div>
      <div class="act-col">
        <div class="act-head">📞 Recent Text-backs</div>
        <div id="textbacks"></div>
      </div>
      <div class="act-col">
        <div class="act-head">⏰ Upcoming Follow-ups</div>
        <div id="followups"></div>
      </div>
    </div>
  </div>
</div>

<script>
/* ═══════════════════════════════════════════════════════════
 * GravityLead Dashboard — client script
 * ═══════════════════════════════════════════════════════════ */
const REFRESH = 60; // seconds
let cd = REFRESH, cdTimer = null;

const TRADES = {
  hvac:"🌡️ HVAC", roofing:"🏠 Roofing", plumbing:"🚰 Plumbing",
  electrical:"⚡ Electrical", landscaping:"🌿 Landscaping", painting:"🎨 Painting",
  general:"🔨 General", pressure_washing:"💧 Pressure", tree_service:"🌲 Tree",
  snow_removal:"❄️ Snow"
};

/* ── Formatters ─────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

function esc(s){ return s?String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"):""; }

function fmtPhone(e164){
  if(!e164) return "—";
  const d = e164.replace(/\\D/g,"");
  if(d.length===11&&d[0]==="1") return "("+d.slice(1,4)+") "+d.slice(4,7)+"-"+d.slice(7);
  return e164;
}

function fmtUSD(n){
  return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:0}).format(n);
}

function timeAgo(sql){
  if(!sql) return "—";
  const iso = sql.replace(" ","T")+(sql.includes("T")?"":"Z");
  const s   = Math.floor((Date.now()-new Date(iso))/1000);
  if(s<60)  return "just now";
  const m=Math.floor(s/60); if(m<60) return m+"m ago";
  const h=Math.floor(m/60); if(h<24) return h+"h ago";
  return Math.floor(h/24)+"d ago";
}

function fmtDt(sql){
  if(!sql) return "—";
  const iso = sql.replace(" ","T")+(sql.includes("T")?"":"Z");
  return new Date(iso).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
}

function fmtUptime(s){
  s=Math.round(s);
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
  if(h>=24) return Math.floor(h/24)+"d "+h%24+"h";
  if(h>0)   return h+"h "+m+"m";
  return m+"m";
}

function fmtMonth(y,m){
  return new Date(y,m-1,1).toLocaleString("en-US",{month:"long",year:"numeric"});
}

function srcBadge(src){
  if(src==="missed_call") return '<span class="badge b-miss">📞 Missed Call</span>';
  if(src==="chat")        return '<span class="badge b-chat">💬 AI Chat</span>';
  return                         '<span class="badge b-form">📋 Form</span>';
}

function dayBadge(day){
  const c=({0:"b-d0",3:"b-d3",7:"b-d7",30:"b-d30"})[day]||"b-d0";
  return \`<span class="badge \${c}">Day \${day}</span>\`;
}

/* ── Load ───────────────────────────────────────────────────── */
async function load(){
  try{
    const ctrl = new AbortController();
    const to = setTimeout(()=>ctrl.abort(), 15000);
    let r;
    try {
      r = await fetch("/dashboard/api/data", {
        headers:{ "Accept":"application/json", "X-Requested-With":"XMLHttpRequest" },
        redirect:"manual",
        signal: ctrl.signal,
      });
    } finally { clearTimeout(to); }
    if(r.redirected||r.type==="opaqueredirect"||r.status===401||r.status===302||r.status===0){location="/dashboard/login";return;}
    if(!r.ok) throw new Error("HTTP "+r.status);
    const ct = r.headers.get("content-type")||"";
    if(!ct.includes("application/json")){location="/dashboard/login";return;}
    const d = await r.json();
    if(!d.ok) throw new Error(d.error||"Unknown error");
    render(d);
    $("loading").style.display="none";
    $("dash").style.display="block";
    $("updated").textContent="Updated just now";
    resetCd();
  }catch(e){
    console.error(e);
    $("loading").style.display="none";
    $("errscreen").style.display="flex";
    $("errmsg").textContent="Failed to load: "+e.message;
  }
}

function render(d){
  renderHealth(d.server,d.balance);
  renderKPIs(d.totals,d.period);
  renderRevenue(d.mrr,d.clients);
  renderClients(d.clients,d.period);
  renderLeads(d.leads);
  renderTextBacks(d.textbacks);
  renderFollowups(d.followups);
}

/* ── Health strip ───────────────────────────────────────────── */
function renderHealth(srv,bal){
  const up = srv.status==="up"||srv.status==="local";
  const balOk = bal?.ok && bal.amount!=null;
  const balAmt = balOk ? parseFloat(bal.amount) : null;
  const balColor = !balOk ? "var(--err)" : balAmt<5 ? "var(--err)" : balAmt<20 ? "var(--warn)" : "var(--ok)";
  $("health").innerHTML =
    \`<div class="h-pill"><span class="dot \${up?"dot-ok":"dot-err"}"></span>
      <span>\${up?"Server Online":"Server Offline"}</span>
      \${up?\`<span style="color:var(--dim);font-weight:400">↑ \${fmtUptime(srv.uptime)}</span>\`:""}
    </div>
    <div class="h-pill"><span style="font-size:14px">💳</span>
      <span>Twilio</span>
      <span style="color:\${balColor};font-weight:700">
        \${balOk?\`\$\${bal.amount} \${bal.currency}\`:"—"}
      </span>
    </div>\`;
}

/* ── KPI row ────────────────────────────────────────────────── */
function renderKPIs(t,period){
  const mo = fmtMonth(period.year,period.month);
  $("kpis").innerHTML = [
    {icon:"💬",label:"AI Leads",val:t.chat_leads},
    {icon:"📞",label:"Missed Calls Recovered",val:t.missed_calls},
    {icon:"📤",label:"Follow-ups Sent",val:t.followups_sent},
    {icon:"⭐",label:"Review Requests",val:t.reviews_sent},
  ].map(k=>\`
    <div class="kpi">
      <div class="kpi-icon">\${k.icon}</div>
      <div class="kpi-label">\${k.label}</div>
      <div class="kpi-val">\${k.val}</div>
      <div class="kpi-sub">\${mo}</div>
    </div>\`).join("");
}

/* ── Revenue bar ────────────────────────────────────────────── */
function renderRevenue(mrr,clients){
  const arr  = mrr*12;
  const avg  = clients.length ? Math.round(mrr/clients.length) : 0;
  $("revbar").innerHTML = \`
    <div class="rev-main">
      <div class="rev-label">Monthly Recurring Revenue</div>
      <div class="rev-val">\${fmtUSD(mrr)}<span class="rev-suffix">/mo</span></div>
      <div class="rev-sub">\${clients.length} active client\${clients.length!==1?"s":""}</div>
    </div>
    <div class="rev-stat"><div class="rev-stat-num">\${clients.length}</div><div class="rev-stat-label">Clients</div></div>
    <div class="rev-stat"><div class="rev-stat-num">\${fmtUSD(avg)}</div><div class="rev-stat-label">Avg / Client</div></div>
    <div class="rev-stat"><div class="rev-stat-num">\${fmtUSD(arr)}</div><div class="rev-stat-label">ARR</div></div>\`;
}

/* ── Client grid ────────────────────────────────────────────── */
function renderClients(clients,period){
  const mo = fmtMonth(period.year,period.month);
  if(!clients.length){
    $("clients").innerHTML='<div class="empty">No clients in clients.json</div>';return;
  }
  $("clients").innerHTML = clients.map(c=>\`
    <div class="c-card">
      <div class="c-head">
        <div class="c-name">\${esc(c.name)}</div>
        <div class="trade-badge">\${TRADES[c.trade]||esc(c.trade)}</div>
      </div>
      <div class="c-meta">📱 \${fmtPhone(c.key)}</div>
      <div class="c-meta">👤 \${esc(c.ownerName||"Owner")} · \${fmtPhone(c.ownerPhone)}</div>
      \${c.goLive?\`<div class="c-meta">📅 Live \${new Date(c.goLive).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>\`:""}
      <div class="c-meta">💰 \${fmtUSD(c.fee)}/mo\${c.hasReview?" · ⭐ Reviews on":""}</div>
      <hr class="c-divider">
      <div class="c-stats">
        <div class="c-stat"><div class="c-stat-num">\${c.stats.chat_leads}</div><div class="c-stat-label">AI Leads</div></div>
        <div class="c-stat"><div class="c-stat-num">\${c.stats.missed_calls}</div><div class="c-stat-label">Missed Calls</div></div>
        <div class="c-stat"><div class="c-stat-num">\${c.stats.followups_sent}</div><div class="c-stat-label">Follow-ups</div></div>
        <div class="c-stat"><div class="c-stat-num">\${c.stats.reviews_sent}</div><div class="c-stat-label">Reviews</div></div>
      </div>
      <div style="font-size:11px;color:var(--dim);margin-top:9px">\${mo}</div>
    </div>\`).join("");
}

/* ── Leads ──────────────────────────────────────────────────── */
function renderLeads(leads){
  if(!leads?.length){$("leads").innerHTML='<div class="empty">No leads yet</div>';return;}
  $("leads").innerHTML = leads.map(l=>\`
    <div class="act-item">
      <div class="act-phone">\${fmtPhone(l.phone)}\${srcBadge(l.source)}</div>
      <div class="act-meta">\${esc(l.name||"Unknown")} · \${esc(l.business_key)} · \${timeAgo(l.created_at)}</div>
    </div>\`).join("");
}

/* ── Text-backs ─────────────────────────────────────────────── */
function renderTextBacks(tb){
  if(!tb?.length){$("textbacks").innerHTML='<div class="empty">No text-backs yet</div>';return;}
  $("textbacks").innerHTML = tb.map(t=>\`
    <div class="act-item">
      <div class="act-phone">\${fmtPhone(t.to_number)}</div>
      <div class="act-meta">\${esc(t.name||t.caller||"Unknown")} · \${esc(t.business_key||"")} · \${timeAgo(t.created_at)}</div>
    </div>\`).join("");
}

/* ── Follow-ups ─────────────────────────────────────────────── */
function renderFollowups(fus){
  if(!fus?.length){$("followups").innerHTML='<div class="empty">No upcoming follow-ups</div>';return;}
  $("followups").innerHTML = fus.map(f=>\`
    <div class="act-item">
      <div class="act-phone">\${fmtPhone(f.phone)}\${dayBadge(f.day)}</div>
      <div class="act-meta">\${esc(f.name||"Unknown")} · \${fmtDt(f.scheduled_at)}</div>
    </div>\`).join("");
}

/* ── Auto-refresh ───────────────────────────────────────────── */
function resetCd(){
  clearInterval(cdTimer);
  cd = REFRESH;
  cdTimer = setInterval(()=>{
    cd--;
    $("countdown").textContent = "↻ "+cd+"s";
    if(cd<=0){clearInterval(cdTimer);load();}
  },1000);
}

function manualRefresh(){
  clearInterval(cdTimer);
  $("countdown").textContent="";
  $("loading").style.display="flex";
  $("dash").style.display="none";
  load();
}

load();
</script>
</body></html>`;
}

module.exports = { router, init };
