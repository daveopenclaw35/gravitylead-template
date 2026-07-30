/* ============================================================================
 * GravityLead reference template — app.js
 * Renders the active trade skin + runs the demo-mode AI chat widget.
 * Zero dependencies, zero build step.
 * ========================================================================== */

(function () {
  "use strict";

  /* -- DEMO_MODE: true = scripted local chat (no API, no keys, safe to hand
     to a salesperson). false = would POST to a real backend (see sendToBackend). */
  const DEMO_MODE = true;

  const S = window.GRAVITYLEAD;
  if (!S) { console.error("GravityLead config not loaded"); return; }

  /* ---------- 1. Apply theme (CSS variables) ---------- */
  const root = document.documentElement.style;
  const t = S.theme;
  root.setProperty("--primary", t.primary);
  root.setProperty("--primary-dark", t.primaryDark);
  root.setProperty("--accent", t.accent);
  root.setProperty("--bg", t.bg);
  root.setProperty("--surface", t.surface);
  root.setProperty("--text", t.text);
  root.setProperty("--muted", t.muted);

  /* ---------- 2. Populate content from skin ---------- */
  const $ = (id) => document.getElementById(id);
  const b = S.business, h = S.hero;

  document.title = `${b.name} — ${S.brand.name} Demo`;
  $("bizName").textContent = b.name;
  $("navPhone").textContent = b.phone;
  $("navPhone").href = "tel:" + b.phone.replace(/[^0-9+]/g, "");
  $("navCta").textContent = h.cta;

  $("heroEyebrow").textContent = h.eyebrow;
  $("heroHead").textContent = h.headline;
  $("heroSub").textContent = h.sub;
  $("heroCta").textContent = h.cta;
  $("heroCta2").textContent = h.cta2;
  $("heroEmoji").textContent = h.image;

  // Trust strip
  $("trustStrip").innerHTML = S.trust.map((x) => `<span>${x}</span>`).join("");

  // Services
  $("serviceCards").innerHTML = S.services.map((s) => `
    <div class="card">
      <div class="icon">${s.icon}</div>
      <h3>${s.title}</h3>
      <p>${s.desc}</p>
    </div>`).join("");

  // FAQ
  $("faqList").innerHTML = S.faqs.map((f) => `
    <details>
      <summary>${f.q}</summary>
      <p>${f.a}</p>
    </details>`).join("");

  // Footer
  $("footBiz").textContent = b.name;
  $("footMeta").textContent = `${b.city} · ${b.phone} · ${b.license}`;
  $("footHours").textContent = b.hours;
  $("poweredBy").textContent = S.brand.poweredBy;

  // Chat header
  $("chatBizName").textContent = b.name + " Assistant";
  if (!DEMO_MODE) $("chatDemoTag").style.display = "none";
  if (!DEMO_MODE) $("demoBanner").style.display = "none";

  /* ---------- 3. Chat widget ---------- */
  const win = $("chatWindow");
  const body = $("chatBody");
  const quick = $("chatQuick");
  const input = $("chatText");

  let convo = { stage: 0, data: {} }; // demo qualification flow state
  const c = S.chat;

  function openChat() {
    if (win.classList.contains("open")) return;
    win.classList.add("open");
    if (body.childElementCount === 0) startConversation();
    input.focus();
  }
  function toggleChat() {
    win.classList.toggle("open");
    if (win.classList.contains("open") && body.childElementCount === 0) startConversation();
  }

  $("chatLauncher").addEventListener("click", toggleChat);
  document.querySelectorAll("[data-open-chat]").forEach((el) =>
    el.addEventListener("click", openChat));

  function addMsg(text, who) {
    const el = document.createElement("div");
    el.className = "msg " + who;
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  function showTyping() {
    const el = document.createElement("div");
    el.className = "typing";
    el.id = "typing";
    el.innerHTML = "<span></span><span></span><span></span>";
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }
  function hideTyping() { const el = $("typing"); if (el) el.remove(); }

  function botSay(text, delay = 750) {
    showTyping();
    return new Promise((res) => setTimeout(() => {
      hideTyping();
      addMsg(text, "bot");
      res();
    }, delay));
  }

  function renderQuick(options) {
    quick.innerHTML = "";
    (options || []).forEach((label) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.addEventListener("click", () => handleUser(label));
      quick.appendChild(btn);
    });
  }

  async function startConversation() {
    await botSay(c.greeting, 400);
    renderQuick(c.quickReplies);
  }

  /* Demo qualification flow:
     greeting -> intent -> qualifier questions -> capture confirmation.
     In production, DEMO_MODE=false routes messages to a real GravityLead
     agent backend that qualifies, books, and texts the owner. */
  async function handleUser(text) {
    if (!text || !text.trim()) return;
    addMsg(text, "user");
    quick.innerHTML = "";
    input.value = "";

    if (DEMO_MODE) {
      await runDemoFlow(text.trim());
    } else {
      await sendToBackend(text.trim());
    }
  }

  async function runDemoFlow(text) {
    const q = c.qualifiers;
    if (convo.stage === 0) {
      convo.data.intent = text;
      await botSay(`Got it — "${text}". ${q[0]}`);
      convo.stage = 1;
    } else if (convo.stage === 1) {
      convo.data.zip = text;
      await botSay(q[1]);
      convo.stage = 2;
    } else if (convo.stage === 2) {
      convo.data.urgency = text;
      await botSay(q[2]);
      convo.stage = 3;
    } else if (convo.stage === 3) {
      convo.data.phone = text;
      await botSay(c.capture, 900);
      console.log("[GravityLead DEMO] Captured lead:", convo.data);
      convo.stage = 4;
      renderQuick(["Start over"]);
    } else {
      convo = { stage: 0, data: {} };
      body.innerHTML = "";
      startConversation();
    }
  }

  /* Production hook — not called in demo mode. */
  async function sendToBackend(text) {
    showTyping();
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trade: S.tradeKey, business: S.business.name, message: text, history: convo }),
      });
      const j = await r.json();
      hideTyping();
      addMsg(j.reply || "Thanks! Someone will reach out shortly.", "bot");
    } catch (e) {
      hideTyping();
      addMsg("Sorry — connection issue. Please call " + S.business.phone + ".", "bot");
    }
  }

  $("chatSend").addEventListener("click", () => handleUser(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") handleUser(input.value); });

  /* ---------- 4. GravityLead lead-capture form ---------- */
  /* Set FORM_ENDPOINT to a real URL (Formspree, Cloudflare Worker, etc.) to
     POST captured leads. When empty, leads log to console only. */
  const FORM_ENDPOINT = "https://formspree.io/f/xdaqyezr";
  /* Optional: GravityLead server endpoint for lead tracking + SMS follow-ups.
     Set to your server URL (e.g., "https://your-server.com/api/lead") to enroll
     form leads in the 3/7/30-day follow-up sequence. */
  const LEAD_SERVER_ENDPOINT = "";  // e.g., "https://your-server.com/api/lead"

  const glForm = document.getElementById("glLeadForm");
  const glSuccess = document.getElementById("glFormSuccess");
  if (glForm) {
    glForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      const data = {
        name: document.getElementById("glName").value.trim(),
        business: document.getElementById("glBiz").value.trim(),
        trade: document.getElementById("glTrade").value,
        phone: document.getElementById("glPhone").value.trim(),
        submitted: new Date().toISOString(),
        source: window.location.href,
      };
      if (FORM_ENDPOINT) {
        try {
          await fetch(FORM_ENDPOINT, {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
        } catch (err) {
          console.warn("[GravityLead] Form POST failed, lead captured locally:", err);
        }
      }
      /* Enroll in SMS follow-up sequence via GravityLead server */
      if (LEAD_SERVER_ENDPOINT) {
        try {
          await fetch(LEAD_SERVER_ENDPOINT, {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({
              phone: data.phone,
              name: data.name,
              business: data.business,
              trade: data.trade,
              twilio_number: S.business.twilio || "",
              source: "form",
            }),
          });
        } catch (err) {
          console.warn("[GravityLead] Lead server POST failed:", err);
        }
      }
      console.log("[GravityLead] Lead captured:", data);
      glForm.style.display = "none";
      glSuccess.classList.add("show");
      glSuccess.style.display = "block";
    });
  }

  /* ---------- 5. Google Analytics 4 --------------------------------------- */
  (function () {
    // ANALYTICS_ID is defined in config.js — set it to the client's GA4 ID.
    // Skips silently when placeholder value is used (safe for demos / local dev).
    var id = (typeof ANALYTICS_ID !== "undefined") ? ANALYTICS_ID : "";
    if (!id || id === "G-XXXXXXXXXX") return;
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag("js", new Date());
    gtag("config", id, { send_page_view: true });
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + id;
    document.head.appendChild(s);
    console.log("[GravityLead] GA4 initialized:", id);
  })();

})();
