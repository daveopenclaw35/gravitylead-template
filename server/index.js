/* ============================================================================
 * GravityLead Server
 * Missed-call text-back + 3/7/30-day SMS follow-up sequences via Twilio.
 *
 * Endpoints:
 *   POST /twilio/voice          — incoming call webhook (TwiML: forward to owner)
 *   POST /twilio/voice/status   — dial status callback (triggers text-back on miss)
 *   POST /twilio/sms            — inbound SMS (STOP opt-out + reply logging)
 *   POST /api/lead              — website form/chat lead intake
 *   GET  /api/stats             — lead stats dashboard
 *   GET  /health                — health check
 *
 * Setup:
 *   1. Copy .env.example → .env, fill in Twilio credentials.
 *   2. Edit clients.json — map each Twilio number to a business.
 *   3. npm install && npm start
 *   4. Point Twilio voice/SMS webhooks to BASE_URL/twilio/voice and /twilio/sms.
 * ========================================================================== */

require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const db = require("./db");
const followup = require("./followup");
const { renderTemplate } = require("./templates");

/* -- Config ---------------------------------------------------------------- */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PORT = 3000,
  BASE_URL = `http://localhost:${PORT}`,
  FORMSPREE_ENDPOINT,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;

/* -- Load client config ---------------------------------------------------- */
let clients;
try {
  clients = require("./clients.json");
  /* Remove meta keys */
  delete clients._comment;
  delete clients._example;
} catch (err) {
  console.error("Could not load clients.json:", err.message);
  clients = {};
}

const clientCount = Object.keys(clients).length;
console.log(`[server] Loaded ${clientCount} client(s) from clients.json`);

/* -- Init follow-up engine ------------------------------------------------- */
followup.init(twilioClient, clients);

/* -- Express app ----------------------------------------------------------- */
const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded
app.use(express.json());                          // API sends JSON

/* ========================================================================== *
 * POST /twilio/voice — Incoming call webhook
 * Twilio calls this when someone dials a GravityLead number.
 * Returns TwiML that rings the business owner's phone.
 * If no answer → Twilio hits the <Dial action="..."> callback.
 * ========================================================================== */
app.post("/twilio/voice", (req, res) => {
  const { From, To, CallSid } = req.body;
  const client = clients[To];
  const twiml = new VoiceResponse();

  if (!client) {
    console.warn(`[voice] No client config for Twilio number: ${To}`);
    twiml.say("Sorry, this number is not configured. Please try again later.");
    return res.type("text/xml").send(twiml.toString());
  }

  console.log(`[voice] Incoming call from ${From} to ${To} (${client.business_name}) — CallSid: ${CallSid}`);

  /* Forward to owner's phone with a timeout.
     The `action` URL fires after the <Dial> completes — whether answered or not. */
  const dial = twiml.dial({
    action: `${BASE_URL}/twilio/voice/status`,
    method: "POST",
    timeout: client.ring_timeout || 20,
    callerId: To,  // show the Twilio number as caller ID
  });
  dial.number(client.owner_phone);

  res.type("text/xml").send(twiml.toString());
});

/* ========================================================================== *
 * POST /twilio/voice/status — <Dial> action callback
 * Fires after the forwarded call ends. If the owner didn't pick up,
 * we send an immediate text-back and enroll the caller in follow-ups.
 * ========================================================================== */
app.post("/twilio/voice/status", async (req, res) => {
  const { DialCallStatus, From, To, CallSid } = req.body;
  const twiml = new VoiceResponse();

  console.log(`[voice-status] CallSid: ${CallSid} | DialCallStatus: ${DialCallStatus} | From: ${From} | To: ${To}`);

  /* Call was answered — no action needed */
  if (DialCallStatus === "completed") {
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  /* Missed call — trigger text-back + follow-up sequence */
  const client = clients[To];
  if (!client) {
    console.warn(`[voice-status] No client for ${To}, skipping text-back`);
    twiml.say("Sorry we missed your call. Please try again later.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  /* Play a brief message before hanging up */
  twiml.say(
    { voice: "Polly.Joanna" },
    `Sorry we missed your call. We'll text you right away at this number. Talk soon!`
  );
  twiml.hangup();

  /* Don't double-enroll: skip if this caller already has an active sequence
     with this business within the last 30 days */
  const existing = db.findRecentLead(From, To);
  if (existing) {
    console.log(`[voice-status] Caller ${From} already has active lead #${existing.id} for ${client.business_name}, skipping re-enroll`);
    return res.type("text/xml").send(twiml.toString());
  }

  /* Create lead + schedule follow-ups */
  const leadId = db.createLead({
    phone: From,
    business_key: To,
    twilio_number: To,
    source: "missed_call",
    notes: `Missed call (${DialCallStatus}). CallSid: ${CallSid}`,
  });

  db.scheduleFollowups(leadId);

  console.log(`[voice-status] Created lead #${leadId} for ${From} → ${client.business_name}. Text-back + follow-ups scheduled.`);

  /* Send the immediate text-back (day-0 follow-up fires via scheduler,
     but we also send synchronously for speed) */
  try {
    const body = renderTemplate(0, {
      business_name: client.business_name,
      owner_name: client.owner_name,
      business_phone: client.owner_phone,
      trade: client.trade,
    });

    const msg = await twilioClient.messages.create({
      to: From,
      from: To,
      body,
    });

    /* Mark the day-0 follow-up as sent so the scheduler doesn't double-send */
    const dueNow = db.getDueFollowups().find(f => f.lead_id === Number(leadId) && f.day === 0);
    if (dueNow) db.markSent(dueNow.id, msg.sid);

    db.logSms({
      lead_id: leadId,
      direction: "outbound",
      from_number: To,
      to_number: From,
      body,
      message_sid: msg.sid,
      status: msg.status,
    });

    console.log(`[text-back] Sent to ${From}: "${body.substring(0, 60)}..." — SID: ${msg.sid}`);
  } catch (err) {
    console.error(`[text-back] Failed to send to ${From}:`, err.message);
  }

  res.type("text/xml").send(twiml.toString());
});

/* ========================================================================== *
 * POST /twilio/sms — Inbound SMS handler
 * Handles STOP/opt-out and logs all inbound messages.
 * ========================================================================== */
app.post("/twilio/sms", (req, res) => {
  const { From, To, Body, MessageSid } = req.body;
  const twiml = new MessagingResponse();
  const bodyLower = (Body || "").trim().toLowerCase();

  console.log(`[sms-in] From: ${From} To: ${To} Body: "${Body}"`);

  /* Log inbound SMS */
  const lead = db.findLead(From, To);
  db.logSms({
    lead_id: lead ? lead.id : null,
    direction: "inbound",
    from_number: From,
    to_number: To,
    body: Body,
    message_sid: MessageSid,
    status: "received",
  });

  /* Handle STOP / opt-out */
  const stopWords = ["stop", "unsubscribe", "cancel", "quit", "end"];
  if (stopWords.includes(bodyLower)) {
    db.optOut(From);
    console.log(`[sms-in] Opted out: ${From}`);
    /* Twilio automatically handles STOP for long codes, but we also
       cancel pending follow-ups in our DB */
    return res.type("text/xml").send(twiml.toString());
  }

  /* Handle YES (interested reply) — notify the business owner */
  if (bodyLower === "yes" || bodyLower === "y") {
    const client = clients[To];
    if (client) {
      /* Forward to owner */
      twilioClient.messages.create({
        to: client.owner_phone,
        from: To,
        body: `🔔 GravityLead: ${From} replied YES to your follow-up. Call or text them back!\n\nOriginal lead: ${lead ? `#${lead.id} (${lead.source})` : "unknown"}`,
      }).catch(err => console.error("[sms-in] Failed to notify owner:", err.message));

      twiml.message("Thanks! Someone from our team will reach out to you shortly.");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /* Any other reply — forward to owner as an alert */
  const client = clients[To];
  if (client && Body && Body.trim()) {
    twilioClient.messages.create({
      to: client.owner_phone,
      from: To,
      body: `💬 GravityLead: Reply from ${From}:\n"${Body}"\n\nReply directly to this number to respond.`,
    }).catch(err => console.error("[sms-in] Failed to forward reply:", err.message));
  }

  /* Empty TwiML = no auto-reply for general messages */
  res.type("text/xml").send(twiml.toString());
});

/* ========================================================================== *
 * POST /api/lead — Website form / chat lead intake
 * Call this from the GravityLead website form to enroll in follow-ups.
 * ========================================================================== */
app.post("/api/lead", async (req, res) => {
  const { phone, name, business, trade, twilio_number, source } = req.body;

  if (!phone || !twilio_number) {
    return res.status(400).json({ error: "phone and twilio_number are required" });
  }

  /* Normalize phone to E.164 if not already */
  const normalizedPhone = phone.startsWith("+") ? phone : `+1${phone.replace(/\D/g, "")}`;

  /* Check for existing recent lead to avoid duplicates */
  const existing = db.findRecentLead(normalizedPhone, twilio_number);
  if (existing) {
    return res.json({ status: "already_enrolled", lead_id: existing.id });
  }

  const leadId = db.createLead({
    phone: normalizedPhone,
    name: name || null,
    business_key: twilio_number,
    twilio_number,
    source: source || "form",
    notes: `Business: ${business || ""}, Trade: ${trade || ""}`,
  });

  /* Schedule follow-ups (skip day-0 immediate for form leads — they already got the form confirmation) */
  db.scheduleFollowups(leadId);

  /* Optionally pass through to Formspree */
  if (FORMSPREE_ENDPOINT) {
    try {
      await fetch(FORMSPREE_ENDPOINT, {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, business, trade, source: "website_form" }),
      });
    } catch (err) {
      console.warn("[api/lead] Formspree passthrough failed:", err.message);
    }
  }

  /* Notify the business owner */
  const client = clients[twilio_number];
  if (client) {
    twilioClient.messages.create({
      to: client.owner_phone,
      from: twilio_number,
      body: `🆕 GravityLead: New lead from your website!\n\nName: ${name || "N/A"}\nPhone: ${normalizedPhone}\nTrade: ${trade || "N/A"}\n\nCall or text them now!`,
    }).catch(err => console.error("[api/lead] Failed to notify owner:", err.message));
  }

  console.log(`[api/lead] Created lead #${leadId}: ${normalizedPhone} (${source || "form"}) for ${twilio_number}`);
  res.json({ status: "enrolled", lead_id: leadId });
});

/* ========================================================================== *
 * GET /api/stats — Simple lead stats dashboard
 * ========================================================================== */
app.get("/api/stats", (req, res) => {
  const stats = db.getStats();
  const enriched = stats.map(s => ({
    ...s,
    business_name: clients[s.business_key]?.business_name || s.business_key,
  }));
  res.json({ clients: enriched });
});

/* ========================================================================== *
 * GET /health — Health check
 * ========================================================================== */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    clients: Object.keys(clients).length,
    timestamp: new Date().toISOString(),
  });
});

/* -- Start ----------------------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`[server] GravityLead server listening on port ${PORT}`);
  console.log(`[server] Base URL: ${BASE_URL}`);
  console.log(`[server] Twilio voice webhook: ${BASE_URL}/twilio/voice`);
  console.log(`[server] Twilio SMS webhook:   ${BASE_URL}/twilio/sms`);
  followup.startScheduler();
});
