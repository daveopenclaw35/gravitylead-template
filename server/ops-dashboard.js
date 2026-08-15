/* ============================================================================
 * GravityLead — System Operations Dashboard
 *
 * Password-protected single-page ops board showing real-time health/status
 * of every connected system with green / yellow / red indicators.
 *
 * Shares the session cookie with /dashboard — one login unlocks both.
 *
 * Mount in index.js:
 *   const ops = require("./ops-dashboard");
 *   ops.init(twilioClient, clients, BASE_URL);
 *   app.use("/ops", ops.router);
 *
 * Routes:
 *   GET  /ops            — ops UI (auth required)
 *   GET  /ops/login      — login form
 *   POST /ops/login      — authenticate
 *   GET  /ops/logout     — clear session
 *   GET  /ops/api/data   — live JSON payload (auth required)
 *
 * .env additions required:
 *   OPENCLAW_GATEWAY_URL   Base URL of the OpenClaw gateway (e.g. http://localhost:4000)
 *   GITHUB_REPO            owner/repo  (e.g. daveopenclaw35/gravitylead-template)
 *   GITHUB_TOKEN           Personal access token (optional; avoids rate limits)
 *   STRIPE_SECRET_KEY      sk_live_… or sk_test_…
 *   UPTIMEROBOT_API_KEY    From uptimerobot.com → My Settings → API Settings
 *   ANTHROPIC_API_KEY      Anthropic API key
 *   TELEGRAM_BOT_TOKEN     Telegram bot token for webhook status check
 * ========================================================================== */
"use strict";

const { Router } = require("express");
const crypto     = require("crypto");
const auth       = require("./auth");

/* ── Module state ───────────────────────────────────────────────────────────── */
let _tw      = null;
let _clients = {};
let _BASE    = "";
const START  = Date.now();

function init(tw, cl, baseUrl) { _tw = tw; _clients = cl; _BASE = baseUrl || ""; }

/* ── Helpers ─────────────────────────────────────────────────────────────────── */
function isHttps() { return _BASE.startsWith("https"); }

async function ft(url, opts = {}, ms = 7000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try   { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(tid); }
}

// Race any promise (e.g. a Twilio SDK call that has no AbortController) against
// a hard timeout so one slow/hanging dependency can't stall the whole dashboard.
function withTimeout(promise, ms = 8000, label = "operation") {
  let tid;
  const timeout = new Promise((_, rej) => {
    tid = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(tid));
}

/* ══════════════════════════════════════════════════════════════════════════════
 * SYSTEM CHECKS
 * Each returns { ok: bool|null, status: string, ...extra }
 *   ok=true  → green   ok=false → red   ok=null → gray (unconfigured)
 * ══════════════════════════════════════════════════════════════════════════════ */

async function checkRender() {
  return { ok: true, status: "up", uptime: (Date.now() - START) / 1000 };
}

async function checkOpenClaw() {
  const url = process.env.OPENCLAW_GATEWAY_URL;
  if (!url) return { ok: null, status: "unconfigured" };
  try {
    const r = await ft(`${url.replace(/\/$/, "")}/health`, {}, 6000);
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.ok ? "up" : "degraded", uptime: j.uptime ?? null };
  } catch (e) { return { ok: false, status: "down", reason: e.message }; }
}

async function checkTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: null, status: "unconfigured" };
  try {
    const r = await ft(`https://api.telegram.org/bot${token}/getWebhookInfo`, {}, 6000);
    const j = await r.json();
    if (!j.ok) return { ok: false, status: "error", reason: j.description };
    const active = !!(j.result?.url);
    return {
      ok:          active,
      status:      active ? "connected" : "no_webhook",
      pending:     j.result?.pending_update_count ?? 0,
      lastError:   j.result?.last_error_message   ?? null,
      lastErrorTs: j.result?.last_error_date       ?? null,
    };
  } catch (e) { return { ok: false, status: "down", reason: e.message }; }
}

async function checkTwilio() {
  if (!_tw) return { ok: false, status: "error", reason: "Not initialized" };
  try {
    const [bal, nums] = await withTimeout(
      Promise.all([
        _tw.balance.fetch(),
        _tw.incomingPhoneNumbers.list({ limit: 50 }),
      ]),
      8000,
      "Twilio API"
    );
    const amt = parseFloat(bal.balance);
    return {
      ok:       amt > 1,
      status:   amt < 5 ? "low_balance" : "ok",
      amount:   amt.toFixed(2),
      currency: bal.currency,
      numbers:  nums.map(n => ({
        number:       n.phoneNumber,
        friendlyName: n.friendlyName,
        voice:        n.capabilities?.voice ?? false,
        sms:          n.capabilities?.sms   ?? false,
        mms:          n.capabilities?.mms   ?? false,
      })),
    };
  } catch (e) { return { ok: false, status: "error", reason: e.message }; }
}

async function checkWebsite() {
  const t0 = Date.now();
  try {
    const r = await ft("https://getgravitylead.com", { method: "HEAD" }, 10000);
    return { ok: r.ok || r.status < 400, status: r.ok ? "up" : "degraded", httpStatus: r.status, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, status: "down", reason: e.message }; }
}

async function checkGitHub() {
  const repo  = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo) return { ok: null, status: "unconfigured" };
  const headers = {
    Accept:       "application/vnd.github.v3+json",
    "User-Agent": "GravityLead-Ops/1.0",
    ...(token ? { Authorization: `token ${token}` } : {}),
  };
  try {
    const [cr, rr] = await Promise.all([
      ft(`https://api.github.com/repos/${repo}/commits?per_page=1`, { headers }, 8000),
      ft(`https://api.github.com/repos/${repo}`,                    { headers }, 8000),
    ]);
    const commits  = await cr.json();
    const repoData = await rr.json();
    const c = Array.isArray(commits) ? commits[0] : null;
    return {
      ok:            cr.ok,
      status:        cr.ok ? "ok" : "error",
      repo:          repoData.full_name     ?? repo,
      defaultBranch: repoData.default_branch ?? "main",
      pushedAt:      repoData.pushed_at      ?? null,
      commit: c ? {
        sha:     c.sha?.slice(0, 7),
        message: c.commit?.message?.split("\n")[0] ?? "",
        author:  c.commit?.author?.name            ?? "",
        date:    c.commit?.author?.date            ?? null,
        url:     c.html_url                        ?? null,
      } : null,
    };
  } catch (e) { return { ok: false, status: "error", reason: e.message }; }
}

async function checkFormspree() {
  const ep = process.env.FORMSPREE_ENDPOINT;
  if (!ep) return { ok: null, status: "unconfigured" };
  try {
    const r = await ft(ep, { method: "GET", headers: { Accept: "application/json" } }, 8000);
    return { ok: r.status < 500, status: r.status < 500 ? "up" : "down", httpStatus: r.status };
  } catch (e) { return { ok: false, status: "down", reason: e.message }; }
}

async function checkStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { ok: null, status: "unconfigured" };
  const hdrs = { Authorization: `Bearer ${key}` };
  try {
    const [br, cr] = await Promise.all([
      ft("https://api.stripe.com/v1/balance",         { headers: hdrs }, 8000),
      ft("https://api.stripe.com/v1/charges?limit=5", { headers: hdrs }, 8000),
    ]);
    const bal = await br.json();
    const chg = await cr.json();
    if (!br.ok) return { ok: false, status: "error", reason: bal.error?.message ?? "Stripe error" };
    const avail = (bal.available || []).reduce((s, b) => s + b.amount, 0) / 100;
    return {
      ok:       true,
      status:   "active",
      livemode: bal.livemode,
      available: avail,
      charges:  (chg.data || []).map(c => ({
        amount:      c.amount / 100,
        currency:    c.currency,
        status:      c.status,
        description: c.description ?? "",
        created:     c.created,
        refunded:    c.refunded,
      })),
    };
  } catch (e) { return { ok: false, status: "error", reason: e.message }; }
}

async function checkUptimeRobot() {
  const key = process.env.UPTIMEROBOT_API_KEY;
  if (!key) return { ok: null, status: "unconfigured" };
  try {
    const r = await ft(
      "https://api.uptimerobot.com/v2/getMonitors",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          api_key:              key,
          format:               "json",
          response_times:       1,
          response_times_limit: 1,
          custom_uptime_ratios: "30",
        }),
      },
      10000
    );
    const j = await r.json();
    if (j.stat !== "ok") return { ok: false, status: "error", reason: j.error?.message ?? "UptimeRobot error" };
    const STATUS_MAP = { 0: "paused", 1: "pending", 2: "up", 8: "degraded", 9: "down" };
    const monitors   = (j.monitors || []).map(m => ({
      id:           m.id,
      name:         m.friendly_name,
      url:          m.url,
      status:       STATUS_MAP[m.status] ?? "unknown",
      statusCode:   m.status,
      uptime:       m.custom_uptime_ratio   ?? m.all_time_uptime_ratio ?? null,
      responseTime: m.response_times?.[0]?.value ?? null,
    }));
    const allUp = monitors.every(m => m.statusCode === 2);
    return { ok: allUp, status: "ok", monitors };
  } catch (e) { return { ok: false, status: "error", reason: e.message }; }
}

async function checkAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: null, status: "unconfigured" };
  try {
    const r = await ft(
      "https://api.anthropic.com/v1/models",
      { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } },
      8000
    );
    if (r.ok)           return { ok: true,  status: "active" };
    if (r.status === 401) return { ok: false, status: "invalid_key" };
    return { ok: false, status: "error", httpStatus: r.status };
  } catch (e) { return { ok: false, status: "error", reason: e.message }; }
}

/* ── Aggregate all checks in parallel ──────────────────────────────────────── */
async function gatherAll() {
  // Wrap every probe in a hard timeout so no single dependency can stall the
  // aggregate response. allSettled already isolates failures; this bounds latency.
  const guarded = fn => withTimeout(Promise.resolve().then(fn), 9000, fn.name || "check")
    .catch(e => ({ ok: false, status: "error", reason: e.message }));
  const settled = await Promise.allSettled([
    guarded(checkRender), guarded(checkOpenClaw), guarded(checkTelegram), guarded(checkTwilio),
    guarded(checkWebsite), guarded(checkGitHub), guarded(checkFormspree), guarded(checkStripe),
    guarded(checkUptimeRobot), guarded(checkAnthropic),
  ]);
  const unwrap = r => r.status === "fulfilled"
    ? r.value
    : { ok: false, status: "error", reason: r.reason?.message ?? "Check failed" };
  const [render, openclaw, telegram, twilio, website, github, formspree, stripe, uptimerobot, anthropic] =
    settled.map(unwrap);
  return { ts: new Date().toISOString(), render, openclaw, telegram, twilio, website, github, formspree, stripe, uptimerobot, anthropic };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * ROUTER
 * ══════════════════════════════════════════════════════════════════════════════ */
const router = Router();
const guard  = auth.guard("/ops/login");

router.get("/login", (req, res) => {
  if (auth.okToken(auth.parseCookies(req)[auth.COOKIE])) return res.redirect("/ops");
  res.type("text/html").send(loginHtml());
});

router.post("/login", (req, res) => {
  const PW = process.env.DASHBOARD_PASSWORD ?? "";
  if (!PW) return res.status(503).type("text/html").send(loginHtml("DASHBOARD_PASSWORD not set in .env"));
  const given = String(req.body?.password ?? "").trim();
  let ok = false;
  try { ok = given.length === PW.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PW)); } catch { /* */ }
  if (!ok) return res.type("text/html").send(loginHtml("Incorrect password. Try again."));
  auth.applyCookie(res, auth.mkToken(), isHttps());
  res.redirect("/ops");
});

router.get("/logout", (req, res) => {
  auth.rmToken(auth.parseCookies(req)[auth.COOKIE]);
  auth.wipeCookie(res);
  res.redirect("/ops/login");
});

router.get("/api/data", guard, async (req, res) => {
  try   { res.json({ ok: true, ...(await gatherAll()) }); }
  catch (e) { console.error("[ops]", e); res.status(500).json({ ok: false, error: e.message }); }
});

router.get("/", guard, (_req, res) => res.type("text/html").send(opsHtml()));

module.exports = { router, init };

/* ══════════════════════════════════════════════════════════════════════════════
 * HTML — Login page
 * ══════════════════════════════════════════════════════════════════════════════ */
function loginHtml(msg = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GravityLead — Ops Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:#07080f;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background-image:radial-gradient(ellipse at 60% 0%,rgba(124,58,237,.18) 0%,transparent 60%)}
.card{background:#0d0f1e;border:1px solid rgba(139,92,246,.3);border-radius:18px;
  padding:44px 40px;width:100%;max-width:400px;margin:20px;
  box-shadow:0 0 80px rgba(124,58,237,.15),0 20px 60px rgba(0,0,0,.5)}
.logo{font-size:24px;font-weight:800;color:#a78bfa;margin-bottom:2px;letter-spacing:-.3px}
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
.alt{margin-top:18px;text-align:center;font-size:12px;color:#475569}
.alt a{color:#7c3aed;text-decoration:none}
.alt a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡ GravityLead</div>
  <div class="sub">System Operations Dashboard</div>
  ${msg ? `<div class="err">⚠ ${msg}</div>` : ""}
  <form method="POST" action="/ops/login">
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" placeholder="Enter dashboard password" autofocus required>
    <button type="submit">Access Ops Dashboard →</button>
  </form>
  <div class="alt"><a href="/dashboard/login">← Owner Dashboard</a></div>
</div>
</body></html>`;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * HTML — Ops Dashboard page
 * ══════════════════════════════════════════════════════════════════════════════ */
function opsHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GravityLead — Ops Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
:root{
  --bg:#07080f;--surf:#0d0f1e;--surf2:#141729;--surf3:#1a1d30;
  --border:rgba(139,92,246,.14);--border-hi:rgba(139,92,246,.35);
  --p:#7c3aed;--p-dim:rgba(124,58,237,.12);--p-glow:rgba(124,58,237,.22);
  --acc:#a78bfa;--text:#e2e8f0;--muted:#94a3b8;--dim:#475569;
  --ok:#10b981;--ok-d:rgba(16,185,129,.14);--ok-b:rgba(16,185,129,.08);
  --warn:#f59e0b;--warn-d:rgba(245,158,11,.14);--warn-b:rgba(245,158,11,.08);
  --err:#ef4444;--err-d:rgba(239,68,68,.14);--err-b:rgba(239,68,68,.08);
  --gray:#475569;--gray-d:rgba(71,85,105,.2);
  --r:12px;--rs:8px
}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;min-height:100vh;
  background-image:radial-gradient(ellipse at 70% -10%,var(--p-glow) 0%,transparent 50%)}

/* ── Nav ── */
.nav{position:sticky;top:0;z-index:50;
  background:color-mix(in srgb,var(--bg) 82%,transparent);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-bottom:1px solid var(--border);padding:0 20px}
.nav-inner{max-width:1400px;margin:0 auto;display:flex;align-items:center;
  justify-content:space-between;height:60px;gap:12px}
.logo{font-size:17px;font-weight:800;color:var(--acc);display:flex;align-items:center;
  gap:9px;white-space:nowrap;letter-spacing:-.2px}
.logo-badge{font-size:10px;font-weight:600;color:var(--dim);background:var(--surf2);
  border:1px solid var(--border);padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.6px}
.nav-right{display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:flex-end}
.nav-meta{font-size:12px;color:var(--dim)}
.btn{font-size:12px;font-weight:600;border:1px solid var(--border);padding:6px 14px;
  border-radius:999px;transition:border-color .2s,color .2s;background:none;cursor:pointer}
.btn-logout{color:var(--muted)}.btn-logout:hover{border-color:var(--err);color:var(--err)}
.btn-refresh{color:var(--acc)}.btn-refresh:hover{opacity:.75}
.btn-owner{color:var(--muted);text-decoration:none}.btn-owner:hover{border-color:var(--acc);color:var(--acc)}

/* ── Page ── */
.page{max-width:1400px;margin:0 auto;padding:28px 20px 60px}

/* ── Section header ── */
.sec{margin-bottom:14px}
.sec-title{font-size:12px;font-weight:700;color:var(--muted);
  text-transform:uppercase;letter-spacing:.7px;display:flex;align-items:center;gap:8px}
.sec-title::after{content:"";flex:1;border-top:1px solid var(--border)}

/* ── Dot indicators ── */
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;display:inline-block}
.dot-ok  {background:var(--ok);  box-shadow:0 0 0 3px var(--ok-d); animation:pulse-ok 2.5s infinite}
.dot-warn{background:var(--warn);box-shadow:0 0 0 3px var(--warn-d)}
.dot-err {background:var(--err); box-shadow:0 0 0 3px var(--err-d)}
.dot-gray{background:var(--gray);box-shadow:0 0 0 3px var(--gray-d)}
@keyframes pulse-ok{0%,100%{box-shadow:0 0 0 3px var(--ok-d)}50%{box-shadow:0 0 0 7px rgba(16,185,129,.03)}}

/* ── Status card grid ── */
.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-bottom:32px}
.s-card{background:var(--surf);border:1px solid var(--border);border-radius:var(--r);
  padding:18px 20px;transition:border-color .2s,transform .15s;cursor:default;position:relative;overflow:hidden}
.s-card::before{content:"";position:absolute;inset:0;
  background:radial-gradient(circle at top right,var(--p-dim),transparent 70%);pointer-events:none}
.s-card:hover{border-color:var(--border-hi);transform:translateY(-1px)}
.s-card.ok  {border-left:3px solid var(--ok)}
.s-card.warn{border-left:3px solid var(--warn)}
.s-card.err {border-left:3px solid var(--err)}
.s-card.gray{border-left:3px solid var(--gray)}
.s-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.s-icon{font-size:18px;line-height:1}
.s-name{font-size:13px;font-weight:700;color:var(--text);margin-bottom:5px}
.s-status{font-size:12px;color:var(--muted);line-height:1.4}
.s-metric{font-size:15px;font-weight:700;color:var(--acc);margin-top:6px}

/* ── Detail panels ── */
.panel-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px;margin-bottom:32px}
.panel{background:var(--surf);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
.panel-head{padding:13px 18px;border-bottom:1px solid var(--border);
  font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);
  display:flex;align-items:center;gap:8px}
.panel-empty{padding:20px 18px;color:var(--dim);font-size:13px;text-align:center}

/* ── Table ── */
.tbl{width:100%;border-collapse:collapse}
.tbl th{padding:8px 16px;text-align:left;font-size:10px;font-weight:700;
  text-transform:uppercase;letter-spacing:.5px;color:var(--dim);
  border-bottom:1px solid var(--border);background:var(--surf2)}
.tbl td{padding:11px 16px;font-size:13px;border-bottom:1px solid rgba(255,255,255,.03)}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:rgba(255,255,255,.02)}

/* ── Monitor status badge ── */
.ms{display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px}
.ms-up      {background:var(--ok-b);  color:var(--ok);  border:1px solid rgba(16,185,129,.2)}
.ms-degraded{background:var(--warn-b);color:var(--warn);border:1px solid rgba(245,158,11,.2)}
.ms-down    {background:var(--err-b); color:var(--err);  border:1px solid rgba(239,68,68,.2)}
.ms-paused  {background:var(--gray-d);color:var(--gray);border:1px solid rgba(71,85,105,.3)}
.ms-pending {background:var(--gray-d);color:var(--gray);border:1px solid rgba(71,85,105,.3)}

/* ── Charge badge ── */
.chg-ok  {background:var(--ok-b);  color:var(--ok);  border:1px solid rgba(16,185,129,.2);
  display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px}
.chg-fail{background:var(--err-b); color:var(--err);  border:1px solid rgba(239,68,68,.2);
  display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px}
.chg-ref {background:var(--warn-b);color:var(--warn);border:1px solid rgba(245,158,11,.2);
  display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px}

/* ── GitHub panel ── */
.gh-commit{padding:16px 18px;display:flex;flex-direction:column;gap:6px}
.gh-sha{font-family:"SF Mono",Menlo,Monaco,Consolas,monospace;font-size:12px;
  background:var(--surf2);color:var(--acc);padding:3px 8px;border-radius:5px;
  display:inline-block;margin-right:6px}
.gh-msg{font-size:14px;color:var(--text);font-weight:500}
.gh-meta{font-size:12px;color:var(--dim)}
.gh-link{font-size:12px;color:var(--p);text-decoration:none}
.gh-link:hover{text-decoration:underline}

/* ── Summary bar ── */
.summary{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:28px;align-items:center}
.sum-pill{display:flex;align-items:center;gap:8px;background:var(--surf);
  border:1px solid var(--border);border-radius:999px;padding:8px 16px;font-size:13px;font-weight:600}
.sum-count{font-size:18px;font-weight:800;color:var(--acc)}

/* ── Loading / error ── */
#loading{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
.load-logo{font-size:22px;font-weight:800;color:var(--acc)}
.spinner{width:30px;height:30px;border:3px solid var(--border);
  border-top-color:var(--p);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#errscreen{min-height:100vh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:12px;padding:20px;text-align:center}
#errscreen .icon{font-size:36px}
#errscreen p{color:var(--muted);max-width:380px;font-size:14px}
#errscreen a{color:var(--acc);font-size:13px;margin-top:8px}

@media(max-width:640px){
  .nav-meta,.logo-badge{display:none}
  .card-grid{grid-template-columns:1fr 1fr}
}
@media(max-width:400px){
  .card-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>

<div id="loading"><div class="load-logo">⚡ GravityLead</div><div class="spinner"></div></div>

<div id="errscreen" style="display:none">
  <div class="icon">⚠️</div>
  <p id="errmsg">Failed to load ops data.</p>
  <a href="/ops/login">← Back to login</a>
</div>

<div id="dash" style="display:none">
  <nav class="nav">
    <div class="nav-inner">
      <div class="logo">⚡ GravityLead <span class="logo-badge">Ops</span></div>
      <div class="nav-right">
        <span class="nav-meta" id="updated"></span>
        <span class="nav-meta" id="countdown"></span>
        <button class="btn btn-refresh" onclick="manualRefresh()">↻ Refresh</button>
        <a href="/dashboard" class="btn btn-owner">Dashboard</a>
        <a href="/ops/logout" class="btn btn-logout">Logout</a>
      </div>
    </div>
  </nav>

  <div class="page">
    <!-- Summary -->
    <div id="summary" class="summary"></div>

    <!-- Status cards -->
    <div class="sec"><div class="sec-title">🔴 System Status</div></div>
    <div id="cards" class="card-grid"></div>

    <!-- Details -->
    <div class="sec"><div class="sec-title">📋 Details</div></div>
    <div class="panel-grid">
      <div class="panel">
        <div class="panel-head">📱 Twilio Numbers</div>
        <div id="twilio-numbers"><div class="panel-empty">Loading…</div></div>
      </div>
      <div class="panel">
        <div class="panel-head">🤖 UptimeRobot Monitors</div>
        <div id="uptime-monitors"><div class="panel-empty">Loading…</div></div>
      </div>
    </div>
    <div class="panel-grid">
      <div class="panel">
        <div class="panel-head">💳 Stripe — Recent Charges</div>
        <div id="stripe-charges"><div class="panel-empty">Loading…</div></div>
      </div>
      <div class="panel">
        <div class="panel-head" id="github-head">🔗 GitHub — Last Deployment</div>
        <div id="github-commit"><div class="panel-empty">Loading…</div></div>
      </div>
    </div>
  </div>
</div>

<script>
/* ═══════════════════════════════════════════════════════════
 * GravityLead Ops Dashboard — client script
 * ═══════════════════════════════════════════════════════════ */
const REFRESH = 60;
let cd = REFRESH, cdTimer = null;

const $ = id => document.getElementById(id);
function esc(s){ return s ? String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") : ""; }

function fmtUptime(s){
  s = Math.round(s || 0);
  const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60);
  if(d>0) return d+"d "+h+"h";
  if(h>0) return h+"h "+m+"m";
  return m+"m";
}

function timeAgo(iso){
  if(!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if(s<60)   return "just now";
  const m=Math.floor(s/60); if(m<60) return m+"m ago";
  const h=Math.floor(m/60); if(h<24) return h+"h ago";
  return Math.floor(h/24)+"d ago";
}

function fmtDate(ts){
  if(!ts) return "—";
  const d = typeof ts === "number" ? new Date(ts*1000) : new Date(ts);
  return d.toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
}

function fmtUSD(n){
  return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n||0);
}

function fmtPhone(e164){
  if(!e164) return "—";
  const d = e164.replace(/\\D/g,"");
  if(d.length===11&&d[0]==="1") return "("+d.slice(1,4)+") "+d.slice(4,7)+"-"+d.slice(7);
  return e164;
}

/* ── Card builder ─────────────────────────────────────────── */
function dotClass(ok){
  if(ok===null||ok===undefined) return "dot-gray";
  if(ok===true)  return "dot-ok";
  if(ok==="warn") return "dot-warn";
  return "dot-err";
}
function cardColor(ok){
  if(ok===null||ok===undefined) return "gray";
  if(ok===true)  return "ok";
  if(ok==="warn") return "warn";
  return "err";
}

function card(icon, name, ok, statusLine, metric){
  const dc = dotClass(ok);
  const cc = cardColor(ok);
  return \`<div class="s-card \${cc}">
    <div class="s-head">
      <span class="s-icon">\${icon}</span>
      <span class="dot \${dc}"></span>
    </div>
    <div class="s-name">\${name}</div>
    <div class="s-status">\${esc(statusLine||"")}</div>
    \${metric ? \`<div class="s-metric">\${metric}</div>\` : ""}
  </div>\`;
}

/* ── Render all ────────────────────────────────────────────── */
async function load(){
  try{
    const r = await fetch("/ops/api/data");
    if(r.redirected||r.status===401||r.status===302){ location="/ops/login"; return; }
    if(!r.ok) throw new Error("HTTP "+r.status);
    const d = await r.json();
    if(!d.ok) throw new Error(d.error||"Unknown error");
    render(d);
    $("loading").style.display="none";
    $("dash").style.display="block";
    $("updated").textContent="Updated just now";
    resetCd();
  } catch(e){
    console.error(e);
    $("loading").style.display="none";
    $("errscreen").style.display="flex";
    $("errmsg").textContent="Failed to load: "+e.message;
  }
}

function render(d){
  renderSummary(d);
  renderCards(d);
  renderTwilioNumbers(d.twilio);
  renderUptimeMonitors(d.uptimerobot);
  renderStripeCharges(d.stripe);
  renderGitHub(d.github);
}

/* ── Summary bar ────────────────────────────────────────────── */
function renderSummary(d){
  const checks = [d.render,d.openclaw,d.telegram,d.twilio,d.website,d.github,d.formspree,d.stripe,d.uptimerobot,d.anthropic];
  const total  = checks.length;
  const up     = checks.filter(c=>c.ok===true).length;
  const down   = checks.filter(c=>c.ok===false).length;
  const uncfg  = checks.filter(c=>c.ok===null).length;
  const statusOk = down === 0;
  $("summary").innerHTML =
    \`<div class="sum-pill"><span class="dot \${down>0?"dot-err":"dot-ok"}"></span>
      \${down>0 ? down+" system\${down>1?"s":""} down" : "All systems operational"}
    </div>
    <div class="sum-pill"><span class="sum-count">\${up}/\${total-uncfg}</span><span style="color:var(--dim);margin-left:4px">online</span></div>
    \${uncfg>0?\`<div class="sum-pill" style="color:var(--dim)">\${uncfg} unconfigured</div>\`:""}\`;
}

/* ── Status cards ────────────────────────────────────────────── */
function renderCards(d){
  /* Render server */
  const renderOk = d.render.ok;
  const renderCard = card("🖥️","Render Server", renderOk,
    "GravityLead SMS server", renderOk ? "↑ "+fmtUptime(d.render.uptime) : "Offline");

  /* OpenClaw */
  const ocOk = d.openclaw.ok;
  const ocLine = ocOk===null ? "Not configured" :
                 ocOk ? "Gateway online" : (d.openclaw.reason||"Unreachable");
  const ocCard = card("🤖","OpenClaw Gateway", ocOk, ocLine,
    ocOk && d.openclaw.uptime!=null ? "↑ "+fmtUptime(d.openclaw.uptime) : null);

  /* Telegram */
  const tgOk = d.telegram.ok;
  const tgLine = tgOk===null ? "Not configured" :
                 tgOk ? "Frank connected · "+d.telegram.pending+" pending" :
                 d.telegram.status==="no_webhook" ? "No webhook set" :
                 (d.telegram.lastError||d.telegram.reason||"Disconnected");
  const tgCard = card("💬","Telegram — Frank", tgOk, tgLine, null);

  /* Twilio */
  const twOk = d.twilio.ok===false && d.twilio.status==="low_balance" ? "warn" : d.twilio.ok;
  const twLine = d.twilio.ok===null ? "Error" :
                 d.twilio.status==="low_balance" ? "⚠ Low balance" :
                 d.twilio.status==="ok" ? "Account active · "+(d.twilio.numbers||[]).length+" number(s)" :
                 (d.twilio.reason||"Error");
  const twMetric = d.twilio.amount ? "$"+d.twilio.amount+" "+String(d.twilio.currency||"usd").toUpperCase() : null;
  const twCard = card("📞","Twilio", twOk, twLine, twMetric);

  /* Website */
  const wsOk = d.website.ok;
  const wsLine = wsOk===null ? "—" :
                 wsOk ? "getgravitylead.com live · "+d.website.ms+"ms" :
                 (d.website.reason||"HTTP "+d.website.httpStatus);
  const wsCard = card("🌐","Website / Cloudflare", wsOk, wsLine, null);

  /* GitHub */
  const ghOk = d.github.ok;
  const ghLine = ghOk===null ? "GITHUB_REPO not set" :
                 ghOk ? (d.github.commit?.message?.slice(0,40)||"No commits") :
                 (d.github.reason||"API error");
  const ghMetric = ghOk && d.github.commit ? timeAgo(d.github.commit.date) : null;
  const ghCard = card("🔗","GitHub", ghOk, ghLine, ghMetric);

  /* Formspree */
  const fpOk = d.formspree.ok;
  const fpLine = fpOk===null ? "FORMSPREE_ENDPOINT not set" :
                 fpOk ? "Lead form reachable · HTTP "+d.formspree.httpStatus :
                 (d.formspree.reason||"HTTP "+d.formspree.httpStatus);
  const fpCard = card("📋","Formspree", fpOk, fpLine, null);

  /* Stripe */
  const stOk = d.stripe.ok;
  const stLine = stOk===null ? "STRIPE_SECRET_KEY not set" :
                 stOk ? "Account active · "+(d.stripe.livemode?"Live":"Test")+" mode" :
                 (d.stripe.reason||"API error");
  const stMetric = stOk ? fmtUSD(d.stripe.available)+" available" : null;
  const stCard = card("💳","Stripe", stOk, stLine, stMetric);

  /* UptimeRobot */
  const urOk = d.uptimerobot.ok;
  const urMonitors = d.uptimerobot.monitors||[];
  const urDown = urMonitors.filter(m=>m.status==="down"||m.status==="degraded").length;
  const urLine = urOk===null ? "UPTIMEROBOT_API_KEY not set" :
                 urDown>0 ? urDown+" monitor(s) down" :
                 urMonitors.length+" monitor(s) up" ;
  const urCard = card("📡","UptimeRobot", urOk, urLine, null);

  /* Anthropic */
  const anOk = d.anthropic.ok;
  const anLine = anOk===null ? "ANTHROPIC_API_KEY not set" :
                 anOk ? "API key active" :
                 d.anthropic.status==="invalid_key" ? "Invalid API key" :
                 (d.anthropic.reason||"API error");
  const anCard = card("🧠","Anthropic API", anOk, anLine, null);

  $("cards").innerHTML = [renderCard,ocCard,tgCard,twCard,wsCard,ghCard,fpCard,stCard,urCard,anCard].join("");
}

/* ── Twilio numbers ─────────────────────────────────────────── */
function renderTwilioNumbers(tw){
  const nums = tw?.numbers||[];
  if(!tw||tw.ok===false){
    $("twilio-numbers").innerHTML=\`<div class="panel-empty">\${esc(tw?.reason||"Unavailable")}</div>\`;
    return;
  }
  if(!nums.length){
    $("twilio-numbers").innerHTML='<div class="panel-empty">No numbers found</div>';
    return;
  }
  $("twilio-numbers").innerHTML=\`<table class="tbl">
    <thead><tr><th>Number</th><th>Friendly Name</th><th>📞</th><th>💬</th></tr></thead>
    <tbody>\${nums.map(n=>\`<tr>
      <td style="font-family:monospace;color:var(--acc)">\${esc(fmtPhone(n.number))}</td>
      <td style="color:var(--muted)">\${esc(n.friendlyName||n.number)}</td>
      <td style="text-align:center">\${n.voice?"✅":"—"}</td>
      <td style="text-align:center">\${n.sms?"✅":"—"}</td>
    </tr>\`).join("")}</tbody>
  </table>\`;
}

/* ── UptimeRobot monitors ───────────────────────────────────── */
function renderUptimeMonitors(ur){
  const mons = ur?.monitors||[];
  if(!ur||ur.ok===false){
    $("uptime-monitors").innerHTML=\`<div class="panel-empty">\${esc(ur?.reason||"Unavailable")}</div>\`;
    return;
  }
  if(!mons.length){
    $("uptime-monitors").innerHTML='<div class="panel-empty">No monitors found</div>';
    return;
  }
  const MS_CLASS = {up:"ms-up",degraded:"ms-degraded",down:"ms-down",paused:"ms-paused",pending:"ms-pending"};
  $("uptime-monitors").innerHTML=\`<table class="tbl">
    <thead><tr><th>Monitor</th><th>Status</th><th>30d Uptime</th><th>Resp</th></tr></thead>
    <tbody>\${mons.map(m=>\`<tr>
      <td><div style="font-weight:600;font-size:13px">\${esc(m.name)}</div>
          <div style="font-size:11px;color:var(--dim)">\${esc(m.url||"")}</div></td>
      <td><span class="ms \${MS_CLASS[m.status]||"ms-pending"}">\${m.status.toUpperCase()}</span></td>
      <td style="color:var(--muted)">\${m.uptime!=null?m.uptime+"%":"—"}</td>
      <td style="color:var(--dim)">\${m.responseTime!=null?m.responseTime+"ms":"—"}</td>
    </tr>\`).join("")}</tbody>
  </table>\`;
}

/* ── Stripe charges ─────────────────────────────────────────── */
function renderStripeCharges(st){
  const charges = st?.charges||[];
  if(!st||st.ok===false){
    $("stripe-charges").innerHTML=\`<div class="panel-empty">\${esc(st?.reason||"Unavailable")}</div>\`;
    return;
  }
  if(!charges.length){
    $("stripe-charges").innerHTML='<div class="panel-empty">No recent charges</div>';
    return;
  }
  $("stripe-charges").innerHTML=\`<table class="tbl">
    <thead><tr><th>Amount</th><th>Status</th><th>Description</th><th>Date</th></tr></thead>
    <tbody>\${charges.map(c=>{
      const badgeCls = c.refunded ? "chg-ref" : c.status==="succeeded" ? "chg-ok" : "chg-fail";
      const badgeText = c.refunded ? "REFUNDED" : c.status.toUpperCase();
      return \`<tr>
        <td style="font-weight:700;color:var(--acc)">\${fmtUSD(c.amount)}</td>
        <td><span class="\${badgeCls}">\${badgeText}</span></td>
        <td style="color:var(--muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${esc(c.description||"—")}</td>
        <td style="color:var(--dim)">\${fmtDate(c.created)}</td>
      </tr>\`;
    }).join("")}</tbody>
  </table>\`;
}

/* ── GitHub ─────────────────────────────────────────────────── */
function renderGitHub(gh){
  if(!gh){
    $("github-commit").innerHTML='<div class="panel-empty">Unavailable</div>';
    return;
  }
  if(gh.ok===null){
    $("github-commit").innerHTML='<div class="panel-empty">Set GITHUB_REPO in .env to enable</div>';
    return;
  }
  if(!gh.ok){
    $("github-commit").innerHTML=\`<div class="panel-empty">\${esc(gh.reason||"GitHub API error")}</div>\`;
    return;
  }
  if(gh.repo) $("github-head").textContent="🔗 GitHub — "+gh.repo;
  const c = gh.commit;
  if(!c){ $("github-commit").innerHTML='<div class="panel-empty">No commits found</div>'; return; }
  $("github-commit").innerHTML=\`<div class="gh-commit">
    <div>
      \${c.url?\`<a class="gh-sha gh-link" href="\${esc(c.url)}" target="_blank" rel="noopener">\${esc(c.sha)}</a>\`
             :\`<span class="gh-sha">\${esc(c.sha)}</span>\`}
      <span style="color:var(--dim);font-size:12px">\${timeAgo(c.date)}</span>
    </div>
    <div class="gh-msg">\${esc(c.message)}</div>
    <div class="gh-meta">by \${esc(c.author)} · branch: \${esc(gh.defaultBranch||"main")}
      \${gh.pushedAt?" · pushed "+timeAgo(gh.pushedAt):""}</div>
  </div>\`;
}

/* ── Auto-refresh ───────────────────────────────────────────── */
function resetCd(){
  clearInterval(cdTimer);
  cd = REFRESH;
  cdTimer = setInterval(()=>{
    cd--;
    $("countdown").textContent="↻ "+cd+"s";
    if(cd<=0){ clearInterval(cdTimer); load(); }
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
