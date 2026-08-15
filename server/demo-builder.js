/* ============================================================================
 * GravityLead — On-demand Demo Builder
 *
 * Given a prospect's website URL, fetch the page, extract a few basics
 * (business name, phone, description, guessed trade), then generate a
 * personalized, self-contained demo landing page and save it under
 * public/demos/<slug>.html so it can be shared with a public link.
 *
 * Intentionally dependency-free: uses global fetch + regex extraction rather
 * than a headless browser, so it runs on Render's free tier with no extra
 * install. Extraction is best-effort; the demo still renders if a field is
 * missing.
 *
 * Usage:
 *   const demo = require("./demo-builder");
 *   demo.init({ baseUrl });
 *   const { link, businessName, trade } = await demo.build(url);
 * ========================================================================== */
"use strict";

const fs   = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "public", "demos");
let _baseUrl = "";

function init({ baseUrl } = {}) { _baseUrl = (baseUrl || "").replace(/\/$/, ""); }

/* ── Trade detection ───────────────────────────────────────────────────────── */
const TRADE_KEYWORDS = {
  hvac:        ["hvac", "heating", "cooling", "air condition", "furnace", "ac repair"],
  roofing:     ["roof", "shingle", "gutter"],
  plumbing:    ["plumb", "drain", "water heater", "sewer", "leak"],
  electrical:  ["electric", "wiring", "panel", "lighting install"],
  landscaping: ["landscap", "lawn", "snow removal", "tree", "hardscape"],
  painting:    ["paint", "drywall", "stain"],
  general:     ["remodel", "contractor", "handyman", "home improvement", "construction"],
};
const TRADE_META = {
  hvac:        { label: "HVAC",        emoji: "🌡️", primary: "#1f6feb", eyebrow: "Heating & Cooling Experts",  services: ["AC Repair & Install", "Furnace & Heating", "Air Quality", "Maintenance Plans"] },
  roofing:     { label: "Roofing",     emoji: "🏠", primary: "#b45309", eyebrow: "Roofing Done Right",         services: ["Roof Repair", "Full Replacement", "Storm Damage", "Free Inspections"] },
  plumbing:    { label: "Plumbing",    emoji: "🚰", primary: "#0891b2", eyebrow: "Trusted Local Plumbers",     services: ["Leak Repair", "Water Heaters", "Drain Cleaning", "Emergency Service"] },
  electrical:  { label: "Electrical",  emoji: "⚡", primary: "#ca8a04", eyebrow: "Licensed Electricians",      services: ["Panel Upgrades", "Wiring & Repair", "Lighting", "EV Chargers"] },
  landscaping: { label: "Landscaping", emoji: "🌿", primary: "#16a34a", eyebrow: "Lawn & Landscape Pros",      services: ["Lawn Care", "Landscape Design", "Snow Removal", "Cleanups"] },
  painting:    { label: "Painting",    emoji: "🎨", primary: "#7c3aed", eyebrow: "Interior & Exterior Painting",services: ["Interior Painting", "Exterior Painting", "Cabinets", "Drywall Repair"] },
  general:     { label: "Home Services",emoji: "🔨", primary: "#7c3aed", eyebrow: "Your Local Home Pros",       services: ["Repairs", "Remodeling", "Installs", "Maintenance"] },
};

function guessTrade(text) {
  const t = text.toLowerCase();
  let best = "general", bestHits = 0;
  for (const [trade, kws] of Object.entries(TRADE_KEYWORDS)) {
    const hits = kws.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
    if (hits > bestHits) { best = trade; bestHits = hits; }
  }
  return best;
}

/* ── HTML fetch + extraction ───────────────────────────────────────────────── */
async function fetchPage(url) {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(target, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GravityLeadDemoBot/1.0)" },
    });
    if (!r.ok) throw new Error(`Site returned HTTP ${r.status}`);
    const html = await r.text();
    return { html, finalUrl: r.url || target };
  } finally { clearTimeout(tid); }
}

function extract(html, url) {
  const pick = re => { const m = html.match(re); return m ? m[1].trim() : ""; };
  const strip = s => s.replace(/\s+/g, " ").trim();

  const ogTitle = pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
               || pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const title   = pick(/<title[^>]*>([^<]+)<\/title>/i);
  const h1      = strip(pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, ""));
  const desc    = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
               || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);

  // Business name: prefer OG site name, else clean the <title> (drop taglines after | - –)
  let businessName = ogTitle || title.split(/[|\-–—•·]/)[0].trim() || h1;
  if (!businessName) {
    try { businessName = new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ""); }
    catch { businessName = "Your Business"; }
  }
  businessName = strip(businessName).slice(0, 60);

  // Phone: first US-style phone in the page text.
  const phoneMatch = html.replace(/<[^>]+>/g, " ")
    .match(/(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
  const phone = phoneMatch ? phoneMatch[0].trim() : "";

  const text = `${businessName} ${title} ${h1} ${desc}`;
  const trade = guessTrade(text);

  return {
    businessName,
    phone,
    description: strip(desc).slice(0, 180),
    trade,
  };
}

/* ── Slug + persistence ────────────────────────────────────────────────────── */
function slugify(name) {
  return (name || "demo").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    || "demo";
}

/* ── Demo HTML template (self-contained, no external deps) ─────────────────── */
function renderDemo(data) {
  const meta = TRADE_META[data.trade] || TRADE_META.general;
  const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const name  = esc(data.businessName);
  const phone = esc(data.phone || "(555) 000-0000");
  const desc  = esc(data.description || `Fast, reliable ${meta.label.toLowerCase()} service — book online in seconds.`);
  const services = meta.services.map(s =>
    `<div class="card"><div class="card-t">${esc(s)}</div><div class="card-d">Book in seconds with our AI assistant.</div></div>`).join("");
  const home = _baseUrl || "https://getgravitylead.com";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} — Live Demo</title>
<meta name="description" content="Live GravityLead AI website demo for ${name}.">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--p:${meta.primary};--bg:#0e1621;--surf:#16202e;--text:#e8eef6;--muted:#9fb0c3}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
a{color:inherit;text-decoration:none}
.demo-banner{background:linear-gradient(90deg,#ef4444,#b91c1c);color:#fff;font-size:13px;font-weight:600;text-align:center;padding:9px 14px}
.demo-banner a{text-decoration:underline}
.container{max-width:1000px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid rgba(255,255,255,.08);padding:16px 0}
.nav{display:flex;align-items:center;justify-content:space-between}
.logo{font-weight:800;font-size:18px;display:flex;align-items:center;gap:9px}
.logo .dot{width:10px;height:10px;border-radius:50%;background:var(--p);box-shadow:0 0 0 4px ${meta.primary}22}
.nav-phone{font-weight:700;margin-right:16px}
.nav-cta{background:var(--p);color:#fff;padding:9px 16px;border-radius:8px;font-weight:700;font-size:14px}
.hero{padding:56px 0 40px}
.eyebrow{color:var(--p);font-weight:700;text-transform:uppercase;letter-spacing:.6px;font-size:12px;margin-bottom:12px}
h1{font-size:34px;font-weight:800;line-height:1.15;margin-bottom:14px}
.sub{color:var(--muted);font-size:17px;max-width:620px;margin-bottom:24px}
.btn-row{display:flex;gap:12px;flex-wrap:wrap}
.btn{padding:13px 22px;border-radius:9px;font-weight:700;font-size:15px;border:none;cursor:pointer}
.btn-primary{background:var(--p);color:#fff}
.btn-ghost{background:transparent;color:var(--text);border:1.5px solid rgba(255,255,255,.2)}
.hero-emoji{font-size:80px;text-align:center;margin-top:24px}
section{padding:40px 0}
.section-title{font-size:24px;font-weight:800;margin-bottom:6px}
.section-sub{color:var(--muted);margin-bottom:22px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}
.card{background:var(--surf);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:20px}
.card-t{font-weight:700;margin-bottom:6px}
.card-d{color:var(--muted);font-size:14px}
.gl{background:var(--surf);border:1px solid var(--p);border-radius:16px;padding:32px;text-align:center;margin:20px 0 40px}
.gl h2{font-size:22px;margin-bottom:10px}
.gl p{color:var(--muted);max-width:520px;margin:0 auto 18px}
.gl .btn-primary{display:inline-block}
footer{border-top:1px solid rgba(255,255,255,.08);padding:24px 0;color:var(--muted);font-size:14px;text-align:center}
.launcher{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;background:var(--p);border:none;color:#fff;font-size:26px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.4)}
@media(max-width:600px){h1{font-size:26px}.hero{padding:36px 0 28px}}
</style>
</head>
<body>
<div class="demo-banner">🔴 LIVE DEMO — sample AI website for ${name}. <a href="${esc(home)}">Get yours at GravityLead →</a></div>
<header><div class="container nav">
  <div class="logo"><span class="dot"></span>${name}</div>
  <div><a class="nav-phone" href="tel:${phone.replace(/[^0-9+]/g,"")}">${phone}</a><a class="nav-cta" href="#">Book Now</a></div>
</div></header>
<main class="container">
  <section class="hero">
    <div class="eyebrow">${esc(meta.eyebrow)}</div>
    <h1>${name} — now with a 24/7 AI receptionist.</h1>
    <p class="sub">${desc}</p>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="alert('This is a demo — the AI chat captures leads 24/7 on the real site.')">Book a Service</button>
      <button class="btn btn-ghost" onclick="alert('Demo mode. Get the real thing at GravityLead.')">Get a Free Estimate</button>
    </div>
    <div class="hero-emoji">${meta.emoji}</div>
  </section>
  <section>
    <div class="section-title">Our Services</div>
    <div class="section-sub">Everything handled by licensed pros — book any of these in seconds.</div>
    <div class="cards">${services}</div>
  </section>
  <section><div class="gl">
    <h2>👆 That's a GravityLead AI website.</h2>
    <p>Your customers get a pro site with an AI receptionist that captures leads 24/7 — even when you're on a job. Missed-call text-back in under 5 seconds, leads texted straight to your phone.</p>
    <a class="btn btn-primary" href="${esc(home)}">Get Mine →</a>
  </div></section>
</main>
<footer><div class="container"><strong>${name}</strong> · Powered by <a href="${esc(home)}">GravityLead</a></div></footer>
<button class="launcher" onclick="alert('👋 Hi! On the real site, I''m an AI assistant that answers questions and books jobs 24/7.')">💬</button>
</body>
</html>`;
}

/* ── Public: build a demo ──────────────────────────────────────────────────── */
async function build(url) {
  const { html, finalUrl } = await fetchPage(url);
  const data = extract(html, finalUrl);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const slug = `${slugify(data.businessName)}-${Date.now().toString(36)}`;
  const file = path.join(OUT_DIR, `${slug}.html`);
  fs.writeFileSync(file, renderDemo(data), "utf8");

  const link = `${_baseUrl || ""}/demos/${slug}.html`;
  return { link, slug, businessName: data.businessName, trade: (TRADE_META[data.trade] || {}).label || data.trade, phone: data.phone };
}

module.exports = { init, build, extract, guessTrade, renderDemo, _OUT_DIR: OUT_DIR };
