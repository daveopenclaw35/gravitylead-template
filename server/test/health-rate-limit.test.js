"use strict";

/**
 * Regression test: /health must NOT be subject to the general 60-req/15-min
 * rate limit so that uptime monitors never receive a 429 response.
 *
 * Strategy: build the Express app directly with a minimal environment stub,
 * then fire 65 rapid GET /health requests and assert every one returns 200.
 * We stub external dependencies via require.cache before loading index.js.
 */

const test   = require("node:test");
const assert = require("node:assert/strict");
const http   = require("node:http");
const fs     = require("node:fs");
const os     = require("node:os");
const path   = require("node:path");

// ── Minimal env so index.js startup guards pass ────────────────────────────
process.env.TWILIO_ACCOUNT_SID     = "ACtest00000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN      = "test_auth_token_xxxxxxxxxxxxxxxxxx";
process.env.API_KEY                = "test-api-key";
process.env.NODE_ENV               = "test";
process.env.SKIP_TWILIO_VALIDATION = "true";

// Point CLIENTS_PATH at a temp file with an empty config
const tmpClients = path.join(os.tmpdir(), `clients-test-${process.pid}.json`);
fs.writeFileSync(tmpClients, JSON.stringify({}));
process.env.CLIENTS_PATH = tmpClients;

// ── Helper: inject a value into require.cache under a real resolved path ──
const serverDir = path.resolve(__dirname, "..");

function stubModule(relPath, value) {
  // Resolve the module path exactly as Node would from serverDir
  let resolved;
  try {
    resolved = require.resolve(path.join(serverDir, relPath));
  } catch {
    try {
      resolved = require.resolve(relPath); // bare package name
    } catch {
      return; // best-effort — if it can't be resolved, skip
    }
  }
  require.cache[resolved] = {
    id:       resolved,
    filename: resolved,
    loaded:   true,
    exports:  value,
    children: [],
    paths:    [],
  };
}

// ── Stubs ──────────────────────────────────────────────────────────────────
const express = require("express");

// twilio (npm package)
const twilioStub = function () {
  return { messages: { create: async () => ({}) } };
};
twilioStub.validateRequest = () => true;
twilioStub.twiml = {
  VoiceResponse:     class {
    dial() { return { number() {} }; }
    say() {} hangup() {} toString() { return "<Response/>"; }
  },
  MessagingResponse: class {
    message() {} toString() { return "<Response/>"; }
  },
};
stubModule("twilio", twilioStub);

// Local server modules
stubModule("./db", {
  findRecentLead:        () => null,
  createLead:            () => 1,
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
stubModule("./followup", {
  init:           () => {},
  startScheduler: () => {},
});
stubModule("./review", {
  init:           () => {},
  startScheduler: () => {},
  scheduleReview: async () => ({ sent: false, review_id: 1 }),
  sendReviewById: async () => ({ sent: false }),
});
stubModule("./reports", {
  init:              () => {},
  startScheduler:    () => {},
  previousMonth:     () => ({ year: 2026, month: 8 }),
  monthLabel:        () => "August 2026",
  sendMonthlyReport: async () => ({ sent: true }),
  sendAllReports:    async () => ({ total: 0, sent: 0, failed: 0, results: [] }),
});
stubModule("./dashboard", {
  init:   () => {},
  router: express.Router(),
});
stubModule("./ops-dashboard", {
  init:   () => {},
  router: express.Router(),
});
stubModule("./telegram-bot", {
  init:  () => {},
  start: () => {},
});
stubModule("./templates", {
  renderTemplate: () => "stub template",
});
stubModule("./sms-policy", {
  normalizePhone:      (p) => p || null,
  parseOwnerReply:     () => null,
  canSendAutomatedSms: () => true,
});

// ── Load server app, capturing it before listen() fires ───────────────────
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

// ── Regression test ────────────────────────────────────────────────────────
test("/health is exempt from the general rate limiter (65 rapid requests → all 200)", async () => {
  assert.ok(capturedApp, "Express app was captured from listen()");

  const server = http.createServer(capturedApp);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const REQUESTS = 65; // well above the 60-req/15-min general limit

  const results = await Promise.all(
    Array.from({ length: REQUESTS }, () =>
      new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on("error", reject);
      })
    )
  );

  await new Promise(resolve => server.close(resolve));
  try { fs.unlinkSync(tmpClients); } catch { /* best-effort */ }

  const non200 = results.filter(s => s !== 200);
  assert.strictEqual(
    non200.length,
    0,
    `Expected all ${REQUESTS} /health responses to be 200, got non-200: ${non200.join(", ")}`
  );
});
