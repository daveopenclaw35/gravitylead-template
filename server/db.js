/* ============================================================================
 * GravityLead — SQLite persistence layer
 * Uses Node.js built-in node:sqlite (available since Node 22.5+).
 * ========================================================================== */

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = path.join(__dirname, "gravitylead.db");
const db = new DatabaseSync(DB_PATH);

/* -- Pragmas --------------------------------------------------------------- */
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

/* -- Schema ---------------------------------------------------------------- */
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phone         TEXT    NOT NULL,
    name          TEXT,
    business_key  TEXT    NOT NULL,
    twilio_number TEXT,
    source        TEXT    DEFAULT 'missed_call',
    created_at    TEXT    DEFAULT (datetime('now')),
    opted_out     INTEGER DEFAULT 0,
    notes         TEXT
  );

  CREATE TABLE IF NOT EXISTS followups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id      INTEGER NOT NULL,
    day          INTEGER NOT NULL,
    status       TEXT    DEFAULT 'pending',
    scheduled_at TEXT,
    sent_at      TEXT,
    message_sid  TEXT,
    error        TEXT,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sms_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER,
    direction   TEXT,
    from_number TEXT,
    to_number   TEXT,
    body        TEXT,
    message_sid TEXT,
    status      TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
  CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_key);
  CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_followups_lead ON followups(lead_id);
  CREATE INDEX IF NOT EXISTS idx_sms_log_lead ON sms_log(lead_id);
`);

/* -- Prepared statements --------------------------------------------------- */

const insertLead = db.prepare(`
  INSERT INTO leads (phone, name, business_key, twilio_number, source, notes)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const findLeadByPhone = db.prepare(`
  SELECT * FROM leads
  WHERE phone = ? AND business_key = ? AND opted_out = 0
  ORDER BY created_at DESC LIMIT 1
`);

const findRecentLeadByPhone = db.prepare(`
  SELECT * FROM leads
  WHERE phone = ? AND business_key = ? AND opted_out = 0
    AND created_at > datetime('now', '-30 days')
  ORDER BY created_at DESC LIMIT 1
`);

const optOutByPhone = db.prepare(`
  UPDATE leads SET opted_out = 1 WHERE phone = ?
`);

const cancelFollowups = db.prepare(`
  UPDATE followups SET status = 'skipped'
  WHERE lead_id IN (SELECT id FROM leads WHERE phone = ?)
    AND status = 'pending'
`);

const insertFollowup = db.prepare(`
  INSERT INTO followups (lead_id, day, scheduled_at)
  VALUES (?, ?, ?)
`);

const getDueFollowupsStmt = db.prepare(`
  SELECT f.id, f.lead_id, f.day, f.status, f.scheduled_at,
         l.phone, l.name, l.business_key, l.twilio_number, l.opted_out
  FROM followups f
  JOIN leads l ON f.lead_id = l.id
  WHERE f.status = 'pending'
    AND f.scheduled_at <= datetime('now')
    AND l.opted_out = 0
  ORDER BY f.scheduled_at ASC
`);

const markFollowupSent = db.prepare(`
  UPDATE followups SET status = 'sent', sent_at = datetime('now'), message_sid = ?
  WHERE id = ?
`);

const markFollowupFailed = db.prepare(`
  UPDATE followups SET status = 'failed', error = ?
  WHERE id = ?
`);

const insertSmsLog = db.prepare(`
  INSERT INTO sms_log (lead_id, direction, from_number, to_number, body, message_sid, status)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getLeadStatsStmt = db.prepare(`
  SELECT
    business_key,
    COUNT(*) as total_leads,
    SUM(CASE WHEN source = 'missed_call' THEN 1 ELSE 0 END) as missed_calls,
    SUM(CASE WHEN source = 'form' THEN 1 ELSE 0 END) as form_leads,
    SUM(CASE WHEN source = 'chat' THEN 1 ELSE 0 END) as chat_leads,
    SUM(CASE WHEN opted_out = 1 THEN 1 ELSE 0 END) as opted_out
  FROM leads
  GROUP BY business_key
`);

/* -- Public API ------------------------------------------------------------ */

module.exports = {
  db,

  createLead({ phone, name, business_key, twilio_number, source, notes }) {
    const result = insertLead.run(
      phone, name || null, business_key, twilio_number || null, source || "missed_call", notes || null
    );
    return result.lastInsertRowid;
  },

  findLead(phone, business_key) {
    return findLeadByPhone.get(phone, business_key);
  },

  findRecentLead(phone, business_key) {
    return findRecentLeadByPhone.get(phone, business_key);
  },

  optOut(phone) {
    optOutByPhone.run(phone);
    cancelFollowups.run(phone);
  },

  scheduleFollowups(leadId) {
    const now = new Date();
    const days = [0, 3, 7, 30];
    for (const day of days) {
      const scheduled = new Date(now.getTime() + day * 24 * 60 * 60 * 1000);
      /* Format as SQLite-compatible datetime: YYYY-MM-DD HH:MM:SS */
      const sqlDt = scheduled.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
      insertFollowup.run(leadId, day, sqlDt);
    }
  },

  getDueFollowups() {
    return getDueFollowupsStmt.all();
  },

  markSent(followupId, messageSid) {
    markFollowupSent.run(messageSid, followupId);
  },

  markFailed(followupId, error) {
    markFollowupFailed.run(String(error), followupId);
  },

  logSms({ lead_id, direction, from_number, to_number, body, message_sid, status }) {
    insertSmsLog.run(
      lead_id || null, direction, from_number, to_number, body, message_sid || null, status || "sent"
    );
  },

  getStats() {
    return getLeadStatsStmt.all();
  },
};
