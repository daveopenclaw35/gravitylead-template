/* ============================================================================
 * GravityLead — Follow-up sequence engine
 * Checks for due follow-ups every minute and sends SMS via Twilio.
 * Also exposes processDueFollowups() for on-demand runs.
 * ========================================================================== */

const cron = require("node-cron");
const db = require("./db");
const { renderTemplate } = require("./templates");

let twilioClient = null;
let clientConfig = {};

function init(twilio, clients) {
  twilioClient = twilio;
  clientConfig = clients;
}

/* -- Build a lookup from Twilio number to client config -------------------- */
function getClientByTwilioNumber(twilioNumber) {
  return clientConfig[twilioNumber] || null;
}

function getClientByKey(businessKey) {
  for (const [num, client] of Object.entries(clientConfig)) {
    if (num === businessKey) return { ...client, twilio_number: num };
  }
  return null;
}

/* -- Send one SMS ---------------------------------------------------------- */
async function sendSms({ to, from, body, leadId }) {
  try {
    const msg = await twilioClient.messages.create({ to, from, body });

    db.logSms({
      lead_id: leadId,
      direction: "outbound",
      from_number: from,
      to_number: to,
      body,
      message_sid: msg.sid,
      status: msg.status,
    });

    return msg;
  } catch (err) {
    db.logSms({
      lead_id: leadId,
      direction: "outbound",
      from_number: from,
      to_number: to,
      body,
      message_sid: null,
      status: "error: " + err.message,
    });
    throw err;
  }
}

/* -- Process all due follow-ups ------------------------------------------- */
async function processDueFollowups() {
  const due = db.getDueFollowups();

  if (due.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const f of due) {
    /* Skip if lead opted out */
    if (f.opted_out) {
      db.markFailed(f.id, "lead opted out");
      failed++;
      continue;
    }

    const client = getClientByKey(f.business_key);
    if (!client) {
      db.markFailed(f.id, `no client config for business_key: ${f.business_key}`);
      failed++;
      continue;
    }

    const body = renderTemplate(f.day, {
      business_name: client.business_name,
      owner_name: client.owner_name,
      business_phone: client.owner_phone,
      trade: client.trade,
    });

    if (!body) {
      db.markFailed(f.id, `no template for day ${f.day}`);
      failed++;
      continue;
    }

    try {
      const msg = await sendSms({
        to: f.phone,
        from: f.twilio_number || f.business_key,
        body,
        leadId: f.lead_id,
      });
      db.markSent(f.id, msg.sid);
      sent++;
      console.log(`[followup] Sent day-${f.day} to ${f.phone} (${client.business_name})`);
    } catch (err) {
      db.markFailed(f.id, err.message);
      failed++;
      console.error(`[followup] Failed day-${f.day} to ${f.phone}: ${err.message}`);
    }
  }

  return { processed: due.length, sent, failed };
}

/* -- Schedule: check every minute ----------------------------------------- */
function startScheduler() {
  cron.schedule("* * * * *", async () => {
    try {
      const result = await processDueFollowups();
      if (result.processed > 0) {
        console.log(`[followup] Batch: ${result.sent} sent, ${result.failed} failed`);
      }
    } catch (err) {
      console.error("[followup] Scheduler error:", err);
    }
  });
  console.log("[followup] Scheduler started — checking every minute");
}

module.exports = { init, sendSms, processDueFollowups, startScheduler, getClientByTwilioNumber, getClientByKey };
