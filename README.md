# Dhaaga

> She shouldn't have to be the one who presses the button.

Dhaaga (Hindi for "thread") is a mobile-first web app (PWA) for **recHERsion 2026, PS2: Women's Safety**.
She starts a safety *thread* for a journey. Each check-in is a *knot*. If a knot is missed, help moves
closer in stages. The stages are run by the **server**, so they still work if her phone dies or loses signal.
```
Live Demo:https://dhaaga-dg07.onrender.com

```
## What it does

| Area | Behaviour |
|---|---|
| **Context-aware check-ins** | Cab ride: intervals *or* journey milestones. Walking home: short intervals. Meeting someone: scheduled check-ins. She chooses the rhythm for each journey. |
| **Staged escalation** | **1 Check**: discreet "Are you okay?" prompt to her. **2 Connect**: only the designated Responder is alerted, with a temporary location link. **3 Escalate**: other trusted contacts are alerted and emergency-call options appear. Delays and contact order are configurable. A missed check-in is never treated as proof of an attack. |
| **Circle links** | Contacts open a link in any browser (no install). Location is shared only once an alert reaches Stage 2, and goes dark again when she confirms she is safe. |
| **Discreet trigger** | Hold the ring for 2 s or shake twice to ask for help quietly (while the app is open). An optional calculator disguise with a safety PIN is available, but it is off by default and not a core dependency. |
| **Privacy-first vault** | Location trail only with consent. Audio is opt-in and manual. Records are **encrypted on her device** (AES-GCM, PBKDF2) before upload, get a hash-chained time seal, auto-delete after a retention period and can be deleted at any time. Thread records are removed from the server 24 h after a journey ends. |
| **Complaint draft** | Built only from facts she selects, with placeholders for her own account. She must confirm she has reviewed it before it can be copied or downloaded. |

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # ~30 s end-to-end test of the whole escalation flow
```

With no configuration, alerts appear in **Circle > Alert outbox** with the exact link each contact would receive,
so the full flow can be demonstrated on one device. For real alerts, see `.env.example`: set `TELEGRAM_BOT_TOKEN`
(contacts press Start on the invite link shown in the Circle tab) and `BASE_URL` (your deployed HTTPS URL).
Location, microphone and installability need HTTPS when deployed (Render, Railway, Fly, etc.).

### Demo script (about 2 minutes)
1. Circle tab: add a Responder and a trusted contact, set stage delays to 10 s, mark them joined.
2. Start a *Meeting* thread with **Demo timings**. Keep the location trail on.
3. Press **Demo tool: make the next check-in due now**. Watch Stage 1, then 2, then 3.
4. Circle tab > Alert outbox > open the Responder link on a second device: live location + role actions.
5. Tie the knot ("I'm safe"): the whole circle is told, and the location link goes dark.
6. End the thread, save to the encrypted vault, open it, verify the seal, generate the complaint draft.

## Honest limitations
- Browser apps cannot guarantee background location, shake detection or the discreet trigger on a **locked phone**. Escalation itself runs on the server and does not depend on the phone once a check-in is missed.
- The vault time seal shows a record existed at a time and was not altered. It is **not** a promise that any authority will accept it as evidence.
- Accounts are device-bound with no password (prototype). A production version would add phone-number verification.
- Data is stored in a JSON file on the server. Production would use a database.

## Third-party resources and credits
- [Express](https://expressjs.com) (MIT): web server
- [Leaflet](https://leafletjs.com) (BSD-2) and [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles, (c) OpenStreetMap contributors: circle map
- [Telegram Bot API](https://core.telegram.org/bots/api): optional alert delivery
- Optional: Anthropic Claude API for wording the complaint draft (falls back to a template)
- Fonts: [Fraunces](https://fonts.google.com/specimen/Fraunces) and [DM Sans](https://fonts.google.com/specimen/DM+Sans) (SIL Open Font License) via Google Fonts
- Browser APIs: Geolocation, Web Crypto, MediaRecorder, Wake Lock, DeviceMotion
- AI assistance: the concept, mockups and code were developed with Claude (Anthropic).

## Structure
```
server.js           API, escalation state machine, vault seal chain, Telegram, draft
public/index.html   app shell          public/app.js    all screens (plain JS, no build)
public/circle.html  page contacts see  public/app.css   styling
test/smoke.js       end-to-end test
```
