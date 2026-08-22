# GravityLead — Client Onboarding Checklist

**Use this checklist for every new client, in order. Target: live within 48 hours of payment.**

---

## PHASE 1 — Intake (Day 1, ~30 min)

**Collect client info before touching any tool.**

- [ ] Business name (exact legal/trade name)
- [ ] Owner first name
- [ ] Trade (hvac / roofing / plumbing / electrical / landscaping / painting / general / pressure-washing / tree-service / snow-removal)
- [ ] City and state
- [ ] Owner's cell phone (E.164 format for clients.json — `+1XXXXXXXXXX`)
- [ ] Owner's preferred ring timeout (default: 20 seconds)
- [ ] Existing domain? (yes → get login or transfer; no → you're registering one)
- [ ] Preferred domain if registering (e.g. `smithshvac.com`)
- [ ] Formspree form ID to use (or create a new Formspree form for this client)
- [ ] Plan confirmed: Self-Serve / Done-For-You / Managed
- [ ] Setup fee collected (Stripe one-time charge confirmed ✅)

---

## PHASE 2 — Twilio Number (~15 min)

- [ ] Log in to [console.twilio.com](https://console.twilio.com)
- [ ] **Buy Local Number** → search client's area code → buy
- [ ] Copy the number in E.164 format: `+1__________` ← record this, you'll use it everywhere
- [ ] Under the number's **Voice Configuration**:
  - Webhook URL: `https://YOUR_SERVER/twilio/voice` (HTTP POST)
  - Status callback: `https://YOUR_SERVER/twilio/voice/status` (HTTP POST)
- [ ] Under the number's **Messaging Configuration**:
  - Webhook URL: `https://YOUR_SERVER/twilio/sms` (HTTP POST)
- [ ] **Geographic Permissions** → restrict to United States only (prevents international spam charges)
- [ ] Quick smoke test: call the Twilio number from your phone → confirm it tries to connect (it won't forward yet — clients.json entry comes next)

---

## PHASE 3 — Add Client to Server (~10 min)

- [ ] Open `server/clients.json` on the live server (SSH in, `nano server/clients.json`)
- [ ] Add the new entry (**key = Twilio number**, E.164):

```json
"+1XXXXXXXXXX": {
  "business_name": "Smith's HVAC",
  "owner_phone": "+1XXXXXXXXXX",
  "trade": "hvac",
  "owner_name": "John",
  "ring_timeout": 20
}
```

- [ ] Save the file
- [ ] Restart the server: `pm2 restart gravitylead` (or `systemctl restart gravitylead`)
- [ ] Confirm startup log shows: `Loaded X client(s) from clients.json` ✅
- [ ] **Verify Twilio forwarding**: call the Twilio number → should ring owner's cell

> ⚠️ `server/clients.json` is gitignored — edits live only on the server. Never commit a file with real phone numbers.

---

## PHASE 4 — Build the Client Site (~30 min)

- [ ] Duplicate the `demo/` folder structure or spin a fresh copy of the template
- [ ] Open `config.js` for this client and set:
  - `ACTIVE_TRADE` → their trade key
  - `business.name`, `business.phone`, `business.city`, `business.hours`, `business.license`
  - `ANALYTICS_ID` → leave as `"G-XXXXXXXXXX"` for now (fill in after GA4 step)
  - `BRAND.domain` → their domain
- [ ] Update page `<title>` and `<meta name="description">` in `index.html`
- [ ] Update the lead form `FORM_ENDPOINT` to their Formspree form ID
- [ ] Add the client's exact `https://...` site origin to `PUBLIC_LEAD_ORIGINS` in the server environment
- [ ] Update `LEAD_SERVER_ENDPOINT` to `https://YOUR_SERVER/api/public/lead`
- [ ] Add a required checkbox with `id="glSmsConsent"` explaining automated SMS, message frequency, rates, and STOP opt-out
- [ ] Add a visually hidden honeypot input with `id="glWebsiteConfirm"` and `name="website_confirm"`
- [ ] Keep `API_KEY` server-side only. Never put it in client HTML or browser JavaScript.

**Local test before deploying:**
- [ ] Open `index.html` in browser → verify business name, phone, trade copy all correct
- [ ] Click through AI chat widget → verify greeting and quick replies match the trade
- [ ] Submit lead form with test data → confirm Formspree email received
- [ ] Confirm the page is mobile-responsive (resize browser to 375px width)

---

## PHASE 5 — Domain Setup (~20 min + DNS propagation)

**Option A — Client already has a domain:**
- [ ] Get DNS login (GoDaddy / Namecheap / Cloudflare / etc.)
- [ ] Add CNAME or A record pointing to your hosting platform (see Phase 6)

**Option B — Registering a new domain:**
- [ ] Register at Cloudflare Registrar (cheapest, includes free DNS) or Namecheap
- [ ] Note: domains usually take 15–60 min to propagate; plan accordingly
- [ ] Register the domain under your GravityLead account (you manage it — client doesn't need access)

**Both options:**
- [ ] Set nameservers to Cloudflare (if not already) — gives you DNS control + free DDoS protection
- [ ] DNS A/CNAME record added pointing to hosting provider
- [ ] Wait for propagation → test: `dig <domain> +short` returns your host IP
- [ ] SSL certificate issued automatically (Cloudflare / Netlify / Vercel all handle this) ✅

---

## PHASE 6 — Deploy the Site (~15 min)

**Recommended: Netlify (free tier handles static sites easily)**

- [ ] Push client site files to a dedicated GitHub repo (e.g. `smithshvac-site`)  
  *Or use Netlify drag-and-drop deploy for fastest turnaround*
- [ ] Connect repo to Netlify → auto-deploy on push
- [ ] In Netlify: **Domain settings** → add custom domain → follow DNS instructions
- [ ] Confirm `https://clientdomain.com` loads with green padlock ✅
- [ ] Test every CTA button on the live URL
- [ ] Test lead form submission on live URL (not just localhost)
- [ ] Test on real mobile device (not just browser resize)
- [ ] Test on both iOS Safari and Android Chrome

---

## PHASE 7 — Google Analytics 4 (~15 min)

- [ ] Go to [analytics.google.com](https://analytics.google.com)
- [ ] **Create Account** → Account name: `GravityLead — [Client Name]`
- [ ] **Create Property** → Property name: client's business name, timezone: client's local timezone, currency: USD
- [ ] **Create Web Data Stream** → enter client's live domain
- [ ] Copy **Measurement ID** (`G-XXXXXXXXXX`)
- [ ] Back in `config.js`: set `ANALYTICS_ID = "G-XXXXXXXXXX"` with the real ID
- [ ] Redeploy site (push to GitHub → Netlify auto-deploys, or re-drag-and-drop)
- [ ] Open GA4 Realtime report → visit the live site → confirm a page view appears ✅
- [ ] Note the Measurement ID in the client record

---

## PHASE 8 — Stripe Recurring Billing (~10 min)

- [ ] Log in to [dashboard.stripe.com](https://dashboard.stripe.com)
- [ ] **Customers** → **+ Add customer**:
  - Name: client's business name
  - Email: owner's email
  - Phone: owner's cell
  - Metadata: `trade`, `twilio_number`, `domain`
- [ ] **Subscriptions** → **+ Create subscription** for this customer:
  - Product: `GravityLead Monthly` ($149/mo Done-For-You / $299/mo Managed)
  - Billing cycle start: **today** (setup fee already collected separately)
  - Trial period: 0 days (they already got value from setup)
- [ ] Add client's card on file OR send a **Payment Link** for them to enter card
- [ ] Confirm subscription status shows **Active** ✅
- [ ] Copy Subscription ID (`sub_XXXXXXXX`) → record in client file
- [ ] Set up a **Stripe webhook** (if not already done globally) to notify you of failed payments: `customer.subscription.deleted`, `invoice.payment_failed` → your alert email

---

## PHASE 9 — End-to-End Go-Live Test (~20 min)

Run every test below from a **real phone** on a **real mobile network** (not WiFi or your dev machine).

- [ ] **Missed call text-back**: Call the Twilio number, let it ring through (don't answer) → confirm the calling phone gets the text-back SMS within 5 seconds ✅
- [ ] **AI chat**: Open the live site on your phone → open chat widget → send a message → confirm bot responds ✅
- [ ] **Lead form**: Submit the form on the live site → confirm:
  - Formspree confirmation email received ✅
  - Owner gets "New lead!" SMS from Twilio ✅
- [ ] **STOP opt-out**: Text STOP to the Twilio number → confirm no further messages sent (check DB: `opted_out = 1`) ✅
- [ ] **Durable opt-out**: Call again after STOP → confirm no new text-back or follow-up is created ✅
- [ ] **Owner reply routing**: Reply from the owner's phone using `#<lead-id> <message>` → confirm the correct customer receives it ✅
- [ ] **After-hours simulation** (optional but recommended): Note what time the AI chat responds at — if it's after 9 PM, screenshot it with timestamp. That's your first proof asset.
- [ ] Check server logs for any errors: `pm2 logs gravitylead --lines 50`
- [ ] Confirm GA4 Realtime shows activity from your test session ✅

---

## PHASE 10 — Welcome & Handoff (~15 min)

**Text message (send this first — contractors read texts, not emails):**

> Hey [First Name]! 🎉 Your GravityLead site is live at [domain]. Your AI receptionist is running 24/7.
>
> Test it now: call [Twilio number] from your personal phone and don't pick up. You'll get a text back in under 5 seconds.
>
> Your site: [domain]
> Questions? Reply here anytime. — [Your name], GravityLead

- [ ] Text sent ✅

**Follow-up email (send same day):**
- [ ] Subject: "Your GravityLead site is live 🚀"
- [ ] Include: live site URL, Twilio number (their "AI receptionist line"), what to expect in the first 30 days, how to reach support, link to any how-to doc

**Internal records:**
- [ ] Add client row to GravityLead client tracker (Google Sheet or Notion):
  - Business name, owner name, trade, city
  - Twilio number, domain, GA4 Measurement ID, Stripe subscription ID
  - Setup date, plan, go-live date
- [ ] Schedule **Day 7 check-in** reminder (text: "Hey [Name] — any leads come through yet? How's it going?")
- [ ] Schedule **Day 30 review** reminder (time to ask for testimonial and case study data)

---

## QUICK REFERENCE — Per-Client Info to Record

| Field | Value |
|---|---|
| Business name | |
| Owner name | |
| Owner cell | |
| Trade | |
| City / State | |
| Twilio number | |
| Domain | |
| Hosting | Netlify / Vercel / Other |
| GA4 Measurement ID | |
| Formspree form ID | |
| Stripe Customer ID | |
| Stripe Subscription ID | |
| Plan | Self-Serve / DFY / Managed |
| Setup date | |
| Go-live date | |
| Day 7 check-in | ☐ |
| Day 30 review / testimonial ask | ☐ |

---

## COMMON ISSUES & FIXES

**Twilio webhooks not firing**
→ Check that `BASE_URL` in server `.env` is the exact HTTPS URL Twilio is hitting (no trailing slash).  
→ Run `pm2 logs` and look for signature validation errors — means the URL Twilio signed doesn't match what the server reconstructs.

**Lead form submits but owner gets no SMS**
→ Check `clients.json` has the correct Twilio number as the key (E.164, exact match).  
→ Check server logs for `[api/lead] Failed to notify owner`.  
→ Confirm the client's exact origin is present in `PUBLIC_LEAD_ORIGINS` and the form posts to `/api/public/lead`.
→ Confirm the SMS-consent checkbox is checked and `sms_consent: true` is present in the request.

**Site live but GA4 shows no data**
→ Confirm `ANALYTICS_ID` in `config.js` is set to the real `G-XXXXXXXXXX`, not the placeholder.  
→ Redeploy after the change — the value is baked into the static file at deploy time.

**DNS not resolving**
→ Run `dig clientdomain.com +short` to check propagation.  
→ Cloudflare typically propagates in under 5 minutes; other registrars can take up to 48 hours.

---

*GravityLead Client Onboarding Checklist — last updated 2026-07-31*
