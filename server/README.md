# GravityLead Server - Missed-Call Text-Back + SMS Follow-Ups

Automated lead capture and nurturing via Twilio:
- **Missed-call text-back** - caller gets an SMS within seconds
- **3-day follow-up** - warm check-in
- **7-day follow-up** - offer free estimate
- **30-day follow-up** - long-term nurture
- **Google review request** — sent automatically 24–48h after a job is marked complete
- **Monthly client reports** — automated summary SMS to each owner on the 1st of every month
- **STOP opt-out** - automatic, legally compliant
- **Reply forwarding** - customer replies go straight to the business owner
- **Owner alerts** - instant SMS to the owner for every new lead and reply

## Quick Start

```bash
cd server
cp .env.example .env          # fill in Twilio creds
nano clients.json             # add your client(s)
npm install
npm start
```

## Configuration

### .env
```
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
PORT=3000
BASE_URL=https://your-server.com
FORMSPREE_ENDPOINT=https://formspree.io/f/xdaqyezr   # optional passthrough
```

### clients.json
Map each Twilio phone number to a business:
```json
{
  "+16075551234": {
    "business_name": "Summit Air & Heating",
    "owner_phone": "+16075559999",
    "trade": "hvac",
    "owner_name": "John",
    "ring_timeout": 20,
    "google_review_link": "https://g.page/r/YOUR_REVIEW_LINK_HERE/review"
  }
}
```

> **How to get a Google review link:** Go to your Google Business Profile → click "Get more reviews" → copy the short link.

**Fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `business_name` | Yes | Shows in text messages |
| `owner_phone` | Yes | Where calls forward + owner alerts go |
| `trade` | Yes | `hvac`, `roofing`, `plumbing`, `electrical`, `landscaping`, `painting`, `general` |
| `owner_name` | No | Personalizes templates |
| `ring_timeout` | No | Seconds to ring before giving up (default: 20) |
| `google_review_link` | Yes* | Google review URL for the business (`g.page/r/.../review`). Required for review requests. |

## Twilio Setup

1. Buy a local phone number in the client's area code
2. Set the **Voice webhook** to: `https://your-server.com/twilio/voice` (POST)
3. Set the **SMS webhook** to: `https://your-server.com/twilio/sms` (POST)

## How It Works

### Missed Call Flow
```
Caller dials Twilio number
  → Server answers, forwards to owner's phone (<Dial>)
  → Owner doesn't answer (20s timeout)
  → Twilio hits /twilio/voice/status
  → Server sends immediate text-back SMS
  → Schedules follow-ups at day 3, 7, 30
```

### Follow-Up Sequence
| Day | Message |
|-----|---------|
| 0 | "Sorry we missed you! How can we help? Reply here or call back." |
| 3 | "Still need help with [service]? We'd love to get you taken care of." |
| 7 | "If you still need [service], reply YES and we'll get back to you." |
| 30 | "We're just a text away. Save this number!" |

Templates are in `templates.js` - customize per trade or add new ones.

### Google Review Request Flow
```
Job is marked complete (POST /api/job/complete)
  → Server schedules a review SMS for 24–48h later (randomized)
  → Scheduler fires when due
  → Customer receives: "Hi [Name], thanks for choosing [Business]!
     We’d love your feedback — it only takes 30 seconds: [Google Review Link]
     Reply STOP to opt out."
```

- Opted-out customers are automatically skipped
- Each customer/business pair can only have one pending review request at a time
- Dave can trigger a review immediately with `send_now: true` or via `POST /api/review/send`

### Monthly Client Report Flow
```
1st of every month at 9:00 AM (server local time)
  → For each client in clients.json, query previous month's DB stats
  → Owner receives:
     "Hey [Owner Name], here’s your GravityLead report for [Month]:

     📊 Leads captured: X | Missed calls recovered: X |
     Follow-ups sent: X | Review requests: X

     Questions? Reply anytime."
```

**Metrics included:**
| Metric | What it counts |
|--------|----------------|
| Leads captured | Website AI chat / form leads (`source: 'chat'` or `'form'`) |
| Missed calls recovered | Missed-call text-backs sent (`source: 'missed_call'`) |
| Follow-ups sent | Day-3/7/30 follow-up messages delivered |
| Review requests | Google review request SMS messages sent |

Manually trigger at any time with `POST /api/report/send`.

### Inbound SMS Handling
- **STOP/UNSUBSCRIBE** → opt out, cancel pending follow-ups
- **YES** → alert owner with "hot lead" notification
- **Any other reply** → forward to owner's phone

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/twilio/voice` | Twilio sig | Incoming call webhook (returns TwiML) |
| POST | `/twilio/voice/status` | Twilio sig | Dial status callback (triggers text-back) |
| POST | `/twilio/sms` | Twilio sig | Inbound SMS (opt-out + reply forwarding) |
| POST | `/api/lead` | API key | Website form/chat lead intake |
| GET | `/api/stats` | API key | Lead statistics |
| POST | `/api/job/complete` | API key | Mark job complete; schedule review request |
| POST | `/api/review/send` | API key | Manually trigger a review request now |
| GET | `/api/review/stats` | API key | Review request statistics |
| POST | `/api/report/send` | API key | Manually trigger monthly client report |
| GET | `/health` | — | Health check |

### POST /api/lead
Enroll a website form submission in the follow-up sequence:
```json
{
  "phone": "(607) 555-1234",
  "name": "Jane Smith",
  "business": "Summit Air & Heating",
  "trade": "hvac",
  "twilio_number": "+16075551234",
  "source": "form"
}
```

### POST /api/job/complete
Mark a job complete and schedule an automated review request 24-48h later:
```json
{
  "customer_phone": "(607) 555-1234",
  "twilio_number": "+16075551234",
  "customer_name": "Sarah",
  "send_now": false
}
```
- `send_now: true` - skip the delay and send immediately (useful for testing)
- Returns `{ status, review_id, scheduled_at, sent }`

### POST /api/review/send
Manually fire a review request right now. Two modes:

**Mode A - by review ID** (resend a scheduled one):
```json
{ "review_id": 5 }
```

**Mode B - by customer** (create and send immediately):
```json
{
  "customer_phone": "(607) 555-1234",
  "twilio_number": "+16075551234",
  "customer_name": "Sarah"
}
```

### POST /api/report/send
Manually trigger the monthly report without waiting for the 1st. Defaults to the previous calendar month.

**Send to all clients (default):**
```json
{}
```

**Send to one client only:**
```json
{
  "business_key": "+16075551234"
}
```

**Override month/year (useful for testing or resends):**
```json
{
  "year": 2026,
  "month": 7
}
```

Returns:
```json
{
  "total": 3,
  "sent": 3,
  "failed": 0,
  "results": [
    { "business_key": "+16075551234", "sent": true, "message_sid": "SM...", "stats": { "chat_leads": 5, "missed_calls": 12, "followups_sent": 28, "reviews_sent": 8 } }
  ],
  "year": 2026,
  "month": 7
}
```

### GET /api/review/stats
Returns sent/pending/failed counts per client:
```json
{
  "clients": [
    {
      "business_key": "+16075551234",
      "business_name": "Summit Air & Heating",
      "has_review_link": true,
      "total_scheduled": 12,
      "sent": 10,
      "pending": 1,
      "failed": 1,
      "skipped": 0
    }
  ]
}
```

## Website Integration

In the GravityLead template's `app.js`, set `LEAD_SERVER_ENDPOINT` to your server URL:
```js
const LEAD_SERVER_ENDPOINT = "https://your-server.com/api/lead";
```

Also add a `twilio` field to the business config in `config.js`:
```js
business: {
  name: "Summit Air & Heating",
  phone: "(555) 302-4471",
  twilio: "+15553024471",
  // ...
},
```

## Deployment

Any Node.js host works. Recommended:
- **Railway** / **Render** / **Fly.io** - easy, cheap, handles HTTPS
- **VPS + PM2** - `pm2 start index.js --name gravitylead`
- **Docker** - Dockerfile not included yet, trivial to add

The SQLite database (`gravitylead.db`) is created automatically on first run.

## Multi-Tenant

Add multiple entries to `clients.json` - one per Twilio number. Each client gets isolated lead tracking and their own follow-up sequences. Scales to dozens of clients on a single server.
