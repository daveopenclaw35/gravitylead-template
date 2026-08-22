"use strict";

function normalizePhone(raw) {
  if (!raw || typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

function parseOwnerReply(body) {
  const match = String(body || "").trim().match(/^#(\d+)\s+([\s\S]+)$/);
  if (!match) return null;
  const message = match[2].trim().slice(0, 1500);
  if (!message) return null;
  return { leadId: Number(match[1]), message };
}

function canSendAutomatedSms(db, phone) {
  return Boolean(phone) && !db.isOptedOut(phone);
}

module.exports = { normalizePhone, parseOwnerReply, canSendAutomatedSms };
