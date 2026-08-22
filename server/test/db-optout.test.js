"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gravitylead-test-"));
process.env.GRAVITYLEAD_DB_PATH = path.join(tempDir, "test.db");
const store = require("../db");

test.after(() => {
  store.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("STOP marks the phone opted out and cancels pending follow-ups", () => {
  const phone = "+16075551234";
  const leadId = store.createLead({
    phone,
    name: "Test Lead",
    business_key: "+16075550000",
    twilio_number: "+16075550000",
    source: "form",
    notes: "test",
  });
  store.scheduleFollowups(leadId);
  store.optOut(phone);

  assert.equal(store.isOptedOut(phone), true);
  assert.equal(store.getDueFollowups().length, 0);
});
