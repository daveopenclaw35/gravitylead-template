/* ============================================================================
 * GravityLead — Client Demo Config
 * Client: Rock Solid Landscaping
 * Site:   rocksolidsignaturebuilds.com
 * Phone:  (607) 427-6032
 * Area:   Southern Tier, NY (Binghamton / Ithaca / Cortland region)
 * Built:  2026-08-03
 * ========================================================================== */

const ACTIVE_TRADE = "landscaping";
const ANALYTICS_ID = "G-XXXXXXXXXX"; // ← Replace with client GA4 ID at onboarding

const BRAND = {
  name: "GravityLead",
  domain: "getgravitylead.com",
  tagline: "The AI receptionist that captures every lead — even after hours.",
  poweredBy: "Powered by GravityLead",
};

const TRADES = {
  landscaping: {
    business: {
      name: "Rock Solid Landscaping",
      phone: "(607) 427-6032",
      city: "Southern Tier, NY",
      hours: "Mon–Sat 8am–6pm · Free Estimates",
      license: "Fully Insured · Serving Binghamton, Ithaca & Surrounding Areas",
    },
    theme: {
      primary:      "#2D6A4F",   // deep forest green
      primaryDark:  "#1B4332",
      accent:       "#C8963E",   // warm amber / natural stone
      bg:           "#0D1A0F",   // near-black with a green tint
      surface:      "#142918",
      text:         "#E8F5E9",
      muted:        "#8BA898",
    },
    hero: {
      eyebrow: "Custom Hardscape & Outdoor Living · Southern Tier, NY",
      headline: "Signature stonework, patios & timber builds — crafted to outlast.",
      sub: "From backyard patios to custom timber frames, Rock Solid transforms your outdoor space into something you'll love for decades. Free estimates. No pressure. Just great work.",
      cta: "Get a Free Estimate",
      cta2: "Explore Our Services",
      image: "🪨",
    },
    services: [
      { icon: "🪵", title: "Timber Frame Buildings & Decks",  desc: "Handcrafted timber frame structures and decks built for lasting beauty and Southern Tier winters." },
      { icon: "🧱", title: "Custom Concrete Work",             desc: "Driveways, walkways, decorative pours — precision work that holds up year after year." },
      { icon: "🔥", title: "Stone Walls & Fireplaces",         desc: "Natural stone walls and outdoor fireplaces that define your property and extend your season." },
      { icon: "💧", title: "Waterfalls & Water Features",      desc: "Ponds, pondless waterfalls, and custom water features — the backyard oasis you've been imagining." },
      { icon: "🪨", title: "Custom Stonework",                 desc: "Hand-laid stone accents, retaining walls, steps, and facades built for decades of character." },
      { icon: "⬜", title: "Pavers & Patios",                  desc: "Paver patios, walkways, and outdoor entertaining spaces that instantly upgrade curb appeal." },
    ],
    trust: [
      "Free Estimates — Always",
      "Fully Insured",
      "Natural Stone Specialists",
      "Serving Southern Tier Since Day One",
    ],
    faqs: [
      {
        q: "Do you offer free estimates?",
        a: "Absolutely — always free, no obligation. We come to your property, see the space, and give you a detailed quote.",
      },
      {
        q: "What areas do you serve?",
        a: "We cover the Southern Tier: Binghamton, Ithaca, Cortland, Endicott, Vestal, and surrounding communities. Not sure? Just ask.",
      },
      {
        q: "How long does a typical project take?",
        a: "Most patio and stonework projects wrap in 3–7 days. Larger timber frame builds typically run 1–3 weeks depending on scope.",
      },
      {
        q: "Do you do both residential and commercial?",
        a: "Primarily residential. We do select commercial and hospitality projects — reach out and we'll let you know.",
      },
    ],
    chat: {
      greeting: "Hi! 👋 Rock Solid Landscaping here — Southern Tier's hardscape specialists. Are you looking for a patio, deck, stone wall, water feature, or something else?",
      quickReplies: ["Patio or pavers", "Deck or timber frame", "Stone wall / fireplace", "Free estimate"],
      qualifiers: [
        "What's your town or ZIP code?",
        "What's the project — patio, deck, stone wall, something else?",
        "Best number to text your free estimate to?",
      ],
      capture: "Perfect — your request is in. Someone from Rock Solid will text you within the hour to schedule your free on-site estimate. Talk soon! 👊",
    },
  },
};

/* --------- Resolver -------- */
const SKIN = Object.assign({}, TRADES[ACTIVE_TRADE], { brand: BRAND, tradeKey: ACTIVE_TRADE });
window.GRAVITYLEAD = SKIN;
