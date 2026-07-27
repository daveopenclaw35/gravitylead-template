/* ============================================================================
 * GravityLead — SMS message templates
 * Each follow-up day (0, 3, 7, 30) has a default template + trade overrides.
 * Variables: {business_name}, {owner_name}, {business_phone}, {trade_service}
 * ========================================================================== */

const TRADE_SERVICES = {
  hvac: "heating, cooling, or AC service",
  roofing: "a roof inspection or repair",
  plumbing: "plumbing service",
  electrical: "electrical work",
  landscaping: "landscaping or lawn care",
  painting: "painting or exterior work",
  general: "home improvement or repair",
};

/* -- Templates by day ------------------------------------------------------ */

const TEMPLATES = {
  /* Day 0 — Immediate missed-call text-back (fires within seconds) */
  0: {
    default:
      "Hi! You just called {business_name}. Sorry we missed you — we're probably on another job. " +
      "How can we help? Reply here or call back at {business_phone}.\n\n" +
      "- {business_name}",
  },

  /* Day 3 — Warm follow-up */
  3: {
    default:
      "Hi, this is {business_name}. You reached out a few days ago and we want to make sure you got taken care of. " +
      "Still need help with {trade_service}? " +
      "Reply here or call us at {business_phone} — happy to help!\n\n" +
      "Reply STOP to opt out.",
  },

  /* Day 7 — Second touch */
  7: {
    default:
      "Hey, just checking in from {business_name}. If you still need {trade_service}, we'd love to help. " +
      "We offer free estimates — just reply YES and we'll get back to you right away.\n\n" +
      "Reply STOP to opt out.",
  },

  /* Day 30 — Long-term nurture */
  30: {
    default:
      "Hi from {business_name}! It's been a while since you reached out. " +
      "If you ever need {trade_service}, we're just a text away. Save this number!\n\n" +
      "- {business_name}\n" +
      "Reply STOP to opt out.",
  },
};

/* -- Renderer -------------------------------------------------------------- */

function renderTemplate(day, { business_name, owner_name, business_phone, trade }) {
  const dayTemplates = TEMPLATES[day];
  if (!dayTemplates) return null;

  const template = dayTemplates[trade] || dayTemplates.default;
  const tradeService = TRADE_SERVICES[trade] || TRADE_SERVICES.general;

  return template
    .replace(/\{business_name\}/g, business_name || "our team")
    .replace(/\{owner_name\}/g, owner_name || "")
    .replace(/\{business_phone\}/g, business_phone || "")
    .replace(/\{trade_service\}/g, tradeService);
}

module.exports = { renderTemplate, TEMPLATES, TRADE_SERVICES };
