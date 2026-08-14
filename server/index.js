/* ============================================================================
 * GravityLead Server
 * Missed-call text-back + 3/7/30-day SMS follow-up sequences via Twilio.
 *
 * Endpoints:
 *   POST /twilio/voice          — incoming call webhook (TwiML: forward to owner)
 *   POST /twilio/voice/status   — dial status callback (triggers text-back on miss)
 *   POST /twilio/sms            — inbound SMS (STOP opt-out + reply logging)
 *   POST /api/lead              — website form/chat lead intake  [API key required]
 *   GET  /api/stats             — lead stats dashboard           [API key required]
 *   POST /api/job/complete      — mark job done; schedule review request [API key required]
 *   POST /api/review/send       — manually trigger a review request now  [API key required]
 *   GET  /api/review/stats      — review request statistics              [API key required]
 *   POST /api/report/send       — manually trigger monthly client report  [API key required]
 *   GET  /dashboard             — owner dashboard (password protected)
 *   GET  /health                — health check
 *
 * Setup:
 *   1. Copy .env.example → .env, fill in Twilio credentials + API_KEY.
 *   2. Edit clients.json — map each Twilio number to a business.
 *   3. npm install && npm start
 *   4. Point Twilio voice/SMS webhooks to BASE_URL/twilio/voice and /twilio/sms.
 *
 * Security model:
 *   • /twilio/* routes: Twilio request-signature validation (HMAC-SHA1).
 *     Set SKIP_TWILIO_VALIDATION=true only in local dev/testing.
 *   • /api/* routes: X-Api-Key header (or ?api_key= query param).
 *   • Rate limiting: 60 req/15 min general; 10 req/hr on /api/lead.
 *   • /api/lead validates twilio_number against known clients and normalises
 *     the caller's phone to E.164 before touching the DB.
 * ========================================================================== */

"use strict";

require("dotenv").config();

const express    = require("express");
const twilio     = require("twilio");
const rateLimit  = require("express-rate-limit");
const db         = require("./db");
const followup   = require("./followup");
const review     = require("./review");
const reports    = require("./reports");
const dashboard  = require("./dashboard");
const { renderTemplate } = require("./templates");

/* ── Config ──────────────────────────────────────────────────────────────── */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  API_KEY,
  PORT     = 3000,
  BASE_URL = `http://localhost:${PORT}`,
  FORMSPREE_ENDPOINT,
  NODE_ENV = "production",
  SKIP_TWILIO_VALIDATION = "false",
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error("[startup] FATAL: Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env");
  process.exit(1);
}
if (!API_KEY) {
  console.error("[startup] FATAL: API_KEY is not set in .env. All /api/* routes will be blocked.");
  process.exit(1);
}

const twilioClient   = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VoiceResponse  = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;

/* ── Load client config ──────────────────────────────────────────────────── */
let clients;
try {
  clients = require("./clients.json");
  delete clients._comment;
  delete clients._example;
} catch (err) {
  console.error("[startup] Could not load clients.json:", err.message);
  clients = {};
}
const clientNumbers = new Set(Object.keys(clients));
console.log(`[startup] Loaded ${clientNumbers.size} client(s) from clients.json`);

/* ── Init follow-up engine ───────────────────────────────────────────────── */
followup.init(twilioClient, clients);

/* ── Init review engine ──────────────────────────────────────────────────── */
review.init(twilioClient, clients);

/* ── Init monthly report engine ──────────────────────────────────────────── */
reports.init(twilioClient, clients);

/* ── Init owner dashboard ─────────────────────────────────────────────────── */
dashboard.init(twilioClient, clients, BASE_URL);

/* ══════════════════════════════════════════════════════════════════════════
 * SECURITY MIDDLEWARE
 * ══════════════════════════════════════════════════════════════════════════ */

/* ── 1. Twilio webhook signature validation ──────────────────────────────── */
function twilioAuth(req, res, next) {
  const skipValidation =
    NODE_ENV !== "production" && SKIP_TWILIO_VALIDATION === "true";

  if (skipValidation) {
    console.warn(
      "[security] SKIP_TWILIO_VALIDATION=true — bypassing Twilio auth (dev only, never in production)"
    );
    return next();
  }

  const signature = req.headers["x-twilio-signature"] || "";
  // Reconstruct the exact URL Twilio signed — strip trailing slash from BASE_URL
  const url = `${BASE_URL.replace(/\/$/, "")}${req.originalUrl}`;

  const valid = twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body   // must be the URL-encoded param object, not raw body
  );

  if (!valid) {
    console.warn(
      `[security] Twilio signature FAILED — ${req.method} ${req.originalUrl}` +
      ` | sig: "${signature.substring(0, 20)}..." | url: "${url}"`
    );
    // Return empty TwiML so Twilio doesn't retry with an error voice
    return res.status(403).type("text/xml").send("<Response></Response>");
  }

  next();
}

/* ── 2. API key middleware ───────────────────────────────────────────────── */
function requireApiKey(req, res, next) {
  const provided = req.headers["x-api-key"] || req.query.api_key;
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({
      error: "Unauthorized. Provide a valid X-Api-Key header.",
    });
  }
  next();
}

/* ── 3. Rate limiters ────────────────────────────────────────────────────── */
const generalLimiter = rateLimit({
  windowMs:       15 * 60 * 1000, // 15 minutes
  max:            60,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: "Too many requests. Please slow down and try again." },
});

// Tighter limit on lead intake to control Twilio spend
const leadLimiter = rateLimit({
  windowMs:       60 * 60 * 1000, // 1 hour
  max:            10,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: "Too many submissions. Please try again in an hour." },
});

/* ── 4. Phone normalisation ──────────────────────────────────────────────── */
function normalizePhone(raw) {
  if (!raw || typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10)                         return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1")    return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 10)   return `+${digits}`;
  return null; // unrecognised — caller must handle
}

/* ── 5b. Parse boolean-ish values from JSON body ─────────────────────────── */
function parseBool(val) {
  if (typeof val === "boolean") return val;
  if (typeof val === "string")  return val.toLowerCase() === "true";
  return false;
}

/* ── 5. twilio_number allow-list check ───────────────────────────────────── */
function validateTwilioNumber(twilioNumber) {
  return typeof twilioNumber === "string" && clientNumbers.has(twilioNumber);
}

/* ══════════════════════════════════════════════════════════════════════════
 * EXPRESS APP
 * ══════════════════════════════════════════════════════════════════════════ */
const app = express();

// Twilio sends form-encoded; our API sends JSON.
// Order matters: urlencoded first so Twilio body is parsed before sig check.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Apply general rate limit to all routes
app.use(generalLimiter);

/* ── Owner dashboard (mounted before API so it gets its own rate-limit context) */
app.use("/dashboard", dashboard.router);

/* ══════════════════════════════════════════════════════════════════════════
 * POST /twilio/voice — Incoming call webhook  [Twilio-signed]
 * Twilio calls this when someone dials a GravityLead number.
 * Returns TwiML that rings the business owner's phone.
 * ══════════════════════════════════════════════════════════════════════════ */
app.post("/twilio/voice", twilioAuth, (req, res) => {
  const { From, To, CallSid } = req.body;
  const client = clients[To];
  const twiml  = new VoiceResponse();

  if (!client) {
    console.warn(`[voice] No client config for Twilio number: ${To}`);
    twiml.say("Sorry, this number is not configured. Please try again later.");
    return res.type("text/xml").send(twiml.toString());
  }

  console.log(
    `[voice] Incoming call from ${From} → ${To} (${client.business_name}) | CallSid: ${CallSid}`
  );

  const dial = twiml.dial({
    action:   `${BASE_URL.replace(/\/$/, "")}/twilio/voice/status`,
    method:   "POST",
    timeout:  client.ring_timeout || 20,
    callerId: To,
  });
  dial.number(client.owner_phone);

  res.type("text/xml").send(twiml.toString());
});

/* ══════════════════════════════════════════════════════════════════════════
 * POST /twilio/voice/status — <Dial> action callback  [Twilio-signed]
 * Fires after the forwarded call ends.
 * Missed call → immediate text-back + enrol in follow-up sequence.
 * ══════════════════════════════════════════════════════════════════════════ */
app.post("/twilio/voice/status", twilioAuth, async (req, res) => {
  const { DialCallStatus, From, To, CallSid } = req.body;
  const twiml = new VoiceResponse();

  console.log(
    `[voice-status] CallSid: ${CallSid} | Status: ${DialCallStatus} | From: ${From} | To: ${To}`
  );

  if (DialCallStatus === "completed") {
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  const client = clients[To];
  if (!client) {
    console.warn(`[voice-status] No client for ${To}, skipping text-back`);
    twiml.say("Sorry we missed your call. Please try again later.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say(
    { voice: "Polly.Joanna" },
    "Sorry we missed your call. We'll text you right away at this number. Talk soon!"
  );
  twiml.hangup();

  // Deduplicate: skip if caller already has an active sequence within 30 days
  const existing = db.findRecentLead(From, To);
  if (existing) {
    console.log(
      `[voice-status] ${From} already enrolled (lead #${existing.id}) for ${client.business_name} — skipping`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  const leadId = db.createLead({
    phone:        From,
    business_key: To,
    twilio_number: To,
    source:       "missed_call",
    notes:        `Missed call (${DialCallStatus}). CallSid: ${CallSid}`,
  });

  db.scheduleFollowups(leadId);

  console.log(
    `[voice-status] Created lead #${leadId} for ${From} → ${client.business_name}. Scheduling text-back.`
  );

  try {
    const body = renderTemplate(0, {
      business_name:  client.business_name,
      owner_name:     client.owner_name,
      business_phone: client.owner_phone,
      trade:          client.trade,
    });

    const msg = await twilioClient.messages.create({ to: From, from: To, body });

    const dueNow = db.getDueFollowups().find(
      f => f.lead_id === Number(leadId) && f.day === 0
    );
    if (dueNow) db.markSent(dueNow.id, msg.sid);

    db.logSms({
      lead_id:      leadId,
      direction:    "outbound",
      from_number:  To,
      to_number:    From,
      body,
      message_sid:  msg.sid,
      status:       msg.status,
    });

    console.log(`[text-back] Sent to ${From}: "${body.substring(0, 60)}…" | SID: ${msg.sid}`);
  } catch (err) {
    console.error(`[text-back] Failed to send to ${From}:`, err.message);
  }

  res.type("text/xml").send(twiml.toString());
});

/* ══════════════════════════════════════════════════════════════════════════
 * POST /twilio/sms — Inbound SMS handler  [Twilio-signed]
 * Handles STOP/opt-out and logs all inbound messages.
 * ══════════════════════════════════════════════════════════════════════════ */
app.post("/twilio/sms", twilioAuth, (req, res) => {
  const { From, To, Body, MessageSid } = req.body;
  const twiml    = new MessagingResponse();
  const bodyLower = (Body || "").trim().toLowerCase();

  console.log(`[sms-in] From: ${From} To: ${To} Body: "${Body}"`);

  const lead = db.findLead(From, To);
  db.logSms({
    lead_id:      lead ? lead.id : null,
    direction:    "inbound",
    from_number:  From,
    to_number:    To,
    body:         Body,
    message_sid:  MessageSid,
    status:       "received",
  });

  // STOP / opt-out
  const stopWords = ["stop", "unsubscribe", "cancel", "quit", "end"];
  if (stopWords.includes(bodyLower)) {
    db.optOut(From);
    console.log(`[sms-in] Opted out: ${From}`);
    return res.type("text/xml").send(twiml.toString());
  }

  // YES — interested reply
  if (bodyLower === "yes" || bodyLower === "y") {
    const client = clients[To];
    if (client) {
      twilioClient.messages.create({
        to:   client.owner_phone,
        from: To,
        body: `🔔 GravityLead: ${From} replied YES to your follow-up. Call or text them back!\n\nLead: ${lead ? `#${lead.id} (${lead.source})` : "unknown"}`,
      }).catch(err => console.error("[sms-in] Failed to notify owner:", err.message));

      twiml.message("Thanks! Someone from our team will reach out to you shortly.");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // Any other reply — forward to owner
  const client = clients[To];
  if (client && Body && Body.trim()) {
    twilioClient.messages.create({
      to:   client.owner_phone,
      from: To,
      body: `💬 GravityLead: Reply from ${From}:\n"${Body}"\n\nReply to this number to respond.`,
    }).catch(err => console.error("[sms-in] Failed to forward reply:", err.message));
  }

  res.type("text/xml").send(twiml.toString());
});

/* ══════════════════════════════════════════════════════════════════════════
 * POST /api/lead — Website form / chat lead intake
 * [API key required] [Rate limited: 10/hr]
 * ══════════════════════════════════════════════════════════════════════════ */
app.post("/api/lead", requireApiKey, leadLimiter, async (req, res) => {
  const { phone, name, business, trade, twilio_number, source } = req.body;

  // Validate required fields
  if (!phone || !twilio_number) {
    return res.status(400).json({ error: "phone and twilio_number are required." });
  }

  // Validate twilio_number against known clients — reject unknown numbers
  if (!validateTwilioNumber(twilio_number)) {
    console.warn(`[api/lead] Rejected unknown twilio_number: "${twilio_number}"`);
    return res.status(400).json({
      error: "Invalid twilio_number. Must be a registered GravityLead number.",
    });
  }

  // Normalise caller phone to E.164
  const normalizedPhone = normalizePhone(String(phone));
  if (!normalizedPhone) {
    return res.status(400).json({
      error: "Invalid phone number. Provide a 10-digit US number or E.164 format.",
    });
  }

  // Deduplicate
  const existing = db.findRecentLead(normalizedPhone, twilio_number);
  if (existing) {
    return res.json({ status: "already_enrolled", lead_id: existing.id });
  }

  const leadId = db.createLead({
    phone:        normalizedPhone,
    name:         name  || null,
    business_key: twilio_number,
    twilio_number,
    source:       source || "form",
    notes:        `Business: ${business || ""}, Trade: ${trade || ""}`,
  });

  db.scheduleFollowups(leadId);

  // Formspree passthrough (best-effort)
  if (FORMSPREE_ENDPOINT) {
    try {
      await fetch(FORMSPREE_ENDPOINT, {
        method:  "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body:    JSON.stringify({ name, phone: normalizedPhone, business, trade, source: "website_form" }),
      });
    } catch (err) {
      console.warn("[api/lead] Formspree passthrough failed:", err.message);
    }
  }

  // Notify the business owner
  const client = clients[twilio_number];
  if (client) {
    twilioClient.messages.create({
      to:   client.owner_phone,
      from: twilio_number,
      body: `🆕 GravityLead: New lead from your website!\n\nName: ${name || "N/A"}\nPhone: ${normalizedPhone}\nTrade: ${trade || "N/A"}\n\nCall or text them now!`,
    }).catch(err => console.error("[api/lead] Failed to notify owner:", err.message));
  }

  console.log(`[api/lead] Created lead #${leadId}: ${normalizedPhone} (${source || "form"}) for ${twilio_number}`);
  res.json({ status: "enrolled", lead_id: leadId });
});

/* ══════════════════════════════════════════════════════════════════════════
 * GET /api/stats — Lead stats  [API key required]
 * ══════════════════════════════════════════════════════════════════════════ */
app.get("/api/stats", requireApiKey, (req, res) => {
  const stats    = db.getStats();
  const enriched = stats.map(s => ({
    ...s,
    business_name: clients[s.business_key]?.business_name || s.business_key,
  }));
  res.json({ clients: enriched });
});

/* ══════════════════════════════════════════════════════════════════════════
 * POST /api/job/complete — Mark a job complete; schedules a review request
 * [API key required]
 *
 * Body:
 *   customer_phone  {string}  Required. Customer's phone (10-digit or E.164).
 *   twilio_number   {string}  Required. The client's Twilio number.
 *   customer_name   {string}  Optional. Customer first name for personalisation.
 *   send_now        {boolean} Optional. Skip the delay and send immediately.
 *
 * Response:
 *   { status, review_id, scheduled_at, sent }
 * ══════════════════════════════════════════════════════════════════════════ */
app.post("/api/job/complete", requireApiKey, async (req, res) => {
  const { customer_phone, customer_name, twilio_number, send_now } = req.body;

  if (!customer_phone || !twilio_number) {
    return res.status(400).json({ error: "customer_phone and twilio_number are required." });
  }

  if (!validateTwilioNumber(twilio_number)) {
    return res.status(400).json({
      error: "Invalid twilio_number. Must be a registered GravityLead number.",
    });
  }

  const normalizedPhone = normalizePhone(String(customer_phone));
  if (!normalizedPhone) {
    return res.status(400).json({
      error: "Invalid customer_phone. Provide a 10-digit US number or E.164 format.",
    });
  }

  const client = clients[twilio_number];
  if (!client.google_review_link) {
    return res.status(422).json({
      error: `Client "${client.business_name}" is missing google_review_link in clients.json. Add it and restart the server.`,
    });
  }

  try {
    const result = await review.scheduleReview({
      customerPhone: normalizedPhone,
      customerName:  customer_name || null,
      businessKey:   twilio_number,
      twilioNumber:  twilio_number,
      sendNow:       parseBool(send_now),
    });

    if (result.skipped) {
      return res.json({ status: "skipped", reason: result.reason });
    }
    if (result.duplicate) {
      return res.json({ status: "already_scheduled", review_id: result.review_id, scheduled_at: result.scheduled_at });
    }

    console.log(
      `[api/job/complete] Review #${result.review_id} scheduled for ${normalizedPhone} ` +
      `(${client.business_name}) | send_now=${parseBool(send_now)} | sent=${result.sent}`
    );

    res.json({
      status:       result.sent ? "sent" : "scheduled",
      review_id:    result.review_id,
      scheduled_at: result.scheduled_at,
      sent:         result.sent,
    });
  } catch (err) {
    console.error("[api/job/complete] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * POST /api/review/send — Manually trigger a review request right now
 * [API key required]
 *
 * Two modes:
 *   Mode A — by review_id:  { review_id: 5 }
 *   Mode B — by customer:   { customer_phone, twilio_number, customer_name? }
 *
 * Mode B creates a new review request (or reuses a pending one) and fires it
 * immediately — handy for manual one-off sends without marking a job complete.
 * ══════════════════════════════════════════════════════════════════════════ */
app.post("/api/review/send", requireApiKey, async (req, res) => {
  const { review_id, customer_phone, twilio_number, customer_name } = req.body;

  try {
    // Mode A: send a specific scheduled review now
    if (review_id != null) {
      const reviewRecord = db.getReviewById(Number(review_id));
      if (!reviewRecord) {
        return res.status(404).json({ error: `Review request #${review_id} not found.` });
      }
      const result = await review.sendReviewById(Number(review_id));
      return res.json({
        status:       result.sent ? "sent" : "skipped",
        review_id:    Number(review_id),
        message_sid:  result.message_sid || null,
        reason:       result.reason || null,
      });
    }

    // Mode B: ad-hoc customer send
    if (!customer_phone || !twilio_number) {
      return res.status(400).json({
        error: "Provide either review_id, or both customer_phone and twilio_number.",
      });
    }

    if (!validateTwilioNumber(twilio_number)) {
      return res.status(400).json({
        error: "Invalid twilio_number. Must be a registered GravityLead number.",
      });
    }

    const normalizedPhone = normalizePhone(String(customer_phone));
    if (!normalizedPhone) {
      return res.status(400).json({
        error: "Invalid customer_phone. Provide a 10-digit US number or E.164 format.",
      });
    }

    const client = clients[twilio_number];
    if (!client.google_review_link) {
      return res.status(422).json({
        error: `Client "${client.business_name}" is missing google_review_link in clients.json.`,
      });
    }

    const result = await review.scheduleReview({
      customerPhone: normalizedPhone,
      customerName:  customer_name || null,
      businessKey:   twilio_number,
      twilioNumber:  twilio_number,
      sendNow:       true,
    });

    console.log(
      `[api/review/send] Manual send for ${normalizedPhone} (${client.business_name}) ` +
      `| review_id=${result.review_id} | sent=${result.sent}`
    );

    res.json({
      status:      result.sent ? "sent" : "skipped",
      review_id:   result.review_id,
      sent:        result.sent,
      reason:      result.reason || null,
    });
  } catch (err) {
    console.error("[api/review/send] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * GET /api/review/stats — Review request statistics  [API key required]
 * ══════════════════════════════════════════════════════════════════════════ */
app.get("/api/review/stats", requireApiKey, (req, res) => {
  const stats    = db.getReviewStats();
  const enriched = stats.map(s => ({
    ...s,
    business_name:      clients[s.business_key]?.business_name || s.business_key,
    has_review_link:    !!(clients[s.business_key]?.google_review_link),
  }));
  res.json({ clients: enriched });
});

/* ══════════════════════════════════════════════════════════════════════════
 * POST /api/report/send — Manually trigger the monthly report
 * [API key required]
 *
 * By default sends the previous month's report to all clients.
 * Optional body params:
 *   business_key  {string}  Send to one client only (Twilio number key)
 *   year          {number}  Override year  (default: previous month's year)
 *   month         {number}  Override month (default: previous month, 1–12)
 *
 * Response:
 *   Single client: { sent, message_sid?, reason?, stats?, year, month }
 *   All clients:   { total, sent, failed, results[], year, month }
 * ══════════════════════════════════════════════════════════════════════════ */
app.post("/api/report/send", requireApiKey, async (req, res) => {
  const { business_key, year, month } = req.body;

  // Default to previous calendar month when not specified
  const { year: prevYear, month: prevMonth } = reports.previousMonth();
  const targetYear  = year  != null ? Number(year)  : prevYear;
  const targetMonth = month != null ? Number(month) : prevMonth;

  if (!Number.isInteger(targetMonth) || targetMonth < 1 || targetMonth > 12) {
    return res.status(400).json({ error: "month must be an integer between 1 and 12." });
  }
  if (!Number.isInteger(targetYear) || targetYear < 2024) {
    return res.status(400).json({ error: "year must be a valid integer (2024 or later)." });
  }

  try {
    if (business_key) {
      // Single-client send
      if (!validateTwilioNumber(business_key)) {
        return res.status(400).json({
          error: "Invalid business_key. Must be a registered GravityLead number.",
        });
      }
      const result = await reports.sendMonthlyReport(business_key, targetYear, targetMonth);
      console.log(
        `[api/report/send] Manual report for ${business_key} ` +
        `(${reports.monthLabel(targetYear, targetMonth)}) | sent=${result.sent}`
      );
      return res.json({ ...result, year: targetYear, month: targetMonth });
    }

    // All-clients send
    const result = await reports.sendAllReports(targetYear, targetMonth);
    console.log(
      `[api/report/send] Manual bulk report (${reports.monthLabel(targetYear, targetMonth)}) ` +
      `| ${result.sent}/${result.total} sent`
    );
    return res.json({ ...result, year: targetYear, month: targetMonth });
  } catch (err) {
    console.error("[api/report/send] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * GET /health — Health check (unauthenticated, safe to expose publicly)
 * ══════════════════════════════════════════════════════════════════════════ */
app.get("/health", (req, res) => {
  res.json({
    status:    "ok",
    uptime:    process.uptime(),
    clients:   clientNumbers.size,
    timestamp: new Date().toISOString(),
  });
});

/* ── Start ───────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`[server] GravityLead server listening on port ${PORT}`);
  console.log(`[server] Base URL: ${BASE_URL}`);
  console.log(`[server] Twilio voice webhook: ${BASE_URL}/twilio/voice`);
  console.log(`[server] Twilio SMS webhook:   ${BASE_URL}/twilio/sms`);
  console.log(`[server] Twilio sig validation: ${SKIP_TWILIO_VALIDATION === "true" ? "DISABLED (dev mode)" : "ENABLED"}`);
  followup.startScheduler();
  review.startScheduler();
  reports.startScheduler();
});
