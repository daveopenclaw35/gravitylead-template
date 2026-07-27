# GravityLead Server — Missed-Call Text-Back + SMS Follow-Ups

Automated lead capture and nurturing via Twilio:
- **Missed-call text-back** — caller gets an SMS within seconds
- **3-day follow-up** — warm check-in
- **7-day follow-up** — offer free estimate
- **30-day follow-up** — long-term nurture
- **STOP opt-out** — automatic, legally compliant
- **Reply forwarding** — customer replies go straight to the business owner
- **Owner alerts** — instant SMS to the owner for every new lead and reply

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
    "ring_timeout": 20
  }
}
```

**Fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `business_name` | Yes | Shows in text messages |
| `owner_phone` | Yes | Where calls forward + owner alerts go |
| `trade` | Yes | `hvac`, `roofing`, `plumbing`, `electrical`, `landscaping`, `painting`, `general` |
| `owner_name` | No | Personalizes templates |
| `ring_timeout` | No | Seconds to ring before giving up (default: 20) |

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

Templates are in `templates.js` — customize per trade or add new ones.

### Inbound SMS Handling
- **STOP/UNSUBSCRIBE** → opt out, cancel pending follow-ups
- **YES** → alert owner with "hot lead" notification
- **Any other reply** → forward to owner's phone

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/twilio/voice` | Incoming call webhook (returns TwiML) |
| POST | `/twilio/voice/status` | Dial status callback (triggers text-back) |
| POST | `/twilio/sms` | Inbound SMS (opt-out + reply forwarding) |
| POST | `/api/lead` | Website form/chat lead intake |
| GET | `/api/stats` | Lead statistics |
| GET | `/health` | Health check |

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
- **Railway** / **Render** / **Fly.io** — easy, cheap, handles HTTPS
- **VPS + PM2** — `pm2 start index.js --name gravitylead`
- **Docker** — Dockerfile not included yet, trivial to add

The SQLite database (`gravitylead.db`) is created automatically on first run.

## Multi-Tenant

Add multiple entries to `clients.json` — one per Twilio number. Each client gets isolated lead tracking and their own follow-up sequences. Scales to dozens of clients on a single server.
