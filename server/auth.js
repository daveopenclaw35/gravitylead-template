/* ============================================================================
 * GravityLead — Shared Dashboard Auth
 *
 * A single in-memory session store shared by /dashboard and /ops.
 * Logging into either UI authenticates both (same cookie, same token pool).
 *
 * Usage:
 *   const auth = require("./auth");
 *   // In a route handler:
 *   const tok = auth.mkToken();
 *   auth.applyCookie(res, tok, isHttps);
 *   // Guard middleware:
 *   router.get("/", auth.guard("/your/login"), handler);
 * ========================================================================== */
"use strict";

const crypto = require("crypto");

const COOKIE      = "gl_sess";
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 h
const sessions    = new Map();             // token → expiresAt

/* ── Session helpers ────────────────────────────────────────────────────────── */
function mkToken() {
  const t = crypto.randomBytes(32).toString("hex");
  sessions.set(t, Date.now() + SESSION_TTL);
  return t;
}

function okToken(t) {
  if (!t || !sessions.has(t)) return false;
  if (Date.now() > sessions.get(t)) { sessions.delete(t); return false; }
  return true;
}

function rmToken(t) { sessions.delete(t); }

// Purge expired sessions hourly
setInterval(() => {
  const now = Date.now();
  for (const [t, e] of sessions) if (now > e) sessions.delete(t);
}, 3_600_000);

/* ── Cookie helpers ─────────────────────────────────────────────────────────── */
function parseCookies(req) {
  const out = {};
  for (const s of (req.headers.cookie || "").split(";")) {
    const [k, ...v] = s.split("=");
    if (k?.trim()) out[k.trim()] = v.join("=").trim();
  }
  return out;
}

function applyCookie(res, tok, isHttps) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${tok}; Max-Age=${SESSION_TTL / 1000 | 0}; Path=/; HttpOnly; SameSite=Strict` +
    (isHttps ? "; Secure" : "")
  );
}

function wipeCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`);
}

/**
 * Returns an Express middleware guard.
 *
 * For unauthenticated requests:
 *   - API/XHR requests  → 401 JSON { error: "unauthorized", login }
 *   - Normal page loads → 302 redirect to `loginPath`
 *
 * The API branch prevents SPA fetches from silently following a 302 to the
 * login HTML page (which the frontend then fails to JSON-parse, hanging the
 * loading spinner forever). A clean 401 lets the client redirect the whole
 * page to login instead.
 *
 * @param {string} loginPath  e.g. "/dashboard/login" or "/ops/login"
 */
function wantsJson(req) {
  // API path, XHR header, or explicit JSON Accept → treat as programmatic.
  if (req.path && req.path.includes("/api/")) return true;
  if ((req.get && req.get("X-Requested-With")) === "XMLHttpRequest") return true;
  const accept = (req.get && req.get("Accept")) || "";
  return accept.includes("application/json");
}

function guard(loginPath) {
  return (req, res, next) => {
    if (okToken(parseCookies(req)[COOKIE])) return next();
    if (wantsJson(req)) {
      return res.status(401).json({ error: "unauthorized", login: loginPath });
    }
    res.redirect(loginPath);
  };
}

module.exports = { mkToken, okToken, rmToken, parseCookies, applyCookie, wipeCookie, guard, wantsJson, COOKIE };
