"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhone, parseOwnerReply, canSendAutomatedSms } = require("../sms-policy");

test("normalizes US phone numbers", () => {
  assert.equal(normalizePhone("(607) 555-1234"), "+16075551234");
  assert.equal(normalizePhone("1-607-555-1234"), "+16075551234");
  assert.equal(normalizePhone("123"), null);
});

test("owner reply requires an explicit lead id", () => {
  assert.deepEqual(parseOwnerReply("#123 Thanks, we can help."), {
    leadId: 123,
    message: "Thanks, we can help.",
  });
  assert.equal(parseOwnerReply("Thanks, we can help."), null);
  assert.equal(parseOwnerReply("#123"), null);
});

test("automated SMS fails closed for opted-out numbers", () => {
  assert.equal(canSendAutomatedSms({ isOptedOut: () => true }, "+16075551234"), false);
  assert.equal(canSendAutomatedSms({ isOptedOut: () => false }, "+16075551234"), true);
  assert.equal(canSendAutomatedSms({ isOptedOut: () => false }, null), false);
});
