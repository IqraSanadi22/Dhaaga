'use strict';
/*
 * Dhaaga server
 * - REST API for users, circle contacts, safety threads, vault and circle links
 * - Escalation runs HERE (server side) so it still fires if her phone dies or loses signal
 * - Alerts go to Telegram when a bot token is set; otherwise they are logged to an
 *   in-app "outbox" so the full flow can be demonstrated without any external account
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const BASE = () => (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const TG = process.env.TELEGRAM_BOT_TOKEN || '';
let BOT_USER = process.env.TELEGRAM_BOT_USERNAME || '';
const LLM_KEY = process.env.ANTHROPIC_API_KEY || '';
const LLM_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

/* ---------- tiny JSON store ---------- */
let db = { users: {}, threads: {}, vault: {}, chain: [], outbox: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { /* first run */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    } catch (e) { console.error('save failed:', e.message); }
  }, 250);
}
const id = () => crypto.randomBytes(8).toString('hex');
const tok = () => crypto.randomBytes(16).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pinHash = (u, p) => sha(u.id + ':' + p);

/* ---------- helpers ---------- */
function defaultSettings() {
  return {
    stage1Sec: 60,        // time she has to answer the "are you okay?" prompt
    stage2Sec: 120,       // time the Responder has before additional contacts are alerted
    emergencyNumber: '112',
    locationDefault: true,
    audioAllowed: false,  // audio is opt-in, never automatic
    retentionDays: 30,    // vault auto-delete (0 = keep until she deletes)
    silentTrigger: true,  // discreet trigger (hold ring / shake) - works while the app is open
    disguise: false,      // optional calculator disguise
    pin: '', duressPin: ''
  };
}
function publicUser(u) {
  const s = Object.assign({}, u.settings);
  s.hasPin = !!s.pin; s.hasDuress = !!s.duressPin; delete s.pin; delete s.duressPin;
  return { id: u.id, name: u.name, settings: s, contacts: u.contacts.map(c => ({ id: c.id, name: c.name, phone: c.phone, role: c.role, joined: !!(c.chatId || c.demoJoined), joinCode: c.joinCode })) };
}
function ev(t, type, detail) { t.events.push({ t: Date.now(), type, detail }); }
function auth(req, res, next) {
  const k = req.get('x-token');
  const u = k && Object.values(db.users).find(x => x.token === k);
  if (!u) return res.status(401).json({ error: 'unauthorised' });
  req.user = u; next();
}
function ownThread(req, res) {
  const t = db.threads[req.params.id];
  if (!t || t.userId !== req.user.id) { res.status(404).json({ error: 'not found' }); return null; }
  return t;
}
function threadView(t, u) {
  const links = {};
  u.contacts.forEach(c => { links[c.id] = `${BASE()}/c/${t.shareToken}/${c.token}`; });
  return {
    id: t.id, mode: t.mode, type: t.type, intervalSec: t.intervalSec, status: t.status, stage: t.stage, stageAt: t.stageAt,
    nextKnotAt: t.nextKnotAt, nextLabel: t.nextLabel, schedule: t.schedule, startedAt: t.startedAt, endedAt: t.endedAt,
    endReason: t.endReason, consentLocation: t.consentLocation, consentAudio: t.consentAudio, events: t.events, trail: t.trail,
    acks: t.acks, reason: t.reason, links, now: Date.now()
  };
}

/* ---------- notifications ---------- */
async function notify(u, t, c, text, kind) {
  const link = `${BASE()}/c/${t.shareToken}/${c.token}`;
  const m = { id: id(), t: Date.now(), userId: u.id, threadId: t.id, contact: c.name, role: c.role, kind, text, link, channel: 'simulated', delivered: false };
  if (TG && c.chatId) {
    m.channel = 'telegram';
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: c.chatId, text: `${text}\n${link}` })
      });
      const j = await r.json();
      m.delivered = !!j.ok; if (!j.ok) m.error = j.description;
    } catch (e) { m.error = e.message; }
  }
  db.outbox.push(m); if (db.outbox.length > 500) db.outbox.shift();
  ev(t, 'notified', `${kind === 'update' ? 'Update' : 'Alert'} sent to ${c.name} (${c.role}) via ${m.channel}${m.delivered ? '' : ' - not delivered automatically, link can be shared by hand'}`);
  save();
}

/* ---------- escalation state machine ----------
 * stage 0 = thread held         stage 1 = Check (discreet prompt to her)
 * stage 2 = Connect (Responder) stage 3 = Escalate (extra trusted contacts + emergency-call options)
 * A missed check-in only moves the thread along these stages - it is never treated as proof of danger. */
function setStage(t, stage, why) {
  const u = db.users[t.userId];
  if (!u || t.status !== 'active') return;
  t.stage = stage; t.stageAt = Date.now();
  const names = { 1: 'Check', 2: 'Connect', 3: 'Escalate' };
  ev(t, 'stage' + stage, `Stage ${stage} - ${names[stage]}: ${why}`);
  const asked = t.reason === 'asked';
  if (stage === 2) {
    const responders = u.contacts.filter(c => c.role === 'responder');
    if (!responders.length) { ev(t, 'info', 'No Responder set - moving straight to Escalate'); return setStage(t, 3, 'no Responder available'); }
    const msg = asked
      ? `${u.name} used her discreet trigger to ask for help. Please try to reach her. A temporary location link is below.`
      : `${u.name} hasn't confirmed a check-in. This may be a missed check-in or poor signal, so please try calling her first. A temporary location link is below.`;
    responders.forEach(c => notify(u, t, c, msg, 'alert'));
  }
  if (stage === 3) {
    const trusted = u.contacts.filter(c => c.role === 'trusted');
    const msg = `${u.name}'s check-in is still unresolved${asked ? ' after she asked for help' : ''}. Please try to reach her or the Responder. If you cannot, consider calling emergency services (${u.settings.emergencyNumber}). Temporary location link below.`;
    trusted.forEach(c => notify(u, t, c, msg, 'alert'));
    u.contacts.filter(c => c.role === 'responder').forEach(c => notify(u, t, c, `Still unresolved: ${u.name} has not checked in. Additional trusted contacts have now been alerted.`, 'update'));
    if (!trusted.length) ev(t, 'info', 'No additional trusted contacts set - emergency-call options offered to her');
  }
}
function resolveThread(t, how) {
  const u = db.users[t.userId];
  const wasAlerted = t.stage >= 2;
  if (wasAlerted && u) {
    u.contacts.forEach(c => notify(u, t, c, `Update: ${u.name} has confirmed she is safe${how === 'ended' ? ' and ended her journey' : ''}. No action needed.`, 'update'));
  }
}
setInterval(() => {
  const now = Date.now();
  for (const t of Object.values(db.threads)) {
    if (t.status !== 'active') continue;
    const u = db.users[t.userId]; if (!u) continue;
    const s = u.settings;
    if (t.stage === 0 && now >= t.nextKnotAt) {
      ev(t, 'missed', `Check-in "${t.nextLabel}" was not confirmed in time`);
      t.reason = 'missed';
      setStage(t, 1, 'asking whether she is okay');
      save();
    } else if (t.stage === 1 && now >= t.stageAt + s.stage1Sec * 1000) {
      setStage(t, 2, 'no answer to the prompt'); save();
    } else if (t.stage === 2 && now >= t.stageAt + s.stage2Sec * 1000) {
      setStage(t, 3, 'still unresolved after the Responder delay'); save();
    }
  }
}, 1000);

/* retention + clean-up (privacy: records do not live forever by default) */
function sweep() {
  const now = Date.now();
  for (const [vid, v] of Object.entries(db.vault)) {
    const u = db.users[v.userId];
    const days = u ? u.settings.retentionDays : 30;
    if (days > 0 && now - v.sealedAt > days * 864e5) delete db.vault[vid];
  }
  for (const [tid, t] of Object.entries(db.threads)) {
    if (t.status === 'ended' && now - t.endedAt > 24 * 36e5) delete db.threads[tid];
  }
  save();
}
setInterval(sweep, 36e5);

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/c/:tt/:ct', (req, res) => res.sendFile(path.join(__dirname, 'public', 'circle.html')));

app.get('/api/config', (req, res) => res.json({ telegram: !!TG, bot: BOT_USER, llm: !!LLM_KEY, base: BASE() }));

app.post('/api/register', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'name required' });
  const u = { id: id(), token: tok(), name, createdAt: Date.now(), contacts: [], settings: defaultSettings() };
  db.users[u.id] = u; save();
  res.json({ token: u.token, user: publicUser(u) });
});
app.get('/api/me', auth, (req, res) => {
  const active = Object.values(db.threads).find(t => t.userId === req.user.id && t.status === 'active');
  res.json({ user: publicUser(req.user), activeThreadId: active ? active.id : null });
});
app.delete('/api/me', auth, (req, res) => {
  const uid = req.user.id;
  delete db.users[uid];
  Object.keys(db.threads).forEach(k => { if (db.threads[k].userId === uid) delete db.threads[k]; });
  Object.keys(db.vault).forEach(k => { if (db.vault[k].userId === uid) delete db.vault[k]; });
  db.outbox = db.outbox.filter(m => m.userId !== uid);
  save(); res.json({ ok: true });
});
app.put('/api/settings', auth, (req, res) => {
  const s = req.user.settings, b = req.body || {};
  const num = (v, lo, hi, d) => { v = +v; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  if (b.name !== undefined) req.user.name = String(b.name).trim().slice(0, 40) || req.user.name;
  if (b.stage1Sec !== undefined) s.stage1Sec = num(b.stage1Sec, 10, 900, s.stage1Sec);
  if (b.stage2Sec !== undefined) s.stage2Sec = num(b.stage2Sec, 10, 3600, s.stage2Sec);
  if (b.emergencyNumber !== undefined) s.emergencyNumber = String(b.emergencyNumber).replace(/[^0-9+]/g, '').slice(0, 15) || '112';
  ['locationDefault', 'audioAllowed', 'silentTrigger'].forEach(k => { if (b[k] !== undefined) s[k] = !!b[k]; });
  if (b.retentionDays !== undefined) s.retentionDays = num(b.retentionDays, 0, 365, 30);
  if (b.disguise !== undefined) s.disguise = !!b.disguise && !!s.pin;
  save(); res.json({ user: publicUser(req.user) });
});

/* PINs (optional disguise). Stored only as salted hashes. */
app.post('/api/pin/set', auth, (req, res) => {
  const { pin, duressPin } = req.body || {};
  const ok = (p) => /^[0-9]{4,8}$/.test(String(p || ''));
  if (!ok(pin) || !ok(duressPin) || pin === duressPin) return res.status(400).json({ error: 'Use two different PINs of 4-8 digits' });
  req.user.settings.pin = pinHash(req.user, pin);
  req.user.settings.duressPin = pinHash(req.user, duressPin);
  save(); res.json({ user: publicUser(req.user) });
});
app.post('/api/pin/check', auth, (req, res) => {
  const p = pinHash(req.user, String((req.body || {}).pin || '')), s = req.user.settings;
  if (s.pin && p === s.pin) return res.json({ result: 'open' });
  if (s.duressPin && p === s.duressPin) {
    const t = Object.values(db.threads).find(x => x.userId === req.user.id && x.status === 'active');
    if (t && t.stage < 2) { t.reason = 'asked'; ev(t, 'silent', 'Discreet alert raised with the safety PIN'); setStage(t, 2, 'she asked for help quietly'); save(); }
    return res.json({ result: 'stay' });
  }
  res.json({ result: 'no' });
});

/* ---------- circle contacts ---------- */
app.post('/api/contacts', auth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'name required' });
  if (req.user.contacts.length >= 8) return res.status(400).json({ error: 'up to 8 contacts' });
  const c = { id: id(), name, phone: String(b.phone || '').replace(/[^0-9+]/g, '').slice(0, 15), role: b.role === 'responder' ? 'responder' : 'trusted', token: tok(), joinCode: id(), chatId: null, demoJoined: false };
  req.user.contacts.push(c); save(); res.json({ user: publicUser(req.user) });
});
app.put('/api/contacts/:cid', auth, (req, res) => {
  const c = req.user.contacts.find(x => x.id === req.params.cid); if (!c) return res.status(404).end();
  const b = req.body || {};
  if (b.name !== undefined) c.name = String(b.name).trim().slice(0, 40) || c.name;
  if (b.phone !== undefined) c.phone = String(b.phone).replace(/[^0-9+]/g, '').slice(0, 15);
  if (b.role !== undefined) c.role = b.role === 'responder' ? 'responder' : 'trusted';
  save(); res.json({ user: publicUser(req.user) });
});
app.delete('/api/contacts/:cid', auth, (req, res) => {
  req.user.contacts = req.user.contacts.filter(x => x.id !== req.params.cid); save(); res.json({ user: publicUser(req.user) });
});
app.post('/api/contacts/reorder', auth, (req, res) => {
  const ids = (req.body || {}).ids || [];
  const map = new Map(req.user.contacts.map(c => [c.id, c]));
  const out = ids.map(i => map.get(i)).filter(Boolean);
  req.user.contacts.forEach(c => { if (!out.includes(c)) out.push(c); });
  req.user.contacts = out; save(); res.json({ user: publicUser(req.user) });
});
app.post('/api/contacts/:cid/join-demo', auth, (req, res) => {
  const c = req.user.contacts.find(x => x.id === req.params.cid); if (!c) return res.status(404).end();
  c.demoJoined = true; save(); res.json({ user: publicUser(req.user) });
});

/* ---------- threads ---------- */
app.post('/api/threads', auth, (req, res) => {
  const u = req.user, b = req.body || {};
  if (Object.values(db.threads).some(t => t.userId === u.id && t.status === 'active')) return res.status(409).json({ error: 'A thread is already running' });
  const mode = ['cab', 'walk', 'meeting'].includes(b.mode) ? b.mode : 'cab';
  const now = Date.now();
  const t = {
    id: id(), userId: u.id, mode, status: 'active', stage: 0, stageAt: now, startedAt: now, shareToken: tok(),
    consentLocation: !!b.consentLocation, consentAudio: !!b.consentAudio && u.settings.audioAllowed,
    trail: [], events: [], acks: [], reason: null, type: 'interval', intervalSec: 0, schedule: [], knotIndex: 0
  };
  if (Array.isArray(b.schedule) && b.schedule.length) {
    t.type = 'fixed';
    t.schedule = b.schedule.slice(0, 12).map((x, i) => ({ label: String(x.label || `Check-in ${i + 1}`).slice(0, 40), dueAt: now + Math.max(5, +x.afterSec || 60) * 1000, done: false }))
      .sort((a, c) => a.dueAt - c.dueAt);
    t.nextKnotAt = t.schedule[0].dueAt; t.nextLabel = t.schedule[0].label;
  } else {
    t.intervalSec = Math.min(7200, Math.max(15, +b.intervalSec || 600));
    t.nextKnotAt = now + t.intervalSec * 1000; t.nextLabel = 'Regular check-in';
  }
  ev(t, 'start', `Thread started (${mode}); ${t.type === 'interval' ? `check-in every ${Math.round(t.intervalSec / 6) / 10} min` : `${t.schedule.length} scheduled check-ins`}; location trail ${t.consentLocation ? 'ON (with her consent)' : 'OFF'}`);
  db.threads[t.id] = t; save();
  res.json({ thread: threadView(t, u) });
});
app.get('/api/threads/active', auth, (req, res) => {
  const t = Object.values(db.threads).find(x => x.userId === req.user.id && x.status === 'active');
  res.json({ thread: t ? threadView(t, req.user) : null });
});
app.get('/api/threads', auth, (req, res) => {
  res.json({ threads: Object.values(db.threads).filter(t => t.userId === req.user.id).sort((a, b) => b.startedAt - a.startedAt).map(t => ({ id: t.id, mode: t.mode, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, stage: t.stage })) });
});
app.get('/api/threads/:id', auth, (req, res) => { const t = ownThread(req, res); if (t) res.json({ thread: threadView(t, req.user) }); });

app.post('/api/threads/:id/knot', auth, (req, res) => {
  const t = ownThread(req, res); if (!t) return;
  if (t.status !== 'active') return res.status(409).json({ error: 'thread ended' });
  const now = Date.now(), wasStage = t.stage;
  ev(t, 'knot', wasStage > 0 ? `She confirmed she is safe (during stage ${wasStage})` : `Check-in "${t.nextLabel}" confirmed`);
  if (wasStage >= 2) resolveThread(t, 'knot');
  t.stage = 0; t.stageAt = now; t.reason = null;
  if (t.type === 'fixed') {
    // confirm the earliest unfinished scheduled check-in
    const cur = t.schedule.find(x => !x.done); if (cur) cur.done = true;
    const nxt = t.schedule.find(x => !x.done);
    if (!nxt) { t.status = 'ended'; t.endedAt = now; t.endReason = 'completed'; ev(t, 'end', 'All check-ins done - thread completed'); }
    else { t.nextKnotAt = Math.max(nxt.dueAt, now + 5000); t.nextLabel = nxt.label; }
  } else { t.nextKnotAt = now + t.intervalSec * 1000; }
  save(); res.json({ thread: threadView(t, req.user) });
});
app.post('/api/threads/:id/alert', auth, (req, res) => {
  const t = ownThread(req, res); if (!t) return;
  if (t.status !== 'active') return res.status(409).json({ error: 'thread ended' });
  const kind = (req.body || {}).kind === 'silent' ? 'silent' : 'help';
  if (t.stage < 2) {
    t.reason = 'asked';
    ev(t, kind, kind === 'silent' ? 'Discreet alert raised by her' : 'She tapped "I need help"');
    setStage(t, 2, 'she asked for help');
  }
  save(); res.json({ thread: threadView(t, req.user) });
});
app.post('/api/threads/:id/loc', auth, (req, res) => {
  const t = ownThread(req, res); if (!t) return;
  if (t.status !== 'active' || !t.consentLocation) return res.json({ ok: true, stored: 0 });
  const pts = ((req.body || {}).points || []).slice(0, 50).filter(p => isFinite(p.lat) && isFinite(p.lng))
    .map(p => ({ t: +p.t || Date.now(), lat: +p.lat, lng: +p.lng, acc: Math.round(+p.acc || 0) }));
  t.trail.push(...pts); if (t.trail.length > 3000) t.trail.splice(0, t.trail.length - 3000);
  save(); res.json({ ok: true, stored: pts.length });
});
app.post('/api/threads/:id/end', auth, (req, res) => {
  const t = ownThread(req, res); if (!t) return;
  if (t.status === 'active') {
    const wasAlerted = t.stage >= 2;
    t.status = 'ended'; t.endedAt = Date.now(); t.endReason = 'ended by her'; ev(t, 'end', 'She ended the thread');
    if (wasAlerted) resolveThread(t, 'ended');
    t.stage = 0;
  }
  save(); res.json({ thread: threadView(t, req.user) });
});
app.post('/api/threads/:id/demo-miss', auth, (req, res) => { // demo helper: makes the next check-in due right now
  const t = ownThread(req, res); if (!t) return;
  if (t.status === 'active' && t.stage === 0) { t.nextKnotAt = Date.now(); ev(t, 'info', 'Demo: next check-in forced due'); save(); }
  res.json({ thread: threadView(t, req.user) });
});

/* ---------- circle (public, token-protected links) ---------- */
function circleCtx(req, res) {
  const t = Object.values(db.threads).find(x => x.shareToken === req.params.tt);
  const u = t && db.users[t.userId];
  const c = u && u.contacts.find(x => x.token === req.params.ct);
  if (!t || !c) { res.status(404).json({ error: 'This link is no longer valid' }); return null; }
  if (t.status === 'ended' && Date.now() - t.endedAt > 6 * 36e5) { res.status(410).json({ error: 'This link has expired' }); return null; }
  return { t, u, c };
}
app.get('/api/circle/:tt/:ct', (req, res) => {
  const x = circleCtx(req, res); if (!x) return;
  const { t, u, c } = x;
  const alerted = t.stage >= 2 && t.status === 'active';
  const out = {
    name: u.name, role: c.role, contact: c.name, mode: t.mode, active: t.status === 'active', stage: t.status === 'active' ? t.stage : 0,
    alerted, ended: t.status === 'ended', endReason: t.endReason, emergency: u.settings.emergencyNumber, reason: t.reason,
    responders: u.contacts.filter(k => k.role === 'responder').map(k => ({ name: k.name, phone: k.phone })),
    acks: t.acks.map(a => ({ t: a.t, name: a.name, action: a.action })), now: Date.now()
  };
  if (alerted && t.consentLocation) { out.trail = t.trail.slice(-120); out.last = t.trail[t.trail.length - 1] || null; }
  res.json(out);
});
app.post('/api/circle/:tt/:ct/ack', (req, res) => {
  const x = circleCtx(req, res); if (!x) return;
  const { t, u, c } = x;
  const action = ['watching', 'heading', 'called', 'cant'].includes((req.body || {}).action) ? req.body.action : null;
  if (!action || t.status !== 'active') return res.status(400).json({ error: 'not possible now' });
  const text = { watching: 'is watching her location', heading: 'is heading to her', called: 'has called her', cant: "can't reach her right now" }[action];
  t.acks.push({ t: Date.now(), name: c.name, action }); ev(t, 'ack', `${c.name} ${text}`); save();
  res.json({ ok: true });
});

/* ---------- alert outbox (what was sent, to whom) ---------- */
app.get('/api/outbox', auth, (req, res) => res.json({ messages: db.outbox.filter(m => m.userId === req.user.id).slice(-60).reverse() }));

/* ---------- vault: client-side encrypted records with a server time seal ---------- */
app.post('/api/vault', auth, (req, res) => {
  const b = req.body || {};
  if (!b.ciphertext || !b.iv || !b.salt) return res.status(400).json({ error: 'missing fields' });
  const hash = sha(b.salt + b.iv + b.ciphertext);
  const prev = db.chain.length ? db.chain[db.chain.length - 1].seal : 'genesis';
  const sealedAt = Date.now();
  const seal = sha(prev + hash + sealedAt);
  const seq = db.chain.length + 1;
  db.chain.push({ seq, hash, prev, sealedAt, seal });
  const v = { id: id(), userId: req.user.id, title: String(b.title || 'Incident').slice(0, 80), meta: b.meta || {}, salt: b.salt, iv: b.iv, ciphertext: b.ciphertext, hash, seq, sealedAt, seal, prev };
  db.vault[v.id] = v; save();
  res.json({ id: v.id, seq, hash, sealedAt });
});
app.get('/api/vault', auth, (req, res) => {
  res.json({ items: Object.values(db.vault).filter(v => v.userId === req.user.id).sort((a, b) => b.sealedAt - a.sealedAt).map(v => ({ id: v.id, title: v.title, meta: v.meta, seq: v.seq, sealedAt: v.sealedAt, hash: v.hash })) });
});
app.get('/api/vault/:vid', auth, (req, res) => {
  const v = db.vault[req.params.vid]; if (!v || v.userId !== req.user.id) return res.status(404).end();
  res.json(v);
});
app.get('/api/vault/:vid/verify', auth, (req, res) => {
  const v = db.vault[req.params.vid]; if (!v || v.userId !== req.user.id) return res.status(404).end();
  const hash = sha(v.salt + v.iv + v.ciphertext);
  const seal = sha(v.prev + hash + v.sealedAt);
  res.json({ contentIntact: hash === v.hash, sealIntact: seal === v.seal, seq: v.seq, sealedAt: v.sealedAt, hash: v.hash });
});
app.delete('/api/vault/:vid', auth, (req, res) => {
  const v = db.vault[req.params.vid]; if (!v || v.userId !== req.user.id) return res.status(404).end();
  delete db.vault[req.params.vid]; save(); res.json({ ok: true });
});

/* ---------- complaint draft: facts in, editable draft out (she reviews before sharing) ---------- */
function templateDraft(f) {
  const L = [];
  L.push('DRAFT - for review and editing by the complainant. Not legal advice.');
  L.push('');
  L.push('To: [Station House Officer / Cyber Crime Portal / relevant authority]');
  L.push(`Subject: Complaint regarding an incident during a ${f.modeLabel || 'journey'} on ${f.date || '[DATE]'}`);
  L.push('');
  L.push(`I, ${f.name || '[NAME]'}, wish to report an incident that took place on ${f.date || '[DATE]'}.`);
  L.push('');
  L.push('Facts recorded by my safety app (times as logged):');
  (f.timeline || []).forEach(e => L.push(`- ${e}`));
  if (f.locationSummary) { L.push(''); L.push(`Location: ${f.locationSummary}`); }
  if (f.clips) { L.push(''); L.push(`I have ${f.clips} short audio clip(s) that I recorded with my consent.`); }
  L.push('');
  L.push('What happened (in my own words): [ADD YOUR ACCOUNT HERE]');
  L.push('Person(s) involved / vehicle details, if known: [ADD DETAILS]');
  L.push('');
  L.push('I request that this complaint be registered and the matter looked into.');
  L.push('');
  L.push(`Signed: ${f.name || '[NAME]'}      Contact: [PHONE]`);
  return L.join('\n');
}
app.post('/api/draft', auth, async (req, res) => {
  const f = (req.body || {}).facts || {};
  const safe = JSON.stringify(f).slice(0, 8000);
  if (LLM_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': LLM_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: LLM_MODEL, max_tokens: 1200,
          system: 'You help a woman prepare a complaint draft from facts logged by her safety app. Use ONLY the facts provided. Do not invent events, people, vehicles or accusations. Keep a neutral, factual tone. Leave clear [PLACEHOLDERS] for anything unknown, especially her own account of what happened. Start with a line saying it is a draft for her review and not legal advice. Plain text only.',
          messages: [{ role: 'user', content: `Facts (JSON):\n${safe}\n\nWrite the complaint draft.` }]
        })
      });
      const j = await r.json();
      const text = j && j.content && j.content[0] && j.content[0].text;
      if (text) return res.json({ draft: text, source: 'ai' });
    } catch (e) { /* fall through to template */ }
  }
  res.json({ draft: templateDraft(f), source: 'template' });
});

/* ---------- Telegram: link contacts when they press Start on the bot link ---------- */
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function pollTelegram() {
  let offset = 0;
  try { const me = await tg('getMe'); if (me.ok) { BOT_USER = me.result.username; console.log('Telegram bot ready: @' + BOT_USER); } } catch (e) { console.error('Telegram getMe failed', e.message); }
  for (;;) {
    try {
      const j = await tg('getUpdates', { offset, timeout: 25 });
      for (const up of (j.result || [])) {
        offset = up.update_id + 1;
        const m = up.message; if (!m || !m.text) continue;
        const mt = /^\/start\s+(\w+)/.exec(m.text);
        if (!mt) { await tg('sendMessage', { chat_id: m.chat.id, text: 'Hi. Open the invite link that your friend sent you from Dhaaga to join her safety circle.' }); continue; }
        let found = null;
        for (const u of Object.values(db.users)) { const c = u.contacts.find(x => x.joinCode === mt[1]); if (c) { c.chatId = m.chat.id; found = { u, c }; } }
        if (found) { save(); await tg('sendMessage', { chat_id: m.chat.id, text: `You are now in ${found.u.name}'s safety circle as ${found.c.role === 'responder' ? 'her Responder' : 'a trusted contact'}. You will only hear from me if a check-in goes unanswered. She can remove you any time.` }); }
        else await tg('sendMessage', { chat_id: m.chat.id, text: 'That invite link is not valid any more.' });
      }
    } catch (e) { await new Promise(r => setTimeout(r, 4000)); }
  }
}
if (TG) pollTelegram();

if (require.main === module) {
  app.listen(PORT, () => console.log(`Dhaaga running on ${BASE()}  (Telegram: ${TG ? 'on' : 'off - alerts go to the in-app outbox'}, AI draft: ${LLM_KEY ? 'on' : 'template'})`));
}
module.exports = app;
