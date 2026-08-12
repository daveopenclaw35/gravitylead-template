/* ============================================================================
 * GravityLead — Google Review Request Engine
 *
 * Sends a review-request SMS 24–48 hours after a job is marked complete.
 * The exact delay is randomised within that window to feel natural.
 *
 * Each client in clients.json must have a `google_review_link` field.
 * If it is missing, the review request is logged and skipped.
 *
 * Public API:
 *   init(twilio, clients)          — call once on startup
 *   scheduleReview(opts)           — schedule or immediately send a review request
 *   sendReviewById(id)             — send a specific pending review request now
 *   processDueReviews()            — process all currently due requests (called by scheduler)
 *   startScheduler()               — start the every-minute cron check
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

/** Pick a random delay between minHours and maxHours, returned in ms. */
function randomDelayMs(minHours = 24, maxHours = 48) {
  const minMs = minHours * 60 * 60 * 1000;
  const maxMs = maxHours * 60 * 60 * 1000;
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/** Format a Date for SQLite (YYYY-MM-DD HH:MM:SS UTC). */
function toSqlDate(date) {
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** Build the review SMS body for a client/customer. */
function buildReviewMessage(client, customerName) {
  const greeting = customerName ? `Hi ${customerName}` : "Hi";
  const link     = client.google_review_link;
  return (
    `${greeting}, thanks for choosing ${client.business_name}! ` +
    `We'd love your feedback — it only takes 30 seconds: ${link}\n\n` +
    `Reply STOP to opt out.`
  );
}

/** Send an SMS and log it in sms_log. */
async function sendSms({ to, from, body }) {
  const msg = await twilioClient.messages.create({ to, from, body });
  db.logSms({
    lead_id:      null,
    direction:    "outbound",
    from_number:  from,
    to_number:    to,
    body,
    message_sid:  msg.sid,
    status:       msg.status,
  });
  return msg;
}

/* ── Schedule a review request ────────────────────────────────────────────── */
/**
 * Schedule (or immediately send) a Google review request.
 *
 * @param {object} opts
 * @param {string} opts.customerPhone  E.164 customer phone number
 * @param {string} [opts.customerName] Customer first name (optional)
 * @param {string} opts.businessKey    Twilio number / business key
 * @param {string} [opts.twilioNumber] Twilio number to send from (defaults to businessKey)
 * @param {boolean} [opts.sendNow]     Skip delay and send immediately
 * @returns {{ review_id, scheduled_at, sent: boolean }}
 */
async function scheduleReview({ customerPhone, customerName, businessKey, twilioNumber, sendNow = false }) {
  const fromNumber = twilioNumber || businessKey;
  const client     = clientConfig[fromNumber];

  if (!client) {
    throw new Error(`No client config for twilio_number: ${fromNumber}`);
  }

  if (!client.google_review_link) {
    throw new Error(
      `Client "${client.business_name}" is missing google_review_link in clients.json`
    );
  }

  // Respect opt-outs
  if (db.isOptedOut(customerPhone)) {
    return { review_id: null, scheduled_at: null, sent: false, skipped: true, reason: "opted_out" };
  }

  // Deduplicate — don't double-schedule for the same customer+business
  const existing = db.findPendingReview(customerPhone, fromNumber);
  if (existing) {
    return {
      review_id:    existing.id,
      scheduled_at: existing.scheduled_at,
      sent:         false,
      duplicate:    true,
    };
  }

  if (sendNow) {
    // Insert with scheduled_at = now (immediately due)
    const scheduledAt = toSqlDate(new Date());
    const reviewId = db.scheduleReviewRequest({
      customerPhone,
      customerName,
      businessKey:  fromNumber,
      twilioNumber: fromNumber,
      scheduledAt,
    });

    const result = await sendReviewById(reviewId);
    return { review_id: reviewId, scheduled_at: scheduledAt, sent: result.sent };
  }

  // Schedule for 24–48h from now
  const delayMs     = randomDelayMs(24, 48);
  const scheduledAt = toSqlDate(new Date(Date.now() + delayMs));

  const reviewId = db.scheduleReviewRequest({
    customerPhone,
    customerName,
    businessKey:  fromNumber,
    twilioNumber: fromNumber,
    scheduledAt,
  });

  console.log(
    `[review] Scheduled review #${reviewId} for ${customerPhone} (${client.business_name}) ` +
    `at ${scheduledAt}`
  );

  return { review_id: reviewId, scheduled_at: scheduledAt, sent: false };
}

/* ── Send a specific review request immediately ───────────────────────────── */
/**
 * Send a pending review request by its DB id right now.
 * @param {number} id  review_requests.id
 * @returns {{ sent: boolean, message_sid: string|null }}
 */
async function sendReviewById(id) {
  const review = db.getReviewById(id);
  if (!review) throw new Error(`Review request #${id} not found`);

  if (review.status !== "pending") {
    return { sent: false, reason: `status is ${review.status}` };
  }

  if (db.isOptedOut(review.customer_phone)) {
    db.markReviewSkipped(id, "opted_out");
    return { sent: false, reason: "opted_out" };
  }

  const client = clientConfig[review.twilio_number];
  if (!client) {
    db.markReviewFailed(id, `no client config for ${review.twilio_number}`);
    return { sent: false, reason: "no_client_config" };
  }

  if (!client.google_review_link) {
    db.markReviewFailed(id, `missing google_review_link for ${client.business_name}`);
    return { sent: false, reason: "no_review_link" };
  }

  const body = buildReviewMessage(client, review.customer_name);

  try {
    const msg = await sendSms({ to: review.customer_phone, from: review.twilio_number, body });
    db.markReviewSent(id, msg.sid);
    console.log(
      `[review] Sent review request #${id} to ${review.customer_phone} ` +
      `(${client.business_name}) | SID: ${msg.sid}`
    );
    return { sent: true, message_sid: msg.sid };
  } catch (err) {
    db.markReviewFailed(id, err.message);
    console.error(`[review] Failed to send review #${id} to ${review.customer_phone}: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

/* ── Process all due review requests ──────────────────────────────────────── */
async function processDueReviews() {
  const due = db.getDueReviewRequests();
  if (due.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent   = 0;
  let failed = 0;

  for (const review of due) {
    try {
      const result = await sendReviewById(review.id);
      if (result.sent) {
        sent++;
      } else {
        // skipped/opted-out/etc. — not a failure
        failed++;
      }
    } catch (err) {
      db.markReviewFailed(review.id, err.message);
      console.error(`[review] Unhandled error for review #${review.id}: ${err.message}`);
      failed++;
    }
  }

  return { processed: due.length, sent, failed };
}

/* ── Scheduler ────────────────────────────────────────────────────────────── */
function startScheduler() {
  cron.schedule("* * * * *", async () => {
    try {
      const result = await processDueReviews();
      if (result.processed > 0) {
        console.log(`[review] Batch: ${result.sent} sent, ${result.failed} failed/skipped`);
      }
    } catch (err) {
      console.error("[review] Scheduler error:", err);
    }
  });
  console.log("[review] Scheduler started — checking every minute");
}

module.exports = {
  init,
  scheduleReview,
  sendReviewById,
  processDueReviews,
  startScheduler,
};
