# GravityLead — HVAC Reference Template
**getgravitylead.com** · Static HTML/CSS/vanilla JS · Zero build step · Demo-first

A done-in-a-box AI lead-capture website. One config change re-skins the whole
site between **HVAC / roofing / plumbing**. Includes a demo-mode AI chat widget
(no API keys needed) so a salesperson can show it live on any laptop.

## Run it
No build, no npm. Just open it, or serve locally:
```bash
cd gravitylead-template
python3 -m http.server 8080
# visit http://localhost:8080
```
(Opening `index.html` directly also works; a server just avoids browser file:// quirks.)

## Swap the trade (the whole point)
Edit `config.js`, line ~15:
```js
const ACTIVE_TRADE = "hvac"; // "hvac" | "roofing" | "plumbing"
```
Save, reload. Copy, colors, services, FAQs, and the chat flow all change.

## Files
| File | What |
|---|---|
| `index.html` | Data-driven shell (populated at runtime) |
| `styles.css` | Theme via CSS variables set from the skin |
| `config.js` | **Trade-skin engine** — brand + HVAC/roofing/plumbing skins |
| `app.js` | Renders skin + runs demo-mode chat widget |
| `server/` | **Twilio missed-call text-back + SMS follow-up engine** |
| `sales/one-pager.md` | Sales pitch one-pager |
| `sales/demo-script.md` | Cold/demo call script for the salesperson |

## Demo mode vs production
- `app.js` → `DEMO_MODE = true` (default): scripted local chat, no backend, safe to hand out.
- Set `DEMO_MODE = false` to route chat to a real backend at `POST /api/chat`
  (the GravityLead agent that qualifies, books, and texts the owner). Hides the demo banner/tag.

## White-label for a real client
1. Pick the trade skin (`ACTIVE_TRADE`).
2. Override `business.*` in that skin (name, phone, city, license).
3. Optionally tweak `theme.*` colors to match their brand.
4. Set `DEMO_MODE = false` and point `/api/chat` at the live agent.

## Missed-Call Text-Back + SMS Follow-Ups
The `server/` directory contains a Node.js backend that handles:
- **Missed-call text-back** — auto-SMS within seconds when a call goes unanswered
- **Follow-up sequences** — automated SMS at day 3, 7, and 30
- **STOP opt-out** — legally compliant, cancels pending follow-ups
- **Reply forwarding** — customer replies go straight to the business owner
- **Lead tracking** — SQLite database with stats API

See [`server/README.md`](server/README.md) for setup instructions.

*Powered by GravityLead · getgravitylead.com*
