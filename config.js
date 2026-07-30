/* ============================================================================
 * GravityLead — Trade-Skin Config Engine
 * getgravitylead.com
 * ----------------------------------------------------------------------------
 * HOW TO USE:
 *   Change ONE line below:  const ACTIVE_TRADE = "hvac";
 *   Options: "hvac" | "roofing" | "plumbing"
 *   Everything on the site (copy, colors, services, FAQs, chat behavior)
 *   re-skins automatically. No build step. Just save + reload.
 *
 * To white-label for a real client, either:
 *   (a) pick a trade skin below and override business.* fields, or
 *   (b) add a new key to TRADES and set ACTIVE_TRADE to it.
 * ========================================================================== */

const ACTIVE_TRADE = "hvac"; // <-- CHANGE THIS: "hvac" | "roofing" | "plumbing"

/* ---------- Google Analytics 4 ------------------------------------------
 * Set ANALYTICS_ID to this client's GA4 Measurement ID (format: G-XXXXXXXX).
 * Create a new GA4 property for each client at analytics.google.com, then
 * copy the Measurement ID from Admin → Data Streams → your stream.
 * Leave as "G-XXXXXXXXXX" to disable tracking (safe for local dev / demos).
 * ----------------------------------------------------------------------- */
const ANALYTICS_ID = "G-XXXXXXXXXX"; // ← Replace with client's GA4 Measurement ID

const BRAND = {
  name: "GravityLead",
  domain: "getgravitylead.com",
  tagline: "The AI receptionist that captures every lead — even after hours.",
  poweredBy: "Powered by GravityLead",
};

const TRADES = {
  /* ------------------------------------------------------------------ HVAC */
  hvac: {
    business: {
      name: "Summit Air & Heating",
      phone: "(555) 302-4471",
      city: "Columbus, OH",
      hours: "Mon–Sat 7am–7pm · 24/7 Emergency",
      license: "OH HVAC Lic. #48291",
    },
    theme: {
      primary: "#1f6feb",     // cool blue = air/cooling
      primaryDark: "#124a9c",
      accent: "#ff7a18",      // warm orange = heating
      bg: "#0e1621",
      surface: "#16202e",
      text: "#e8eef6",
      muted: "#9fb0c3",
    },
    hero: {
      eyebrow: "Heating & Cooling Experts",
      headline: "Fast, honest HVAC service — done right the first time.",
      sub: "Same-day repairs, upfront pricing, and 24/7 emergency service. Book online in 30 seconds.",
      cta: "Book a Service Call",
      cta2: "Get a Free Estimate",
      image: "🌡️",
    },
    services: [
      { icon: "❄️", title: "AC Repair & Install", desc: "Cooling out? Same-day diagnostics and honest fixes." },
      { icon: "🔥", title: "Furnace & Heating", desc: "Repairs, tune-ups, and high-efficiency replacements." },
      { icon: "💨", title: "Air Quality", desc: "Filtration, humidifiers, and duct cleaning." },
      { icon: "🛠️", title: "Maintenance Plans", desc: "Seasonal tune-ups that prevent breakdowns." },
    ],
    trust: ["Licensed & Insured", "Upfront Pricing", "24/7 Emergency", "5-Star Local Rated"],
    faqs: [
      { q: "Do you offer emergency service?", a: "Yes — 24/7. If your AC or furnace fails, we dispatch same day." },
      { q: "How much is a service call?", a: "Diagnostic visits start at $89, applied to any repair you approve." },
      { q: "Do you give free estimates?", a: "Free estimates on all replacements and installs." },
    ],
    chat: {
      greeting: "Hi! 👋 Summit Air here. Is this an AC issue, heating issue, or a new install estimate?",
      quickReplies: ["AC not cooling", "No heat", "Get an estimate", "Book a tune-up"],
      qualifiers: ["What's your ZIP code?", "Is this an emergency (no cooling/heat right now)?", "What's the best phone number to text you a confirmation?"],
      capture: "Got it — I've logged your request and a Summit tech will text you within 15 minutes to confirm a time. Anything else?",
    },
  },

  /* --------------------------------------------------------------- ROOFING */
  roofing: {
    business: {
      name: "Ironclad Roofing Co.",
      phone: "(555) 881-2093",
      city: "Denver, CO",
      hours: "Mon–Sat 7am–6pm · Storm response 24/7",
      license: "CO Roofing Lic. #RC-77120",
    },
    theme: {
      primary: "#c0392b",     // slate red
      primaryDark: "#8f2114",
      accent: "#2d9c5a",
      bg: "#161311",
      surface: "#221c18",
      text: "#f4ece6",
      muted: "#c3ad9f",
    },
    hero: {
      eyebrow: "Roofing & Storm Damage Specialists",
      headline: "A roof you can trust — inspected, repaired, replaced.",
      sub: "Free storm-damage inspections, insurance-claim help, and workmanship warranties. Book online now.",
      cta: "Book a Free Inspection",
      cta2: "Get a Roof Quote",
      image: "🏠",
    },
    services: [
      { icon: "🌧️", title: "Storm Damage Repair", desc: "Fast response after hail and wind. We handle the claim." },
      { icon: "🔨", title: "Roof Replacement", desc: "Asphalt, metal, and tile — warrantied installs." },
      { icon: "🔍", title: "Free Inspections", desc: "Honest assessments with photo documentation." },
      { icon: "🧾", title: "Insurance Claims", desc: "We work directly with your adjuster." },
    ],
    trust: ["Licensed & Insured", "Insurance-Claim Experts", "Workmanship Warranty", "Local & Trusted"],
    faqs: [
      { q: "Do you do free inspections?", a: "Yes — free, no-obligation inspections with photo report." },
      { q: "Can you help with my insurance claim?", a: "Absolutely. We meet your adjuster and document everything." },
      { q: "How long does a replacement take?", a: "Most homes are completed in 1–2 days." },
    ],
    chat: {
      greeting: "Hey! 👋 Ironclad Roofing. Are you dealing with storm damage, a leak, or planning a replacement?",
      quickReplies: ["Storm/hail damage", "Roof leak", "Need a quote", "Free inspection"],
      qualifiers: ["What's your address or ZIP?", "Do you have visible damage or a leak right now?", "Best phone number to text your inspection time?"],
      capture: "Perfect — your free inspection request is logged. An Ironclad rep will text you within 15 minutes to schedule. Anything else?",
    },
  },

  /* -------------------------------------------------------------- PLUMBING */
  plumbing: {
    business: {
      name: "BlueFlow Plumbing",
      phone: "(555) 447-6610",
      city: "Austin, TX",
      hours: "Mon–Sun 6am–9pm · 24/7 Emergency",
      license: "TX Plumbing Lic. #M-41902",
    },
    theme: {
      primary: "#0e9aa7",     // teal water
      primaryDark: "#0a6f78",
      accent: "#f6a623",
      bg: "#0c1618",
      surface: "#122226",
      text: "#e6f2f3",
      muted: "#9bbcc0",
    },
    hero: {
      eyebrow: "Licensed Plumbing Experts",
      headline: "Leaks, clogs, emergencies — fixed fast, priced fair.",
      sub: "24/7 emergency plumbing, upfront flat-rate pricing, and same-day service. Book in 30 seconds.",
      cta: "Book a Plumber",
      cta2: "Get a Free Quote",
      image: "🚰",
    },
    services: [
      { icon: "💧", title: "Leak & Pipe Repair", desc: "Fast leak detection and lasting repairs." },
      { icon: "🚽", title: "Drains & Clogs", desc: "Hydro-jetting and camera inspections." },
      { icon: "🔥", title: "Water Heaters", desc: "Repair, tankless upgrades, same-day installs." },
      { icon: "🚨", title: "24/7 Emergency", desc: "Burst pipe? We're on the way, day or night." },
    ],
    trust: ["Licensed & Insured", "Flat-Rate Pricing", "24/7 Emergency", "Satisfaction Guaranteed"],
    faqs: [
      { q: "Do you charge by the hour?", a: "No — flat-rate pricing. You approve the price before we start." },
      { q: "Do you handle emergencies?", a: "Yes, 24/7. Burst pipes and major leaks get priority dispatch." },
      { q: "Are estimates free?", a: "Free quotes on installs and non-emergency work." },
    ],
    chat: {
      greeting: "Hi there! 👋 BlueFlow Plumbing. Is this an emergency (burst pipe/flooding), a leak, or a clog?",
      quickReplies: ["Emergency / flooding", "Leak", "Clogged drain", "Water heater"],
      qualifiers: ["What's your ZIP code?", "Is water actively leaking or flooding right now?", "Best number to text your appointment confirmation?"],
      capture: "Got it — your request is logged and a BlueFlow plumber will text you within 15 minutes to confirm. Anything else?",
    },
  },
};

/* --------- Resolver: exposes the active skin globally, no build step -------- */
const SKIN = Object.assign({}, TRADES[ACTIVE_TRADE], { brand: BRAND, tradeKey: ACTIVE_TRADE });
window.GRAVITYLEAD = SKIN;
