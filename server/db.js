/* ============================================================================
 * GravityLead — SQLite persistence layer
 * Uses Node.js built-in node:sqlite (available since Node 22.5+).
 * ========================================================================== */

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = process.env.GRAVITYLEAD_DB_PATH || path.join(__dirname, "gravitylead.db");
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

  CREATE TABLE IF NOT EXISTS review_requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT    NOT NULL,
    customer_name  TEXT,
    business_key   TEXT    NOT NULL,
    twilio_number  TEXT    NOT NULL,
    scheduled_at   TEXT    NOT NULL,
    sent_at        TEXT,
    message_sid    TEXT,
    status         TEXT    DEFAULT 'pending',
    error          TEXT,
    created_at     TEXT    DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_review_status   ON review_requests(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_review_phone    ON review_requests(customer_phone, business_key);
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

const getLeadByIdStmt = db.prepare(`
  SELECT * FROM leads WHERE id = ?
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

const isOptedOutStmt = db.prepare(`
  SELECT opted_out FROM leads
  WHERE phone = ? AND opted_out = 1
  LIMIT 1
`);

const insertReviewRequest = db.prepare(`
  INSERT INTO review_requests (customer_phone, customer_name, business_key, twilio_number, scheduled_at)
  VALUES (?, ?, ?, ?, ?)
`);

const findPendingReviewStmt = db.prepare(`
  SELECT * FROM review_requests
  WHERE customer_phone = ? AND business_key = ?
    AND status IN ('pending')
  ORDER BY created_at DESC LIMIT 1
`);

const getDueReviewRequestsStmt = db.prepare(`
  SELECT r.*
  FROM review_requests r
  WHERE r.status = 'pending'
    AND r.scheduled_at <= datetime('now')
  ORDER BY r.scheduled_at ASC
`);

const getReviewByIdStmt = db.prepare(`
  SELECT * FROM review_requests WHERE id = ?
`);

const markReviewSentStmt = db.prepare(`
  UPDATE review_requests SET status = 'sent', sent_at = datetime('now'), message_sid = ?
  WHERE id = ?
`);

const markReviewFailedStmt = db.prepare(`
  UPDATE review_requests SET status = 'failed', error = ?
  WHERE id = ?
`);

const markReviewSkippedStmt = db.prepare(`
  UPDATE review_requests SET status = 'skipped', error = ?
  WHERE id = ?
`);

const updateReviewScheduleStmt = db.prepare(`
  UPDATE review_requests SET scheduled_at = ?
  WHERE id = ?
`);

const getReviewStatsStmt = db.prepare(`
  SELECT
    business_key,
    COUNT(*) as total_scheduled,
    SUM(CASE WHEN status = 'sent'    THEN 1 ELSE 0 END) as sent,
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
  FROM review_requests
  GROUP BY business_key
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

/* -- Monthly stats for client reports ------------------------------------- */

const getMonthlyChatLeadsStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM leads
  WHERE business_key = ?
    AND (source = 'chat' OR source = 'form')
    AND strftime('%Y', created_at) = ?
    AND strftime('%m', created_at) = ?
`);

const getMonthlyMissedCallsStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM leads
  WHERE business_key = ?
    AND source = 'missed_call'
    AND strftime('%Y', created_at) = ?
    AND strftime('%m', created_at) = ?
`);

const getMonthlyFollowupsSentStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM followups f
  JOIN leads l ON f.lead_id = l.id
  WHERE l.business_key = ?
    AND f.status = 'sent'
    AND strftime('%Y', f.sent_at) = ?
    AND strftime('%m', f.sent_at) = ?
`);

const getMonthlyReviewsSentStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM review_requests
  WHERE business_key = ?
    AND status = 'sent'
    AND strftime('%Y', sent_at) = ?
    AND strftime('%m', sent_at) = ?
`);

/* -- Dashboard activity queries ------------------------------------------- */

const getRecentLeadsStmt = db.prepare(`
  SELECT id, phone, name, business_key, source, created_at, opted_out
  FROM leads
  ORDER BY created_at DESC
  LIMIT ?
`);

const getUpcomingFollowupsStmt = db.prepare(`
  SELECT f.id, f.lead_id, f.day, f.scheduled_at,
         l.phone, l.name, l.business_key
  FROM followups f
  JOIN leads l ON f.lead_id = l.id
  WHERE f.status = 'pending'
    AND f.scheduled_at >= datetime('now')
  ORDER BY f.scheduled_at ASC
  LIMIT ?
`);

const getRecentTextBacksStmt = db.prepare(`
  SELECT s.id, s.to_number, s.from_number, s.created_at, s.body,
         l.name, l.phone AS caller, l.business_key
  FROM sms_log s
  JOIN leads l ON s.lead_id = l.id AND l.source = 'missed_call'
  WHERE s.direction = 'outbound'
  ORDER BY s.created_at DESC
  LIMIT ?
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

  getLeadById(id) {
    return getLeadByIdStmt.get(id) || null;
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

  /**
   * Return activity counts for a single client in a given calendar month.
   * @param {string} businessKey  Twilio number / business key
   * @param {number} year
   * @param {number} month  1–12
   * @returns {{ chat_leads, missed_calls, followups_sent, reviews_sent }}
   */
  getMonthlyStats(businessKey, year, month) {
    const yy = String(year);
    const mm = String(month).padStart(2, "0");
    return {
      chat_leads:     getMonthlyChatLeadsStmt.get(businessKey, yy, mm).count,
      missed_calls:   getMonthlyMissedCallsStmt.get(businessKey, yy, mm).count,
      followups_sent: getMonthlyFollowupsSentStmt.get(businessKey, yy, mm).count,
      reviews_sent:   getMonthlyReviewsSentStmt.get(businessKey, yy, mm).count,
    };
  },

  /* -- Review request methods -------------------------------------------- */

  isOptedOut(phone) {
    const row = isOptedOutStmt.get(phone);
    return !!(row && row.opted_out);
  },

  scheduleReviewRequest({ customerPhone, customerName, businessKey, twilioNumber, scheduledAt }) {
    const sqlDt = scheduledAt instanceof Date
      ? scheduledAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, "")
      : scheduledAt;
    const result = insertReviewRequest.run(
      customerPhone, customerName || null, businessKey, twilioNumber, sqlDt
    );
    return result.lastInsertRowid;
  },

  findPendingReview(customerPhone, businessKey) {
    return findPendingReviewStmt.get(customerPhone, businessKey);
  },

  getReviewById(id) {
    return getReviewByIdStmt.get(id);
  },

  getDueReviewRequests() {
    return getDueReviewRequestsStmt.all();
  },

  markReviewSent(id, messageSid) {
    markReviewSentStmt.run(messageSid, id);
  },

  markReviewFailed(id, error) {
    markReviewFailedStmt.run(String(error), id);
  },

  markReviewSkipped(id, reason) {
    markReviewSkippedStmt.run(String(reason), id);
  },

  rescheduleReview(id, newScheduledAt) {
    const sqlDt = newScheduledAt instanceof Date
      ? newScheduledAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, "")
      : newScheduledAt;
    updateReviewScheduleStmt.run(sqlDt, id);
  },

  getReviewStats() {
    return getReviewStatsStmt.all();
  },

  /* -- Dashboard queries --------------------------------------------------- */

  /**
   * Return the N most recent leads across all clients.
   * @param {number} limit
   */
  getRecentLeads(limit = 20) {
    return getRecentLeadsStmt.all(limit);
  },

  /**
   * Return the next N pending follow-ups in chronological order.
   * @param {number} limit
   */
  getUpcomingFollowups(limit = 20) {
    return getUpcomingFollowupsStmt.all(limit);
  },

  /**
   * Return the N most recent outbound missed-call text-backs.
   * @param {number} limit
   */
  getRecentTextBacks(limit = 20) {
    return getRecentTextBacksStmt.all(limit);
  },
};
