"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const os     = require("node:os");
const path   = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gravitylead-pause-test-"));
process.env.GRAVITYLEAD_DB_PATH = path.join(tempDir, "test.db");

const store = require("../db");

test.after(() => {
  store.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const BIZ_KEY = "+16075550099";

test("pauseFollowupsForLead suspends pending follow-ups without opting the lead out", () => {
  const phone  = "+16075559001";
  const leadId = store.createLead({
    phone, name: "Pause Test", business_key: BIZ_KEY,
    twilio_number: BIZ_KEY, source: "missed_call", notes: "",
  });
  store.scheduleFollowups(leadId);

  // Simulate a lead reply — pause their sequence
  const paused = store.pauseFollowupsForLead(leadId);
  assert.ok(paused > 0, "should have paused at least one pending follow-up");

  // Lead must NOT be opted out — manual owner replies must still work
  assert.equal(store.isOptedOut(phone), false, "lead should not be marked opted-out");

  // The scheduler must see zero pending follow-ups for this lead
  const due = store.getDueFollowups().filter(f => f.lead_id === Number(leadId));
  assert.equal(due.length, 0, "no follow-ups should be due after pause");
});

test("pauseFollowupsForLead only affects the specific lead, not others", () => {
  const phone1 = "+16075559002";
  const phone2 = "+16075559003";

  const id1 = store.createLead({ phone: phone1, business_key: BIZ_KEY, twilio_number: BIZ_KEY, source: "form", notes: "" });
  const id2 = store.createLead({ phone: phone2, business_key: BIZ_KEY, twilio_number: BIZ_KEY, source: "form", notes: "" });
  store.scheduleFollowups(id1);
  store.scheduleFollowups(id2);

  // Pause only lead 1
  const paused = store.pauseFollowupsForLead(id1);
  assert.ok(paused > 0, "lead 1 follow-ups should be paused");

  // Lead 2 must be unaffected
  const due = store.getDueFollowups();
  assert.equal(due.filter(f => f.lead_id === Number(id1)).length, 0, "lead 1 has no due follow-ups");
  // Lead 2 has day-0 scheduled at creation time, so it IS due — confirm it still appears
  assert.ok(due.filter(f => f.lead_id === Number(id2)).length > 0, "lead 2 follow-ups still pending");
});

test("db.backup() creates a non-empty database copy", () => {
  const backupPath = path.join(tempDir, "gravitylead-backup-test.db");
  store.backup(backupPath);
  assert.ok(fs.existsSync(backupPath), "backup file should exist");
  assert.ok(fs.statSync(backupPath).size > 0, "backup file should not be empty");
});
