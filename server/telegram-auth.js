"use strict";

function isAuthorizedOwner(fromId, ownerId) {
  const configuredOwner = String(ownerId || "").trim();
  return Boolean(configuredOwner) && String(fromId ?? "") === configuredOwner;
}

module.exports = { isAuthorizedOwner };
