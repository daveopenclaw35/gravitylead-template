"use strict";

/**
 * Regression tests: owner SMS alert on new missed-call leads.
 *
 * Requirements validated:
 *   1. A new missed call sends one customer acknowledgment AND one owner alert.
 *   2. An answered call (DialCallStatus=completed) sends NO owner alert.
 *   3. A duplicate callback (existing lead) does NOT send another owner alert.
 *   4. An owner-alert delivery failure does NOT break the customer workflow.
 *   5. Missing owner_phone is handled safely (no crash, no alert attempt).
 *
 * Isolation strategy
 * ──────────────────
 * `node --test` spawns a separate child process per test file, so this file
 * has its own require.cache and process.env from the start.  There is no
 * stale index.js cache to evict and no risk of a second HTTP listener.
 *
 * Setup (module-level, before any require of index.js):
 *   1. Save the original CLIENTS_PATH (may be undefined).
 *   2. Create a private temp directory with fs.mkdtempSync.
 *   3. Write a fixture clients.json into that temp dir.
 *   4. Point CLIENTS_PATH at that file.
 *   5. Stub all external modules via require.cache injection.
 *   6. Require index.js once — it reads the fixture, not the real file.
 *
 * Teardown (after() hook):
 *   1. Restore CLIENTS_PATH (delete if it was originally undefined).
 *   2. Remove the temp directory and all its contents.
 *
 * The real server/clients.json and /etc/secrets/clients.json are never read
 * or written.  Twilio is fully stubbed; no real SMS can be sent.
 */

const test   = require("node:test");
const assert = require("node:assert/strict");
const http   = require("node:http");
const fs     = require("node:fs");
const os     = require("node:os");
const path   = require("node:path");

// ── serverDir must be declared before it is used anywhere ─────────────────
const serverDir = path.resolve(__dirname, "..");

// ── Minimal env ────────────────────────────────────────────────────────────
process.env.TWILIO_ACCOUNT_SID     = "ACtest00000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN      = "test_token_xxxx";
process.env.API_KEY                = "test-api-key";
process.env.NODE_ENV               = "test";
process.env.SKIP_TWILIO_VALIDATION = "true";

// ── Preserve original CLIENTS_PATH so teardown can restore it exactly ─────
const priorClientsPath = process.env.CLIENTS_PATH;  // may be undefined

// ── Client fixtures ────────────────────────────────────────────────────────
const CLIENT_NUMBER   = "+12025550100";  // GravityLead/Twilio number (has owner_phone)
const NO_OWNER_NUMBER = "+12025550101";  // GravityLead/Twilio number (owner_phone absent)
const OWNER_PHONE     = "+12025550199";
const CALLER          = "+13125559876";

const fixtureClients = {
  [CLIENT_NUMBER]: {
    business_name: "Test Landscaping",
    owner_name:    "Owner Bob",
    owner_phone:   OWNER_PHONE,
    trade:         "landscaping",
    ring_timeout:  20,
  },
  [NO_OWNER_NUMBER]: {
    business_name: "No-Owner Landscaping",
    owner_name:    "Owner X",
    owner_phone:   "",   // deliberately empty — tests the missing-owner_phone path
    trade:         "landscaping",
    ring_timeout:  20,
  },
};

// ── Isolated temp directory (never overlaps with real config) ─────────────
// Using mkdtempSync gives us a unique directory that teardown can remove
// atomically.  The real server/clients.json and /etc/secrets/clients.json
// are never touched.
const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), "gl-owner-alert-test-"));
const tmpClients = path.join(tmpDir, "clients.json");
fs.writeFileSync(tmpClients, JSON.stringify(fixtureClients), "utf8");

// Point the application's client loader at the fixture BEFORE requiring index.js
process.env.CLIENTS_PATH = tmpClients;

// ── Stub helper ────────────────────────────────────────────────────────────
// Injects a value into require.cache under the real resolved module path.
function stubModule(relPath, value) {
  let resolved;
  try { resolved = require.resolve(path.join(serverDir, relPath)); }
  catch { try { resolved = require.resolve(relPath); } catch { return; } }
  require.cache[resolved] = {
    id:       resolved,
    filename: resolved,
    loaded:   true,
    exports:  value,
    children: [],
    paths:    [],
  };
}

// ── Mutable stub state ─────────────────────────────────────────────────────
// Tests mutate these before each request.  The stubs close over them so
// every call sees the current value without re-stubbing between tests.
let twilioCallLog           = [];
let dbFindRecentLeadResult  = null;   // null → new lead, object → duplicate
let ownerAlertShouldFail    = false;  // when true, owner send rejects (async throw)
let ownerAlertSyncThrow     = false;  // when true, messages.create throws synchronously

// ── Twilio stub ────────────────────────────────────────────────────────────
// All messages.create calls are recorded; no real HTTP is made.
const express = require("express");

const twilioStub = function () {
  return {
    messages: {
      create: (opts) => {
        twilioCallLog.push({ ...opts });
        if (ownerAlertSyncThrow && opts.to === OWNER_PHONE) {
          // Synchronous throw — simulates constructor or pre-flight failure
          throw new Error("Twilio stub error: synchronous throw from messages.create");
        }
        if (ownerAlertShouldFail && opts.to === OWNER_PHONE) {
          return Promise.reject(new Error("Twilio stub error: owner number unreachable"));
        }
        return Promise.resolve({ sid: `SMstub${twilioCallLog.length}`, status: "queued" });
      },
    },
  };
};
twilioStub.validateRequest = () => true;
twilioStub.twiml = {
  VoiceResponse: class {
    dial()     { return { number() {} }; }
    say()      {}
    hangup()   {}
    toString() { return "<Response/>"; }
  },
  MessagingResponse: class {
    message() {}
    toString() { return "<Response/>"; }
  },
};
stubModule("twilio", twilioStub);

// ── Other dependency stubs ─────────────────────────────────────────────────
stubModule("./db", {
  findRecentLead:        () => dbFindRecentLeadResult,
  createLead:            () => 42,
  scheduleFollowups:     () => {},
  getDueFollowups:       () => [],
  markSent:              () => {},
  logSms:                () => {},
  optOut:                () => {},
  isOptedOut:            () => false,
  findLead:              () => null,
  pauseFollowupsForLead: () => 0,
  getLeadById:           () => null,
  getStats:              () => [],
  getReviewStats:        () => [],
  getReviewById:         () => null,
  startBackupScheduler:  () => {},
});
stubModule("./followup", { init: () => {}, startScheduler: () => {} });
stubModule("./review", {
  init: () => {}, startScheduler: () => {},
  scheduleReview: async () => ({ sent: false, review_id: 1 }),
  sendReviewById: async () => ({ sent: false }),
});
stubModule("./reports", {
  init: () => {}, startScheduler: () => {},
  previousMonth:     () => ({ year: 2026, month: 8 }),
  monthLabel:        () => "August 2026",
  sendMonthlyReport: async () => ({ sent: true }),
  sendAllReports:    async () => ({ total: 0, sent: 0, failed: 0, results: [] }),
});
stubModule("./dashboard",     { init: () => {}, router: express.Router() });
stubModule("./ops-dashboard", { init: () => {}, router: express.Router() });
stubModule("./telegram-bot",  { init: () => {}, start: () => {} });
stubModule("./templates",     { renderTemplate: () => "stub customer message" });
stubModule("./sms-policy", {
  normalizePhone:      (p) => p || null,
  parseOwnerReply:     () => null,
  canSendAutomatedSms: () => true,
});

// ── Load index.js — exactly once, in this isolated process ────────────────
// All stubs and CLIENTS_PATH are in place before this call.
// index.js reads the fixture clients.json (not the real one).
// The express listen() intercept below prevents an actual port bind.
let capturedApp = null;
const _origListen = express.application.listen;
express.application.listen = function (...args) {
  capturedApp = this;
  const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
  if (cb) cb();
  return { close: () => {} };
};
require("../index.js");
express.application.listen = _origListen;

// ── Teardown ───────────────────────────────────────────────────────────────
// Runs after all tests in this file complete.
// Restores CLIENTS_PATH exactly: removes the key if it was originally absent.
const { after } = require("node:test");
after(() => {
  if (priorClientsPath === undefined) {
    delete process.env.CLIENTS_PATH;
  } else {
    process.env.CLIENTS_PATH = priorClientsPath;
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── HTTP helper ────────────────────────────────────────────────────────────
function postVoiceStatus(server, fields) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(fields).toString();
    const req  = http.request(
      {
        hostname: "127.0.0.1",
        port:     server.address().port,
        path:     "/twilio/voice/status",
        method:   "POST",
        headers:  {
          "content-type":       "application/x-www-form-urlencoded",
          "content-length":     Buffer.byteLength(body),
          "x-twilio-signature": "skip",  // bypassed via SKIP_TWILIO_VALIDATION
        },
      },
      (res) => {
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Drain the microtask / macrotask queue so that fire-and-forget
// Promise chains (void Promise.resolve().then(...)) have a chance to
// resolve before test assertions run.
function drainAsync() {
  return new Promise(r => setImmediate(r));
}

// Helper: spin up a fresh http.Server for one test, tear it down after.
async function withServer(fn) {
  assert.ok(capturedApp, "Express app must be captured before tests run");
  const server = http.createServer(capturedApp).listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  try {
    await fn(server);
  } finally {
    await new Promise(r => server.close(r));
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("1. New missed call → one customer acknowledgment + one owner alert", async () => {
  twilioCallLog          = [];
  dbFindRecentLeadResult = null;
  ownerAlertShouldFail   = false;

  await withServer(async (server) => {
    const res = await postVoiceStatus(server, {
      DialCallStatus: "no-answer",
      From:           CALLER,
      To:             CLIENT_NUMBER,
      CallSid:        "CA_test_new_missed",
    });
    await drainAsync();

    assert.equal(res.status, 200, "HTTP 200");
    assert.ok(res.body.includes("<Response"), "TwiML response returned");

    assert.equal(twilioCallLog.length, 2, "Exactly 2 Twilio sends (customer + owner)");

    const customerMsg = twilioCallLog.find(m => m.to === CALLER);
    assert.ok(customerMsg,                      "Customer acknowledgment sent to caller");
    assert.equal(customerMsg.from, CLIENT_NUMBER, "Customer msg sent from GravityLead number");

    const ownerMsg = twilioCallLog.find(m => m.to === OWNER_PHONE);
    assert.ok(ownerMsg,                         "Owner alert sent to owner_phone");
    assert.equal(ownerMsg.from, CLIENT_NUMBER,    "Owner alert from GravityLead number");
    assert.ok(ownerMsg.body.includes(CALLER),    "Owner alert body contains caller number");
    assert.ok(ownerMsg.body.includes("⚡"),       "Owner alert uses expected ⚡ prefix");
  });
});

test("2. Answered call (DialCallStatus=completed) → no owner alert", async () => {
  twilioCallLog          = [];
  dbFindRecentLeadResult = null;
  ownerAlertShouldFail   = false;

  await withServer(async (server) => {
    const res = await postVoiceStatus(server, {
      DialCallStatus: "completed",
      From:           CALLER,
      To:             CLIENT_NUMBER,
      CallSid:        "CA_test_answered",
    });
    await drainAsync();

    assert.equal(res.status, 200, "HTTP 200");
    assert.equal(twilioCallLog.length, 0, "No Twilio sends for an answered call");
  });
});

test("3. Duplicate callback (lead already exists) → no additional owner alert", async () => {
  twilioCallLog          = [];
  dbFindRecentLeadResult = { id: 7 };  // existing lead — triggers early-return path
  ownerAlertShouldFail   = false;

  await withServer(async (server) => {
    const res = await postVoiceStatus(server, {
      DialCallStatus: "no-answer",
      From:           CALLER,
      To:             CLIENT_NUMBER,
      CallSid:        "CA_test_dup",
    });
    await drainAsync();

    assert.equal(res.status, 200, "HTTP 200");
    // Handler returns before createLead / alert block when duplicate detected
    assert.equal(twilioCallLog.length, 0, "No Twilio sends for duplicate callback");
  });
});

test("4. Owner-alert delivery failure does not break the customer workflow", async () => {
  twilioCallLog          = [];
  dbFindRecentLeadResult = null;
  ownerAlertShouldFail   = true;   // owner send will throw; customer send succeeds

  await withServer(async (server) => {
    const res = await postVoiceStatus(server, {
      DialCallStatus: "busy",
      From:           CALLER,
      To:             CLIENT_NUMBER,
      CallSid:        "CA_test_alert_fail",
    });
    await drainAsync();

    // Webhook must still return 200 with valid TwiML despite the thrown error
    assert.equal(res.status, 200,             "HTTP 200 even when owner alert throws");
    assert.ok(res.body.includes("<Response"), "TwiML response returned");

    // Customer text-back was still sent successfully
    const customerMsg = twilioCallLog.find(m => m.to === CALLER);
    assert.ok(customerMsg, "Customer acknowledgment sent despite owner-alert failure");

    // Owner send was attempted (it threw, but the attempt was made and logged)
    const ownerAttempt = twilioCallLog.find(m => m.to === OWNER_PHONE);
    assert.ok(ownerAttempt, "Owner alert was attempted before throwing");
  });

  ownerAlertShouldFail = false;  // restore for any subsequent tests
});

test("6. Synchronous throw from messages.create does not break the customer workflow", async () => {
  twilioCallLog          = [];
  dbFindRecentLeadResult = null;
  ownerAlertShouldFail   = false;
  ownerAlertSyncThrow    = true;   // messages.create throws synchronously for owner

  await withServer(async (server) => {
    const res = await postVoiceStatus(server, {
      DialCallStatus: "no-answer",
      From:           CALLER,
      To:             CLIENT_NUMBER,
      CallSid:        "CA_test_sync_throw",
    });
    await drainAsync();

    // Webhook must still return 200 with valid TwiML despite synchronous throw
    assert.equal(res.status, 200,             "HTTP 200 even when messages.create throws synchronously");
    assert.ok(res.body.includes("<Response"), "TwiML response returned");

    // Customer text-back was still sent successfully
    const customerMsg = twilioCallLog.find(m => m.to === CALLER);
    assert.ok(customerMsg, "Customer acknowledgment sent despite synchronous throw");
  });

  ownerAlertSyncThrow = false;  // restore
});

test("5. Missing owner_phone → no crash, no alert attempt, customer still notified", async () => {
  twilioCallLog          = [];
  dbFindRecentLeadResult = null;
  ownerAlertShouldFail   = false;

  await withServer(async (server) => {
    // Post to the no-owner-phone client number (owner_phone: "")
    const res = await postVoiceStatus(server, {
      DialCallStatus: "no-answer",
      From:           CALLER,
      To:             NO_OWNER_NUMBER,
      CallSid:        "CA_test_no_owner_phone",
    });
    await drainAsync();

    assert.equal(res.status, 200,             "HTTP 200 when owner_phone missing");
    assert.ok(res.body.includes("<Response"), "TwiML response returned");

    // Customer text-back still sent
    const customerMsg = twilioCallLog.find(m => m.to === CALLER);
    assert.ok(customerMsg, "Customer acknowledgment sent when owner_phone is missing");

    // No attempt to call Twilio with an empty/undefined to-address
    const badAlert = twilioCallLog.find(m => !m.to || m.to === "");
    assert.ok(!badAlert, "No alert sent to empty owner_phone");

    // Exactly one Twilio call total (customer message only)
    assert.equal(twilioCallLog.length, 1, "Exactly 1 Twilio send (customer only)");
  });
});
