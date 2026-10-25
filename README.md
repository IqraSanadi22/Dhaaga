# Dhaaga

> She shouldn't have to be the one who presses the button.

**recHERsion 2026 · PS2: Women's Safety · Team AUREX**

**Live demo:** [https://dhaaga-dg07.onrender.com](https://dhaaga-dg07.onrender.com)
(Free hosting sleeps when idle, so the first load can take up to a minute. Data on the live demo may reset when it restarts.)

**Repository:** [https://github.com/IqraSanadi22/Dhaaga](https://github.com/IqraSanadi22/Dhaaga)

**Demo video:** [Watch the demo](https://drive.google.com/file/d/1COMCP0ay0-Kvlr7AqIfTPVeVXM3c-_BA/view?usp=sharing)

### 📊 Project Presentation

[**View / Download Dhaaga Presentation (PPT)**](./dhaagappt.pptx)



Dhaaga (Hindi for "thread") is a mobile-first web app (PWA). She starts a safety *thread* for a journey.
Each check-in is a *knot*. If a knot is missed, help moves closer in stages. The stages are run by the
**server**, so they still work if her phone dies or loses signal.

## The problem

Most safety apps either need a button press she may not be able to make, or alert everyone at once until the
alerts get ignored. Contacts often have to install an app, and location is shared all the time, not just when it
matters. Dhaaga is for women travelling alone (cabs, walks home, first-time meetings) and for the friends and
family who make up her circle.

## What it does

| Area | Behaviour |
|---|---|
| **Context-aware check-ins** | Cab ride: intervals *or* journey milestones. Walking home: short intervals. Meeting someone: scheduled check-ins. She chooses the rhythm for each journey. |
| **Staged escalation** | **1 Check**: discreet "Are you okay?" prompt to her. **2 Connect**: only the designated Responder is alerted, with a temporary location link. **3 Escalate**: other trusted contacts are alerted and emergency-call options appear. Delays and contact order are configurable. A missed check-in is never treated as proof of an attack. |
| **Circle links** | Contacts open a link in any browser (no install). Location is shared only once an alert reaches Stage 2, and goes dark again when she confirms she is safe. |
| **Discreet trigger** | Hold the ring for 2 s or shake twice to ask for help quietly (while the app is open). An optional calculator disguise with a safety PIN is available, but it is off by default and not a core dependency. |
| **Privacy-first vault** | Location trail only with consent. Audio is opt-in and manual. Records are **encrypted on her device** (AES-GCM, PBKDF2) before upload, get a hash-chained time seal, auto-delete after a retention period and can be deleted at any time. Thread records are removed from the server 24 h after a journey ends. |
| **Complaint draft** | Built only from facts she selects, with placeholders for her own account. She must confirm she has reviewed it before it can be copied or downloaded. |

## Setup and run locally

**Requirements:** Node.js 18 or newer (20.6+ if you want to use a `.env` file) and npm.

```bash
git clone https://github.com/IqraSanadi22/Dhaaga.git
cd Dhaaga
npm install
npm start          # open http://localhost:3000
```

Then open it on a phone-sized screen (or browser dev tools mobile view). Create a name, add contacts in the
**Circle** tab, and start a thread from **Thread**.

Run the automated end-to-end test of the escalation flow (about 30 seconds):

```bash
npm test
```

### Configuration (all optional)

With no configuration the app works fully: alerts appear in **Circle > Alert outbox** with the exact link each
contact would receive, so the whole flow can be demonstrated on one device.

| Variable | Purpose |
|---|---|
| `BASE_URL` | Public URL used in links sent to contacts, e.g. `https://dhaaga-dg07.onrender.com`. Without it, links point to `localhost`. |
| `TELEGRAM_BOT_TOKEN` | From @BotFather. Enables real alerts: contacts press Start on the invite link shown in the Circle tab. |
| `ANTHROPIC_API_KEY` | Optional. Wording of the complaint draft. Without it, a template is used. |
| `PORT` | Port to listen on (default 3000). |

The app does not load `.env` by itself. Either export the variables, or run:

```bash
cp .env.example .env     # then fill in values
node --env-file=.env server.js
```

### Deploying (how the live demo runs)

Deployed on [Render](https://render.com) as a Node web service: build command `npm install`, start command
`npm start`, with `BASE_URL` (and optionally `TELEGRAM_BOT_TOKEN`) set in the service's environment settings.
HTTPS is needed for location, microphone and installability.

## Demo script (about 3 minutes)
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
- Data is stored in a JSON file on the server, which is temporary on free hosting. Production would use a database.
- Without a Telegram bot token, alerts are shown in the in-app outbox instead of being delivered.

## Project structure
```
server.js           API, escalation state machine, vault seal chain, Telegram, complaint draft
public/index.html   app shell
public/app.js       all screens (plain JavaScript, no build step)
public/app.css      styling
public/circle.html  page contacts see when they open an alert link
test/smoke.js       end-to-end test of the escalation flow
.env.example        optional configuration
```

## Resources and credits
- [Express](https://expressjs.com) (MIT): web server
- [Leaflet](https://leafletjs.com) (BSD-2) and [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles, © OpenStreetMap contributors: circle map
- [Telegram Bot API](https://core.telegram.org/bots/api): optional alert delivery
- [Render](https://render.com) and GitHub: hosting and source code
- Optional: Anthropic Claude API for wording the complaint draft (falls back to a template)
- Fonts: [Fraunces](https://fonts.google.com/specimen/Fraunces) and [DM Sans](https://fonts.google.com/specimen/DM+Sans) (SIL Open Font License) via Google Fonts
- Browser APIs: Geolocation, Web Crypto, MediaRecorder, Wake Lock, DeviceMotion
- AI assistance: design and code were developed with Claude (Anthropic).
