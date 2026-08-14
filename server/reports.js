/* ============================================================================
 * GravityLead — Monthly Client Report Engine
 *
 * On the 1st of every month at 9:00 AM (server local time), sends each
 * client's business owner a text message summarising the previous month's
 * GravityLead activity:
 *   • Leads captured via AI chat / website form
 *   • Missed calls that triggered a text-back
 *   • Follow-up messages sent
 *   • Google review requests sent
 *
 * Public API:
 *   init(twilio, clients)                         — call once on startup
 *   sendMonthlyReport(businessKey, year, month)   — send report for one client
 *   sendAllReports(year, month)                   — send to all clients
 *   startScheduler()                              — start cron (1st @ 9 AM)
 *   previousMonth()                               — { year, month } helper
 * ========================================================================== */

"use strict";

const cron = require("node-cron");
const db   = require("./db");

let twilioClient = null;
let clientConfig = {};

/* ── Init ─────────────────────────────────────────────────────────────────── */
function init(twilio, clients) {
  twilioClient = twilio;
  clientConfig = clients;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/**
 * Return { year, month } (month is 1-indexed) for the previous calendar month.
 */
function previousMonth() {
  const now   = new Date();
  let year    = now.getFullYear();
  let month   = now.getMonth(); // 0-indexed; 0 = January
  if (month === 0) {
    month = 12;
    year--;
  }
  // month is now 1-indexed (Jan=1 … Dec=12) of the previous month
  return { year, month };
}

/**
 * Format a 1-indexed month number + year into a readable string.
 * e.g. monthLabel(2026, 7) → "July 2026"
 */
function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleString("en-US", {
    month: "long",
    year:  "numeric",
  });
}

/**
 * Build the report SMS body from client config and monthly stats.
 */
function buildReportMessage(client, stats, monthStr) {
  const owner = client.owner_name || "there";
  return (
    `Hey ${owner}, here's your GravityLead report for ${monthStr}:\n\n` +
    `📊 Leads captured: ${stats.chat_leads} | ` +
    `Missed calls recovered: ${stats.missed_calls} | ` +
    `Follow-ups sent: ${stats.followups_sent} | ` +
    `Review requests: ${stats.reviews_sent}\n\n` +
    `Questions? Reply anytime.`
  );
}

/* ── Send report for one client ───────────────────────────────────────────── */
/**
 * Fetch monthly stats for one business and SMS the report to the owner.
 *
 * @param {string} businessKey  Twilio number (key in clients.json)
 * @param {number} year
 * @param {number} month        1–12
 * @returns {{ sent: boolean, message_sid?: string, reason?: string, stats?: object }}
 */
async function sendMonthlyReport(businessKey, year, month) {
  const client = clientConfig[businessKey];
  if (!client) {
    console.warn(`[reports] No client config for ${businessKey} — skipping`);
    return { sent: false, reason: "no_client_config" };
  }

  const stats    = db.getMonthlyStats(businessKey, year, month);
  const monthStr = monthLabel(year, month);
  const body     = buildReportMessage(client, stats, monthStr);

  try {
    const msg = await twilioClient.messages.create({
      to:   client.owner_phone,
      from: businessKey,
      body,
    });

    db.logSms({
      lead_id:     null,
      direction:   "outbound",
      from_number: businessKey,
      to_number:   client.owner_phone,
      body,
      message_sid: msg.sid,
      status:      msg.status,
    });

    console.log(
      `[reports] Sent ${monthStr} report to ${client.owner_phone} ` +
      `(${client.business_name}) | SID: ${msg.sid} | ` +
      `leads=${stats.chat_leads} missed=${stats.missed_calls} ` +
      `followups=${stats.followups_sent} reviews=${stats.reviews_sent}`
    );

    return { sent: true, message_sid: msg.sid, stats };
  } catch (err) {
    console.error(
      `[reports] Failed to send ${monthStr} report to ${client.business_name}: ${err.message}`
    );
    return { sent: false, reason: err.message };
  }
}

/* ── Send reports to all clients ──────────────────────────────────────────── */
/**
 * Iterate every entry in clients.json and fire their monthly report.
 *
 * @param {number} year
 * @param {number} month  1–12
 * @returns {{ total, sent, failed, results }}
 */
async function sendAllReports(year, month) {
  const keys    = Object.keys(clientConfig);
  const results = [];
  let sent      = 0;
  let failed    = 0;

  for (const key of keys) {
    const result = await sendMonthlyReport(key, year, month);
    results.push({ business_key: key, ...result });
    if (result.sent) { sent++; } else { failed++; }
  }

  return { total: keys.length, sent, failed, results };
}

/* ── Scheduler ────────────────────────────────────────────────────────────── */
/**
 * Start the monthly cron job — fires at 9:00 AM on the 1st of every month.
 * Uses server local time (matching the timezone clients are in).
 */
function startScheduler() {
  // "0 9 1 * *" = minute 0, hour 9, day-of-month 1, any month, any day-of-week
  cron.schedule("0 9 1 * *", async () => {
    const { year, month } = previousMonth();
    const label           = monthLabel(year, month);
    console.log(`[reports] Monthly report run — sending ${label} reports to all clients`);
    try {
      const result = await sendAllReports(year, month);
      console.log(
        `[reports] Run complete: ${result.sent}/${result.total} sent, ${result.failed} failed`
      );
    } catch (err) {
      console.error("[reports] Scheduler error:", err);
    }
  });
  console.log("[reports] Scheduler started — monthly reports fire on the 1st of each month at 9:00 AM");
}

module.exports = {
  init,
  sendMonthlyReport,
  sendAllReports,
  startScheduler,
  previousMonth,
  monthLabel,
};
