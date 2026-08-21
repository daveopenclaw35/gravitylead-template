"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { renderDemo, isPrivateAddress, assertSafePublicUrl } = require("../demo-builder");

test("blocks private and loopback addresses", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.0.0.8"), true);
  assert.equal(isPrivateAddress("192.168.1.2"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  await assert.rejects(assertSafePublicUrl("http://localhost:3000"), /private network/i);
});

test("generated demo inline handlers contain valid JavaScript", () => {
  const html = renderDemo({
    businessName: "Test HVAC",
    phone: "(607) 555-1234",
    description: "Fast local service.",
    trade: "hvac",
  });
  const handlers = [...html.matchAll(/onclick="([^"]+)"/g)].map(match => match[1]);
  assert.ok(handlers.length >= 3);
  for (const handler of handlers) assert.doesNotThrow(() => new Function(handler));
});
