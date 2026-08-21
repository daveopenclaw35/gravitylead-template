"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isAuthorizedOwner } = require("../telegram-auth");

test("Telegram authorization fails closed when owner id is missing", () => {
  assert.equal(isAuthorizedOwner("123", ""), false);
  assert.equal(isAuthorizedOwner("123", undefined), false);
});

test("Telegram authorization accepts only the configured owner", () => {
  assert.equal(isAuthorizedOwner("123", "123"), true);
  assert.equal(isAuthorizedOwner("456", "123"), false);
});
