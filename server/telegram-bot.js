/* ============================================================================
 * GravityLead — Telegram Control Bot
 *
 * A single long-polling Telegram bot that lets the owner monitor and control
 * GravityLead from their phone. No webhook / no inbound port required — works
 * on Render's free tier out of the box.
 *
 * Commands:
 *   /status            All system health in one message
 *   /clients           List active clients with month-to-date stats
 *   /leads             Last 10 leads captured
 *   /revenue           Current MRR + ARR + totals
 *   /report            Quick business summary
 *   /newdemo [url]     Build a custom demo from a website URL, return the link
 *   /prospects         Top 10 prospects to contact today
 *   /frank             Frank's current status + today's schedule
 *   /help              Command list
 *
 * Setup (.env):
 *   TELEGRAM_BOT_TOKEN   Bot token from @BotFather (required to enable the bot)
 *   TELEGRAM_OWNER_ID    Your numeric Telegram user/chat id (required — the bot
 *                        only responds to this id; all others are ignored)
 *   BASE_URL             Public base URL (used to build demo links)
 *
 * Usage (index.js):
 *   const bot = require("./telegram-bot");
 *   bot.init({ twilio: twilioClient, clients, baseUrl: BASE_URL, ops });
 *   bot.start();
 * ========================================================================== */
"use strict";

const fs   = require("fs");
const path = require("path");
const db   = require("./db");
const demo = require("./demo-builder");

/* ── Config / state ────────────────────────────────────────────────────────── */
const TOKEN    = process.env.TELEGRAM_BOT_TOKEN || "";
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || "").trim();
const API      = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let _clients = {};
let _baseUrl = "";
let _ops     = null;              // ops-dashboard module (for gatherAll)
let _offset  = 0;                 // getUpdates cursor
let _running = false;
const START  = Date.now();

function init({ twilio, clients, baseUrl, ops } = {}) {
  _clients = clients || {};
  _baseUrl = (baseUrl || "").replace(/\/$/, "");
  _ops     = ops || null;
  demo.init({ baseUrl: _baseUrl });
}

/* ── Telegram API helpers ──────────────────────────────────────────────────── */
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  return r.json();
}

async function send(chatId, text, extra = {}) {
  // Telegram hard limit is 4096 chars; trim defensively.
  const clipped = text.length > 4000 ? text.slice(0, 3990) + "\n…(truncated)" : text;
  return tg("sendMessage", {
    chat_id: chatId,
    text:    clipped,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

/* ── Formatting helpers (mobile-friendly, HTML parse mode) ─────────────────── */
const esc  = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const b    = s => `<b>${esc(s)}</b>`;
const code = s => `<code>${esc(s)}</code>`;
const usd  = n => "$" + Number(n || 0).toLocaleString("en-US");

function dot(ok) {
  if (ok === true)  return "🟢";
  if (ok === false) return "🔴";
  return "⚪";                     // null / unconfigured
}

function fmtPhone(e164) {
  if (!e164) return "—";
  const d = String(e164).replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10)                 return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return e164;
}

function timeAgo(sql) {
  if (!sql) return "—";
  const iso = String(sql).replace(" ", "T") + (String(sql).includes("T") ? "" : "Z");
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (isNaN(s)) return "—";
  if (s < 60)  return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function upFmt(sec) {
  sec = Math.round(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/* ── Data helpers ──────────────────────────────────────────────────────────── */
function clientList() {
  const d = new Date(), y = d.getFullYear(), mo = d.getMonth() + 1;
  return Object.entries(_clients).map(([key, c]) => ({
    key,
    name:  c.business_name,
    owner: c.owner_name  ?? null,
    phone: c.owner_phone,
    trade: c.trade,
    fee:   c.monthly_fee ?? 149,
    stats: db.getMonthlyStats(key, y, mo),
  }));
}

function loadProspects() {
  const dir = path.join(__dirname, "..", "..", "outreach-research");
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (Array.isArray(arr)) out.push(...arr);
      } catch { /* skip bad file */ }
    }
  } catch { /* dir missing on server — that's fine */ }
  return out;
}

// Rank prospects: weakest web presence first (best conversion targets).
const WEB_RANK = { none: 0, "facebook-only": 1, weak: 2, outdated: 2, ok: 4, strong: 5 };
function rankProspects(list) {
  return [...list].sort((a, b) =>
    (WEB_RANK[a.website_status] ?? 3) - (WEB_RANK[b.website_status] ?? 3));
}

/* ══════════════════════════════════════════════════════════════════════════════
 * COMMAND HANDLERS  — each returns a mobile-friendly HTML string
 * ══════════════════════════════════════════════════════════════════════════════ */

async function cmdStatus() {
  if (!_ops) return "⚠️ Ops module not wired.";
  const s = await _ops.gatherAll();
  const rows = [
    ["Render",     s.render],
    ["Website",    s.website],
    ["Twilio",     s.twilio],
    ["Telegram",   s.telegram],
    ["OpenClaw",   s.openclaw],
    ["GitHub",     s.github],
    ["Stripe",     s.stripe],
    ["Formspree",  s.formspree],
    ["UptimeRobot",s.uptimerobot],
    ["Anthropic",  s.anthropic],
  ];
  const active = rows.filter(([, v]) => v && v.ok !== null);
  const red    = active.filter(([, v]) => v.ok === false).length;
  const header = red === 0
    ? "🟢 <b>All systems operational</b>"
    : `🔴 <b>${red} system${red > 1 ? "s" : ""} need${red > 1 ? "" : "s"} attention</b>`;

  const lines = rows.map(([label, v]) => {
    if (!v) return `⚪ ${label}`;
    let detail = "";
    if (label === "Twilio" && v.ok)    detail = ` · $${v.amount} ${v.currency || ""}`.trimEnd();
    else if (label === "Twilio")        detail = v.status === "low_balance" ? " · low balance" : (v.reason ? ` · ${v.reason}` : "");
    else if (label === "Website" && v.ms) detail = ` · ${v.ms}ms`;
    else if (v.status && v.ok === null) detail = " · not set up";
    else if (v.ok === false && v.reason) detail = ` · ${v.reason}`;
    return `${dot(v.ok)} ${label}${esc(detail)}`;
  });

  return `${header}\n\n${lines.join("\n")}\n\n<i>Uptime ${upFmt((Date.now()-START)/1000)}</i>`;
}

function cmdClients() {
  const list = clientList();
  if (!list.length) return `${b("Clients")}\n\nNo active clients yet. When you onboard one, they'll appear here.`;
  const parts = list.map(c => {
    const s = c.stats;
    return `${b(c.name)} · ${esc(c.trade)}\n` +
      `📱 ${fmtPhone(c.key)} · ${usd(c.fee)}/mo\n` +
      `💬 ${s.chat_leads} leads · 📞 ${s.missed_calls} missed · 📤 ${s.followups_sent} f/u · ⭐ ${s.reviews_sent}`;
  });
  return `${b(`Clients (${list.length})`)}\n\n${parts.join("\n\n")}`;
}

function cmdLeads() {
  const leads = db.getRecentLeads(10);
  if (!leads.length) return `${b("Recent Leads")}\n\nNo leads captured yet.`;
  const srcIcon = { missed_call: "📞", chat: "💬", form: "📋" };
  const rows = leads.map(l =>
    `${srcIcon[l.source] || "•"} ${fmtPhone(l.phone)} — ${esc(l.name || "Unknown")}\n` +
    `   <i>${esc(l.business_key || "")} · ${timeAgo(l.created_at)}</i>`);
  return `${b("Last 10 Leads")}\n\n${rows.join("\n")}`;
}

function cmdRevenue() {
  const list = clientList();
  const mrr  = list.reduce((s, c) => s + c.fee, 0);
  const arr  = mrr * 12;
  const avg  = list.length ? Math.round(mrr / list.length) : 0;
  const t = list.reduce((a, c) => ({
    chat: a.chat + c.stats.chat_leads,
    miss: a.miss + c.stats.missed_calls,
    fu:   a.fu   + c.stats.followups_sent,
    rev:  a.rev  + c.stats.reviews_sent,
  }), { chat: 0, miss: 0, fu: 0, rev: 0 });
  return `${b("💰 Revenue")}\n\n` +
    `MRR: ${b(usd(mrr))}/mo\n` +
    `ARR: ${usd(arr)}\n` +
    `Clients: ${list.length} · Avg ${usd(avg)}/client\n\n` +
    `${b("This month")}\n` +
    `💬 ${t.chat} leads · 📞 ${t.miss} missed calls\n` +
    `📤 ${t.fu} follow-ups · ⭐ ${t.rev} reviews`;
}

function cmdReport() {
  const list = clientList();
  const mrr  = list.reduce((s, c) => s + c.fee, 0);
  const leads = db.getRecentLeads(50);
  const now = Date.now();
  const last7 = leads.filter(l => {
    const iso = String(l.created_at).replace(" ", "T") + "Z";
    return (now - new Date(iso)) < 7 * 864e5;
  }).length;
  const upcoming = db.getUpcomingFollowups(50).length;
  const mo = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
  return `${b("📊 GravityLead — Business Summary")}\n<i>${mo}</i>\n\n` +
    `${b(usd(mrr))}/mo MRR · ${list.length} client${list.length !== 1 ? "s" : ""}\n` +
    `${leads.length} total leads · ${last7} in last 7 days\n` +
    `${upcoming} follow-ups scheduled\n\n` +
    `Send /clients, /leads, /revenue for detail.`;
}

async function cmdNewDemo(arg, chatId) {
  const url = (arg || "").trim();
  if (!url) return `${b("Build a demo")}\n\nUsage: /newdemo <url>\nExample: ${code("/newdemo https://example-hvac.com")}`;
  await send(chatId, `🛠️ Building a demo from ${esc(url)} … this takes ~10-20s.`);
  try {
    const result = await demo.build(url);
    return `✅ ${b("Demo ready!")}\n\n` +
      `${b(result.businessName)}${result.trade ? " · " + esc(result.trade) : ""}\n` +
      `🔗 ${result.link}\n\n` +
      `<i>Send this to the prospect. It auto-expires from the demo list but the link stays live.</i>`;
  } catch (e) {
    return `🔴 Couldn't build the demo.\n<i>${esc(e.message)}</i>\n\nCheck the URL is reachable and includes https://`;
  }
}

function cmdProspects() {
  const ranked = rankProspects(loadProspects()).slice(0, 10);
  if (!ranked.length) return `${b("Prospects")}\n\nNo prospect list found on this server.`;
  const badge = { none: "🔴 no site", "facebook-only": "🟠 FB only", weak: "🟡 weak site", outdated: "🟡 outdated", ok: "🟢 has site", strong: "🟢 strong" };
  const rows = ranked.map((p, i) =>
    `${i + 1}. ${b(p.name)}\n` +
    `   ${esc(p.trade || "")} · ${badge[p.website_status] || esc(p.website_status || "")}\n` +
    `   📞 ${esc(p.phone || "—")}`);
  return `${b("🎯 Top 10 Prospects Today")}\n<i>Weakest web presence first = easiest sells</i>\n\n${rows.join("\n\n")}`;
}

function cmdFrank() {
  const now = new Date();
  const t = now.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return `${b("📊 Frank — Research Analyst")}\n\n` +
    `Status: 🟢 online\n` +
    `Time: ${esc(t)} ET\n\n` +
    `${b("Daily schedule")}\n` +
    `🌅 Morning — Market Intelligence Briefing\n` +
    `🌆 Afternoon — Opportunity Deep Dive\n\n` +
    `${b("Current focus")}\n` +
    `AI website template (GravityLead) — product-in-a-box for local businesses.\n\n` +
    `<i>Ping me anytime for research, reports, or to run a command.</i>`;
}

function cmdHelp() {
  return `${b("GravityLead Bot — Commands")}\n\n` +
    `/status — all system health\n` +
    `/clients — active clients + stats\n` +
    `/leads — last 10 leads\n` +
    `/revenue — MRR, ARR, totals\n` +
    `/report — quick business summary\n` +
    `/newdemo &lt;url&gt; — build a custom demo\n` +
    `/prospects — top 10 to contact today\n` +
    `/frank — Frank's status + schedule\n` +
    `/help — this list`;
}

/* ── Router ────────────────────────────────────────────────────────────────── */
async function handle(msg) {
  const chatId = msg.chat?.id;
  const from   = String(msg.from?.id ?? "");
  const text   = (msg.text || "").trim();
  if (!chatId || !text.startsWith("/")) return;

  // Authorization: only the configured owner id may use the bot.
  if (OWNER_ID && from !== OWNER_ID) {
    return send(chatId, "⛔ This bot is private.");
  }

  const [raw, ...rest] = text.split(/\s+/);
  const cmd = raw.replace(/@.*$/, "").toLowerCase(); // strip @botname in groups
  const arg = rest.join(" ");

  try {
    let reply;
    switch (cmd) {
      case "/start":
      case "/help":      reply = cmdHelp();               break;
      case "/status":    reply = await cmdStatus();       break;
      case "/clients":   reply = cmdClients();            break;
      case "/leads":     reply = cmdLeads();              break;
      case "/revenue":   reply = cmdRevenue();            break;
      case "/report":    reply = cmdReport();             break;
      case "/newdemo":   reply = await cmdNewDemo(arg, chatId); break;
      case "/prospects": reply = cmdProspects();          break;
      case "/frank":     reply = cmdFrank();              break;
      default:           reply = `Unknown command ${code(cmd)}. Send /help.`;
    }
    if (reply) await send(chatId, reply);
  } catch (e) {
    console.error("[bot] handler error:", e);
    await send(chatId, `🔴 Error running ${code(cmd)}: ${esc(e.message)}`);
  }
}

/* ── Long-poll loop ────────────────────────────────────────────────────────── */
async function registerCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "status",    description: "All system health" },
      { command: "clients",   description: "Active clients + stats" },
      { command: "leads",     description: "Last 10 leads" },
      { command: "revenue",   description: "MRR, ARR, totals" },
      { command: "report",    description: "Quick business summary" },
      { command: "newdemo",   description: "Build a demo from a URL" },
      { command: "prospects", description: "Top 10 prospects today" },
      { command: "frank",     description: "Frank's status + schedule" },
      { command: "help",      description: "Command list" },
    ],
  }).catch(() => {});
}

async function poll() {
  while (_running) {
    try {
      const r = await fetch(`${API}/getUpdates?timeout=50&offset=${_offset}`, { });
      const j = await r.json();
      if (j.ok && Array.isArray(j.result)) {
        for (const u of j.result) {
          _offset = u.update_id + 1;
          if (u.message) handle(u.message).catch(e => console.error("[bot]", e));
        }
      }
    } catch (e) {
      // Network blip / long-poll timeout — pause briefly and retry.
      await new Promise(res => setTimeout(res, 3000));
    }
  }
}

function start() {
  if (!TOKEN) {
    console.log("[bot] TELEGRAM_BOT_TOKEN not set — Telegram control bot disabled.");
    return;
  }
  if (!OWNER_ID) {
    console.warn("[bot] TELEGRAM_OWNER_ID not set — bot will refuse all messages until configured.");
  }
  _running = true;
  registerCommands();
  poll();
  console.log("[bot] Telegram control bot started (long-polling).");
}

function stop() { _running = false; }

module.exports = { init, start, stop, handle, _cmds: { cmdStatus, cmdClients, cmdLeads, cmdRevenue, cmdReport, cmdNewDemo, cmdProspects, cmdFrank, cmdHelp } };
