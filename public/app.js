'use strict';
/* Dhaaga front end - plain JS, no build step. */
const $app = document.getElementById('app');
const S = {
  token: localStorage.getItem('dhaaga_token') || '', me: null, cfg: {}, view: 'home', thread: null, lastEnded: null,
  setup: null, unlocked: false, vaultPass: '', vaultItems: null, vaultOpen: null, outbox: null, toast: '', editing: null
};
const MODES = {
  cab: { label: 'Cab ride', sub: 'Intervals or milestones' },
  walk: { label: 'Walking home', sub: 'Shorter check-ins' },
  meeting: { label: 'Meeting someone', sub: 'Scheduled check-ins' }
};
const STAGE_NAMES = ['Held', 'Check', 'Connect', 'Escalate'];

/* ---------- helpers ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDT = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const mmss = (ms) => { ms = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(ms / 60)).padStart(2, '0') + ':' + String(ms % 60).padStart(2, '0'); };
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-token': S.token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.status = r.status; throw e; }
  return j;
}
function toast(msg) { S.toast = msg; render(); clearTimeout(toast.t); toast.t = setTimeout(() => { S.toast = ''; render(); }, 3200); }
const ICON = {
  thread: '<path d="M3 12c3-6 6 6 9 0s6 6 9 0"/>',
  circle: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5"/>',
  vault: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>'
};
const svg = (n, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
const logo = '<svg width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="#F4B860" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 18c4-10 8 10 12 0s8 10 12 0"/></svg>';
const b64 = {
  enc: (buf) => { let s = ''; new Uint8Array(buf).forEach(b => s += String.fromCharCode(b)); return btoa(s); },
  dec: (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0))
};

/* ---------- boot ---------- */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  S.cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  if (S.token) {
    try { await loadMe(); } catch (e) { if (e.status === 401) { localStorage.removeItem('dhaaga_token'); S.token = ''; } }
  }
  if (S.me && S.me.settings.disguise) { S.view = 'calc'; }
  render();
}
async function loadMe() {
  const j = await api('GET', '/api/me');
  S.me = j.user;
  if (j.activeThreadId) { const a = await api('GET', '/api/threads/active'); setThread(a.thread); S.view = S.view === 'home' ? 'thread' : S.view; }
  else if (S.thread && S.thread.status === 'active') setThread(null);
}
function setThread(t) {
  const prevStage = S.thread ? S.thread.stage : 0;
  S.thread = t;
  if (t && t.status === 'active') { startTracking(); } else { stopTracking(); }
  if (t && t.status === 'ended') { S.lastEnded = t.id; }
  if (t && t.stage !== prevStage && t.stage > 0 && navigator.vibrate) {
    // stage 1 is the only stage that should be felt - the discreet nudge. Later stages stay quiet on her screen.
    if (t.stage === 1) navigator.vibrate([200, 100, 200]);
  }
}

/* ---------- live tracking: polling, location, wake lock, shake ---------- */
let pollT = null, watchId = null, flushT = null, buf = [], wake = null, shakeOn = false, lastShake = 0, holdT = null;
function startTracking() {
  if (!pollT) pollT = setInterval(pollThread, 2000);
  if (!flushT) flushT = setInterval(flushLoc, 6000);
  if (S.thread && S.thread.consentLocation && watchId === null && navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(p => buf.push({ t: Date.now(), lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }), () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
  }
  if ('wakeLock' in navigator && !wake) navigator.wakeLock.request('screen').then(w => { wake = w; w.addEventListener('release', () => { wake = null; }); }).catch(() => {});
  if (S.me && S.me.settings.silentTrigger && !shakeOn) { shakeOn = true; window.addEventListener('devicemotion', onMotion); }
}
function stopTracking() {
  clearInterval(pollT); pollT = null; clearInterval(flushT); flushT = null;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (wake) { wake.release().catch(() => {}); wake = null; }
  if (shakeOn) { window.removeEventListener('devicemotion', onMotion); shakeOn = false; }
  buf = [];
}
async function flushLoc() {
  if (!buf.length || !S.thread) return;
  const pts = buf.splice(0, buf.length);
  try { await api('POST', `/api/threads/${S.thread.id}/loc`, { points: pts }); } catch (e) { buf.unshift(...pts); }
}
let lastSig = '';
async function pollThread() {
  if (!S.thread) return;
  try {
    const j = await api('GET', `/api/threads/${S.thread.id}`);
    const sig = JSON.stringify([j.thread.stage, j.thread.status, j.thread.events.length, j.thread.nextKnotAt, j.thread.acks.length]);
    setThread(j.thread);
    if (sig !== lastSig) { lastSig = sig; if (S.view === 'thread') render(); }
  } catch (e) { /* offline: server keeps running the escalation anyway */ }
}
function onMotion(e) {
  const a = e.accelerationIncludingGravity; if (!a) return;
  const g = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
  const now = Date.now();
  if (g > 28) { if (now - lastShake < 1500 && now - lastShake > 150) { lastShake = 0; silentAlert(); } else lastShake = now; }
}
async function silentAlert() {
  if (!S.thread || S.thread.status !== 'active' || S.thread.stage >= 2) return;
  if (navigator.vibrate) navigator.vibrate(40); // the only feedback: a tiny buzz
  try { const j = await api('POST', `/api/threads/${S.thread.id}/alert`, { kind: 'silent' }); setThread(j.thread); } catch (e) {}
}

/* ---------- rendering ---------- */
function render() {
  if (!S.token || !S.me) { $app.innerHTML = vOnboard(); bindCommon(); return; }
  let body;
  if (S.view === 'calc') { $app.innerHTML = vCalc(); bindCalc(); return; }
  switch (S.view) {
    case 'thread': body = vThread(); break;
    case 'circle': body = vCircle(); break;
    case 'vault': body = vVault(); break;
    case 'settings': body = vSettings(); break;
    case 'summary': body = vSummary(); break;
    default: body = vHome();
  }
  const cur = (v) => (S.view === v || (v === 'thread' && ['home', 'summary'].includes(S.view))) ? ' aria-current="page"' : '';
  $app.innerHTML = `<main class="screen">${body}</main>
  <nav class="nav" aria-label="Main">
    <button class="tab" data-go="${S.thread && S.thread.status === 'active' ? 'thread' : 'home'}"${cur('thread')}>${svg('thread')}Thread</button>
    <button class="tab" data-go="circle"${cur('circle')}>${svg('circle')}Circle</button>
    <button class="tab" data-go="vault"${cur('vault')}>${svg('vault')}Vault</button>
    <button class="tab" data-go="settings"${cur('settings')}>${svg('gear')}Settings</button>
  </nav>${S.toast ? `<div class="toast" role="status">${esc(S.toast)}</div>` : ''}`;
  bindCommon();
  if (S.view === 'thread') tickRing();
}
function bindCommon() {
  $app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  $app.querySelectorAll('[data-act]').forEach(b => b.onclick = () => actions[b.dataset.act](b.dataset, b));
  const h = $app.querySelector('#ringHold');
  if (h) {
    const start = () => { if (!S.me.settings.silentTrigger) return; clearTimeout(holdT); holdT = setTimeout(silentAlert, 1800); };
    const stop = () => clearTimeout(holdT);
    ['pointerdown'].forEach(e => h.addEventListener(e, start));
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(e => h.addEventListener(e, stop));
    h.addEventListener('contextmenu', e => e.preventDefault());
  }
}
async function go(v) {
  S.view = v;
  if (v === 'circle') { render(); try { S.outbox = (await api('GET', '/api/outbox')).messages; } catch (e) {} }
  if (v === 'vault') { render(); try { S.vaultItems = (await api('GET', '/api/vault')).items; } catch (e) {} }
  if (v === 'home' || v === 'thread') { try { await loadMe(); } catch (e) {} if (S.thread && S.thread.status === 'active') S.view = 'thread'; else if (v === 'thread') S.view = 'home'; }
  render();
}

/* ---------- onboarding ---------- */
function vOnboard() {
  return `<main class="screen" style="justify-content:center;min-height:100vh">
    <div class="brand">${logo}Dhaaga</div>
    <h1>She shouldn't have to be the one who presses the button.</h1>
    <p class="muted">Start a safety thread for a ride, a walk or a meeting. Miss a check-in and help moves closer, step by step. A missed check-in is treated as a reason to check on you, never as proof that something happened.</p>
    <label class="field">What should your circle call you?<input id="nm" autocomplete="given-name" maxlength="40" placeholder="First name"></label>
    <div class="info">No password for this prototype: your account lives on this device. Location is used only while a thread runs and only with your consent.</div>
    <button class="btn" data-act="register">Create my safe space ${svg('arrow', 20)}</button>
  </main>`;
}

/* ---------- home / setup ---------- */
function defaultSetup(mode) {
  const s = { mode, loc: S.me.settings.locationDefault, audio: false, kind: 'interval', interval: mode === 'walk' ? 180 : 600, schedule: [] };
  if (mode === 'cab') s.schedule = [{ label: 'Left pickup point', min: 3 }, { label: 'Halfway', min: 12 }, { label: 'Reached home', min: 25 }];
  if (mode === 'meeting') { s.kind = 'scheduled'; s.schedule = [{ label: 'First check-in', min: 30 }, { label: 'Second check-in', min: 60 }, { label: 'Finished', min: 90 }]; }
  return s;
}
function vHome() {
  if (!S.setup) S.setup = defaultSetup('cab');
  const st = S.setup, m = S.me;
  const noResp = !m.contacts.some(c => c.role === 'responder');
  const presets = st.mode === 'walk' ? [[120, '2 min'], [180, '3 min'], [300, '5 min'], [30, '30 s demo']] : [[300, '5 min'], [600, '10 min'], [900, '15 min'], [30, '30 s demo']];
  let cfg = '';
  if (st.mode === 'cab') {
    cfg += `<div class="pills" role="group" aria-label="Check-in style"><button class="pill" aria-pressed="${st.kind === 'interval'}" data-act="kind" data-k="interval">At intervals</button><button class="pill" aria-pressed="${st.kind === 'milestones'}" data-act="kind" data-k="milestones">At journey milestones</button></div>`;
  }
  if (st.mode === 'walk' || (st.mode === 'cab' && st.kind === 'interval')) {
    cfg += `<div><div class="label" style="margin-bottom:8px">Check in every</div><div class="pills" role="group" aria-label="Interval">${presets.map(p => `<button class="pill" aria-pressed="${st.interval === p[0]}" data-act="interval" data-v="${p[0]}">${p[1]}</button>`).join('')}</div></div>`;
  } else {
    const demo = st.mode === 'meeting' ? 'Scheduled check-ins' : 'Milestones';
    cfg += `<div class="label">${demo} (minutes from now)</div>` + st.schedule.map((x, i) => `<div class="ms"><input aria-label="Label ${i + 1}" data-ms="label" data-i="${i}" value="${esc(x.label)}" maxlength="40"><input aria-label="Minutes ${i + 1}" data-ms="min" data-i="${i}" type="number" min="0.1" step="0.5" value="${x.min}"><button class="x" aria-label="Remove" data-act="msdel" data-i="${i}">×</button></div>`).join('')
      + `<div class="row"><button class="btn ghost small" data-act="msadd">+ Add</button><button class="btn ghost small" data-act="msdemo">Demo timings</button></div>`;
  }
  const active = S.thread && S.thread.status === 'active';
  return `<div class="row between"><div class="brand">${logo}Dhaaga</div><span class="chip"><span class="dot"></span>${active ? 'Thread running' : 'Thread calm'}</span></div>
    <h1>${active ? 'A thread is running.' : `Where to tonight, ${esc(m.name)}?`}</h1>
    ${active ? `<button class="btn" data-go="thread">Open my thread ${svg('arrow', 20)}</button>` : `
    <div class="modes" role="group" aria-label="Journey type">${Object.entries(MODES).map(([k, v]) => `<button class="mode" aria-pressed="${st.mode === k}" data-act="mode" data-m="${k}"><b>${v.label}</b><span>${v.sub}</span></button>`).join('')}</div>
    <div class="card" style="display:flex;flex-direction:column;gap:12px">${cfg}</div>
    <div class="card tight">
      <label class="sw"><span class="t"><b>Record my location trail</b><span>Only during this thread. Shared with your circle only if an alert reaches the Connect stage.</span></span><input type="checkbox" id="optLoc" ${st.loc ? 'checked' : ''}></label>
      ${m.settings.audioAllowed ? `<label class="sw"><span class="t"><b>Allow a short audio clip</b><span>Off by default. You start it yourself, and it stays on this device until you save it to your vault.</span></span><input type="checkbox" id="optAudio" ${st.audio ? 'checked' : ''}></label>` : ''}
    </div>
    ${noResp ? `<div class="notice">You haven't chosen a Responder yet. They get the first alert. <a href="#" data-go="circle" style="color:var(--amber)">Set up your circle</a></div>` : ''}
    <button class="btn" data-act="start">Start a thread ${svg('arrow', 20)}</button>`}`;
}

/* ---------- live thread ---------- */
function vThread() {
  const t = S.thread;
  if (!t) return vHome();
  if (t.status === 'ended') return vSummary();
  const s = S.me.settings, st = t.stage;
  const responders = S.me.contacts.filter(c => c.role === 'responder');
  const names = ['Held', 'Check', 'Connect', 'Escalate'];
  const chipCls = st === 0 ? '' : st === 1 ? '' : 'warn';
  let panel = '';
  if (st === 1) panel = `<div class="card" style="border-color:var(--amber)"><div class="label" style="color:var(--amber)">Stage 1 · Check</div><h2 style="margin-top:6px">Are you okay?</h2><p class="muted small" style="margin-top:6px">Answer within <b id="graceLeft"></b>. If you don't, your Responder will be alerted. This is just a check, not an alarm.</p><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px"><button class="btn" data-act="knot">${svg('check', 20)} I'm okay</button><button class="btn danger" data-act="help">I need help</button></div></div>`;
  if (st === 2) panel = `<div class="card" style="border-color:var(--coral)"><div class="label" style="color:var(--coral)">Stage 2 · Connect</div><h2 style="margin-top:6px">Your Responder has been alerted.</h2><p class="muted small" style="margin-top:6px">They have a temporary location link. If nobody answers, more trusted contacts are alerted in <b id="graceLeft"></b>.</p><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px"><button class="btn" data-act="knot">${svg('check', 20)} I'm safe - cancel the alert</button>${responders.filter(r => r.phone).map(r => `<a class="btn ghost" href="tel:${esc(r.phone)}">Call ${esc(r.name)}</a>`).join('')}<a class="btn danger" href="tel:${esc(s.emergencyNumber)}">Call ${esc(s.emergencyNumber)}</a></div></div>`;
  if (st === 3) panel = `<div class="card" style="border-color:var(--coral)"><div class="label" style="color:var(--coral)">Stage 3 · Escalate</div><h2 style="margin-top:6px">Your trusted contacts are alerted.</h2><p class="muted small" style="margin-top:6px">Emergency options are below. Calling is always your choice.</p><div style="display:flex;flex-direction:column;gap:10px;margin-top:12px"><a class="btn coral" href="tel:${esc(s.emergencyNumber)}">Call ${esc(s.emergencyNumber)} now</a>${responders.filter(r => r.phone).map(r => `<a class="btn ghost" href="tel:${esc(r.phone)}">Call ${esc(r.name)}</a>`).join('')}<button class="btn" data-act="knot">${svg('check', 20)} I'm safe - cancel the alert</button></div></div>`;
  const ringInfo = st === 0 ? `<div class="label">${esc(t.nextLabel)} in</div><div class="big" id="ringTime">--:--</div><div class="small muted" id="ringSub"></div>` : `<div class="label">Stage ${st}</div><div class="big" style="font-size:36px">${names[st]}</div><div class="small muted" id="ringSub">${st === 1 ? 'waiting for you' : ''}</div>`;
  return `<div class="row between"><span class="chip ${chipCls}"><span class="dot"></span>${MODES[t.mode].label} · ${names[st]}</span><span class="chip">${t.consentLocation ? 'Trail on' : 'Trail off'}</span></div>
    <h1>${st === 0 ? 'Your thread is held.' : st === 1 ? 'Checking in.' : 'Help is moving.'}</h1>
    <p class="muted small">${t.type === 'interval' ? 'Tie a knot before the timer ends. If you can\'t, it simply asks if you\'re okay first.' : `${t.schedule.filter(x => !x.done).length} check-in(s) left. Tie each one when you reach it.`}</p>
    <div class="ringwrap" id="ringHold" aria-label="Check-in countdown"><svg width="240" height="240" viewBox="0 0 240 240" fill="none" aria-hidden="true"><circle cx="120" cy="120" r="102" stroke="#2C2440" stroke-width="10"/><circle id="ringArc" cx="120" cy="120" r="102" stroke="${st === 0 ? '#F4B860' : '#F0645B'}" stroke-width="10" stroke-linecap="round" stroke-dasharray="641" stroke-dashoffset="0" transform="rotate(-90 120 120)"/></svg><div class="mid">${ringInfo}</div></div>
    ${st === 0 ? `<button class="btn" data-act="knot">${svg('check', 20)} Tie the knot. I'm safe.</button>` : panel}
    ${s.silentTrigger && st < 2 ? `<p class="tiny muted" style="text-align:center">Discreet trigger: hold the ring for 2 seconds, or shake twice. Works while this app is open. Phones can limit this when locked.</p>` : ''}
    ${t.acks.length ? `<div class="card"><div class="label">From your circle</div><div class="tl" style="margin-top:6px">${t.acks.map(a => `<div><time>${fmtT(a.t)}</time><span>${esc(a.name)} ${({ watching: 'is watching your location', heading: 'is heading to you', called: 'called you', cant: "couldn't reach you" })[a.action]}</span></div>`).join('')}</div></div>` : ''}
    ${t.consentAudio ? `<div class="card row between"><span class="small muted">Optional audio clip (stays on this device)</span><button class="btn ghost small" data-act="rec" id="recBtn">Record 20 s</button></div>` : ''}
    <details><summary>Activity log (${t.events.length})</summary><div class="tl card">${t.events.slice().reverse().map(e => `<div><time>${fmtT(e.t)}</time><span>${esc(e.detail)}</span></div>`).join('')}</div></details>
    <button class="btn ghost" data-act="end">End thread - I've arrived safely</button>
    <button class="pill small tiny" style="align-self:center;min-height:44px" data-act="demomiss">Demo tool: make the next check-in due now</button>`;
}
function tickRing() {
  if (S.view !== 'thread' || !S.thread || S.thread.status !== 'active') return;
  const t = S.thread, s = S.me.settings, now = Date.now();
  const arc = document.getElementById('ringArc');
  let frac = 1;
  if (t.stage === 0) {
    const total = t.type === 'interval' ? t.intervalSec * 1000 : Math.max(1000, t.nextKnotAt - (S.lastTie || t.startedAt));
    const left = t.nextKnotAt - now; frac = Math.max(0, Math.min(1, left / total));
    const el = document.getElementById('ringTime'); if (el) el.textContent = mmss(left);
    const sub = document.getElementById('ringSub'); if (sub) sub.textContent = t.type === 'interval' ? `of ${mmss(t.intervalSec * 1000)}` : `check-in ${t.schedule.filter(x => x.done).length + 1} of ${t.schedule.length}`;
  } else {
    const dur = (t.stage === 1 ? s.stage1Sec : t.stage === 2 ? s.stage2Sec : 0) * 1000;
    const left = t.stageAt + dur - now; frac = dur ? Math.max(0, Math.min(1, left / dur)) : 1;
    const g = document.getElementById('graceLeft'); if (g) g.textContent = mmss(left);
    if (t.stage === 1) { const sub = document.getElementById('ringSub'); if (sub) sub.textContent = mmss(left) + ' left to answer'; }
  }
  if (arc) arc.setAttribute('stroke-dashoffset', String(641 * (1 - frac)));
}
setInterval(tickRing, 250);

/* ---------- summary after a thread ---------- */
function vSummary() {
  const t = S.thread;
  if (!t) { S.view = 'home'; return vHome(); }
  const alerted = t.events.some(e => e.type.startsWith('stage') && +e.type.slice(5) >= 2);
  return `<div class="brand">${logo}Dhaaga</div><h1>Thread ended.</h1>
    <p class="muted">${alerted ? 'An alert was raised during this thread. Your circle was told you are safe.' : 'No alerts were needed. Glad you got there.'}</p>
    <div class="card"><div class="label">What was recorded</div><div class="tl" style="margin-top:6px">${t.events.map(e => `<div><time>${fmtT(e.t)}</time><span>${esc(e.detail)}</span></div>`).join('')}</div>
    <p class="small muted" style="margin-top:8px">${t.trail.length} location point(s). ${t.consentLocation ? '' : 'Location was off.'}</p></div>
    <div class="info">The server deletes this record 24 hours after the thread ends. Save it to your encrypted vault only if you want to keep it.</div>
    <button class="btn" data-act="tovault">Save to my encrypted vault</button>
    <button class="btn ghost" data-act="discard">Done, don't keep it</button>`;
}

/* ---------- circle ---------- */
function vCircle() {
  const m = S.me, s = m.settings;
  const bot = S.cfg.telegram && S.cfg.bot;
  const rows = m.contacts.map((c, i) => `<div class="contact">
      <div class="avatar" aria-hidden="true">${esc(c.name[0] || '?').toUpperCase()}</div>
      <div class="grow"><b>${esc(c.name)}</b><div class="small muted">${c.role === 'responder' ? 'Responder · alerted first' : 'Trusted · alerted if unresolved'} · ${c.joined ? 'ready' : 'not joined yet'}</div>
      ${!c.joined ? (bot ? `<div class="small"><a style="color:var(--amber)" target="_blank" rel="noopener" href="https://t.me/${esc(S.cfg.bot)}?start=${esc(c.joinCode)}">Telegram invite link</a> · send it to ${esc(c.name)}</div>` : `<button class="pill small" style="min-height:44px;margin-top:6px" data-act="joindemo" data-id="${c.id}">Mark as joined (demo)</button>`) : ''}</div>
      <div class="row"><button class="icon" aria-label="Move up" data-act="up" data-id="${c.id}" ${i === 0 ? 'disabled' : ''}>↑</button><button class="icon" aria-label="Move down" data-act="down" data-id="${c.id}" ${i === m.contacts.length - 1 ? 'disabled' : ''}>↓</button><button class="icon" aria-label="Remove ${esc(c.name)}" data-act="delc" data-id="${c.id}">×</button></div></div>`).join('');
  return `<div class="brand">${logo}Circle</div>
    <p class="muted small">The Responder is alerted first. If the situation stays unresolved, your trusted contacts are alerted next, in the order shown. They open a link: no app needed.</p>
    <div class="card tight">${rows || '<p class="muted small" style="padding:12px 0">Nobody yet. Add a Responder first.</p>'}</div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px"><h2>Add someone</h2>
      <label class="field">Name<input id="cName" maxlength="40"></label>
      <label class="field">Phone (for call buttons)<input id="cPhone" inputmode="tel" placeholder="+91..."></label>
      <label class="field">Role<select id="cRole"><option value="responder">Responder - alerted first</option><option value="trusted">Trusted contact - alerted if unresolved</option></select></label>
      <button class="btn" data-act="addc">Add to circle</button></div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px"><h2>Escalation timing</h2>
      <label class="field">Seconds you have to answer "Are you okay?" (Stage 1)<input id="d1" type="number" min="10" max="900" value="${s.stage1Sec}"></label>
      <label class="field">Seconds your Responder has before others are alerted (Stage 2)<input id="d2" type="number" min="10" max="3600" value="${s.stage2Sec}"></label>
      <button class="btn ghost" data-act="savedelays">Save timing</button></div>
    <div class="card"><h2>Alert outbox</h2><p class="small muted" style="margin:6px 0 10px">${S.cfg.telegram ? 'Alerts go out via Telegram.' : 'Telegram is not configured, so alerts are shown here. Open a link to see what your contact would see.'}</p>
    ${(S.outbox || []).length ? (S.outbox || []).slice(0, 8).map(o => `<div class="msg" style="margin-bottom:8px"><div class="small muted">${fmtT(o.t)} · to ${esc(o.contact)} (${esc(o.role)}) · ${esc(o.channel)}${o.delivered ? ' · delivered' : ''}</div>${esc(o.text)}<br><a href="${esc(o.link)}" target="_blank" rel="noopener">Open circle link</a></div>`).join('') : '<p class="small muted">Nothing sent yet.</p>'}</div>`;
}

/* ---------- vault (client-side encryption) ---------- */
async function deriveKey(pass, salt) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptJSON(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { salt: b64.enc(salt), iv: b64.enc(iv), ciphertext: b64.enc(ct) };
}
async function decryptJSON(rec, pass) {
  const key = await deriveKey(pass, b64.dec(rec.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(rec.iv) }, key, b64.dec(rec.ciphertext));
  return JSON.parse(new TextDecoder().decode(pt));
}
function vVault() {
  const open = S.vaultOpen;
  const s = S.me.settings;
  if (open) return vVaultItem(open);
  const items = S.vaultItems || [];
  return `<div class="brand">${logo}Vault</div>
    <p class="muted small">Records are encrypted on your device with your passphrase before they are uploaded. Dhaaga can't read them, and can't recover your passphrase. Each save gets a time seal, which shows the record existed then and hasn't changed. It's a technical record, and no promise that any authority will accept it as evidence.</p>
    <div class="card tight">${items.length ? items.map(i => `<div class="contact"><div class="grow"><b>${esc(i.title)}</b><div class="small muted">Sealed ${fmtDT(i.sealedAt)} · seal #${i.seq}</div></div><button class="btn ghost small" data-act="vopen" data-id="${i.id}">Open</button></div>`).join('') : '<p class="muted small" style="padding:12px 0">Nothing saved. After a thread ends, you can choose to save it here.</p>'}</div>
    <div class="info">Retention: records are auto-deleted after ${s.retentionDays ? s.retentionDays + ' days' : 'never (until you delete them)'}. Change this in Settings. You can delete any record at any time.</div>`;
}
function vVaultItem(o) {
  const d = o.data;
  const lines = d.events.map(e => `<div><time>${fmtT(e.t)}</time><span>${esc(e.detail)}</span></div>`).join('');
  return `<div class="row"><button class="btn ghost small" data-act="vback">← Back</button></div>
    <h1>${esc(o.title)}</h1>
    <div class="card"><div class="label">Time seal</div><p class="small" style="margin-top:6px">Seal #${o.seq} · ${fmtDT(o.sealedAt)}<br><span class="muted" style="word-break:break-all">${esc(o.hash)}</span></p><button class="btn ghost small" style="margin-top:8px" data-act="verify" data-id="${o.id}">Verify integrity</button><p class="small" id="verifyOut" style="margin-top:8px"></p></div>
    <div class="card"><div class="label">Timeline</div><div class="tl" style="margin-top:6px">${lines}</div><p class="small muted" style="margin-top:8px">${d.trail.length} location point(s)${d.trail.length ? ` · last ${d.trail[d.trail.length - 1].lat.toFixed(4)}, ${d.trail[d.trail.length - 1].lng.toFixed(4)}` : ''}</p>${(d.clips || []).map((c, i) => `<audio controls src="${c}" style="width:100%;margin-top:8px" aria-label="Audio clip ${i + 1}"></audio>`).join('')}</div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px"><h2>Complaint draft</h2>
      <p class="small muted">Built from the facts above. Choose what goes in. Nothing is sent anywhere. ${S.cfg.llm ? 'The text of the facts you pick is processed by an AI service to word the draft.' : 'Drafted from a template on this server.'}</p>
      <label class="sw"><span class="t"><b>Include timeline</b></span><input type="checkbox" id="dTl" checked></label>
      <label class="sw"><span class="t"><b>Include location summary</b></span><input type="checkbox" id="dLoc" ${d.trail.length ? 'checked' : 'disabled'}></label>
      <button class="btn" data-act="draft">Generate draft</button>
      <textarea id="draftTxt" aria-label="Complaint draft" placeholder="Your draft appears here. Edit anything."></textarea>
      <label class="sw"><span class="t"><b>I have read and edited this draft</b><span>Copy and download unlock after you confirm.</span></span><input type="checkbox" id="dOk"></label>
      <div class="row"><button class="btn ghost small grow" data-act="copydraft">Copy</button><button class="btn ghost small grow" data-act="dldraft">Download .txt</button></div>
      <p class="tiny muted">A draft only. Not legal advice. Add your own account of what happened.</p></div>
    <button class="btn danger" data-act="vdel" data-id="${o.id}">Delete this record</button>`;
}

/* ---------- settings ---------- */
function vSettings() {
  const s = S.me.settings;
  const sw = (id, title, sub, on, dis) => `<label class="sw"><span class="t"><b>${title}</b><span>${sub}</span></span><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''}></label>`;
  return `<div class="brand">${logo}Settings</div>
    <div class="card tight">
      ${sw('sLoc', 'Location trail on by default', 'You can still change it for each thread.', s.locationDefault)}
      ${sw('sAud', 'Allow optional audio clips', 'Off by default. Never starts on its own: you press record.', s.audioAllowed)}
      ${sw('sSil', 'Discreet trigger', 'Hold the ring 2 s or shake twice to quietly ask for help. Works while the app is open on screen. A browser app cannot promise this on a locked phone.', s.silentTrigger)}
    </div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <label class="field">Your name<input id="sName" value="${esc(S.me.name)}" maxlength="40"></label>
      <label class="field">Emergency number offered in Stage 3<input id="sEm" inputmode="tel" value="${esc(s.emergencyNumber)}"></label>
      <label class="field">Delete vault records after (days, 0 = keep until I delete)<input id="sRet" type="number" min="0" max="365" value="${s.retentionDays}"></label>
      <button class="btn" data-act="savesettings">Save</button></div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px"><h2>Optional: calculator disguise</h2>
      <p class="small muted">An extra, not something to rely on. With it on, Dhaaga opens as a calculator. Your PIN + "=" opens the app. Your safety PIN + "=" quietly raises a Stage 2 alert and keeps showing the calculator. It can't hide notifications or the app itself, and it only works while the app is running.</p>
      <label class="field">PIN to open Dhaaga (4-8 digits)<input id="pin1" inputmode="numeric" maxlength="8" autocomplete="off"></label>
      <label class="field">Safety PIN (different, 4-8 digits)<input id="pin2" inputmode="numeric" maxlength="8" autocomplete="off"></label>
      <button class="btn ghost" data-act="savepin">Save PINs</button>
      ${sw('sDis', 'Open as a calculator', s.hasPin ? 'Active after you reload the app.' : 'Set PINs first.', s.disguise, !s.hasPin)}</div>
    <button class="btn danger" data-act="wipe">Delete my account and all data</button>
    <p class="tiny muted">Dhaaga prototype · recHERsion 2026. Third-party credits are in the README.</p>`;
}

/* ---------- calculator disguise ---------- */
let calcExpr = '';
function vCalc() {
  const k = (l, c = '', a = '') => `<button class="${c}" ${a} data-k="${l}">${l}</button>`;
  return `<div class="calc"><div class="disp" id="cd">${esc(calcExpr || '0')}</div><div class="keys">
    ${k('AC', 'f')}${k('±', 'f')}${k('%', 'f')}${k('÷', 'o')}${k('7')}${k('8')}${k('9')}${k('×', 'o')}${k('4')}${k('5')}${k('6')}${k('−', 'o')}${k('1')}${k('2')}${k('3')}${k('+', 'o')}${k('0', 'z')}${k('.')}${k('=', 'o')}</div></div>`;
}
function bindCalc() {
  $app.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => {
    const k = b.dataset.k, d = document.getElementById('cd');
    if (k === 'AC') calcExpr = '';
    else if (k === '=') {
      if (/^[0-9]{4,8}$/.test(calcExpr)) {
        const r = await api('POST', '/api/pin/check', { pin: calcExpr }).catch(() => ({ result: 'no' }));
        if (r.result === 'open') { calcExpr = ''; S.unlocked = true; S.view = 'home'; await loadMe(); if (S.thread && S.thread.status === 'active') S.view = 'thread'; return render(); }
        if (r.result === 'stay') { calcExpr = ''; return d.textContent = '0'; }
      }
      try { const ex = calcExpr.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-'); if (/^[0-9+\-*/.() ]+$/.test(ex)) calcExpr = String(Function('"use strict";return (' + ex + ')')()).slice(0, 12); } catch (e) { calcExpr = ''; }
    } else if (k === '±') calcExpr = calcExpr.startsWith('-') ? calcExpr.slice(1) : '-' + calcExpr;
    else if (k === '%') { try { calcExpr = String(parseFloat(calcExpr) / 100); } catch (e) {} }
    else calcExpr = (calcExpr + k).slice(0, 14);
    d.textContent = calcExpr || '0';
  });
}

/* ---------- actions ---------- */
const val = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
const chk = (id) => { const e = document.getElementById(id); return e ? e.checked : false; };
let lastDraft = '';
const actions = {
  async register() {
    const name = val('nm').trim(); if (!name) return toast('Please add a name');
    const j = await api('POST', '/api/register', { name }).catch(e => { toast(e.message); return null; }); if (!j) return;
    S.token = j.token; localStorage.setItem('dhaaga_token', j.token); S.me = j.user; S.view = 'circle'; render(); go('circle');
  },
  mode(d) { S.setup = defaultSetup(d.m); render(); },
  kind(d) { S.setup.kind = d.k; render(); },
  interval(d) { S.setup.interval = +d.v; render(); },
  msadd() { syncMs(); S.setup.schedule.push({ label: 'Check-in', min: (S.setup.schedule.length ? +S.setup.schedule[S.setup.schedule.length - 1].min : 0) + 10 }); render(); },
  msdel(d) { syncMs(); S.setup.schedule.splice(+d.i, 1); render(); },
  msdemo() { syncMs(); S.setup.schedule.forEach((x, i) => x.min = 0.5 * (i + 1)); render(); },
  async start() {
    syncMs(); const st = S.setup; st.loc = chk('optLoc'); st.audio = chk('optAudio');
    const body = { mode: st.mode, consentLocation: st.loc, consentAudio: st.audio };
    if (st.mode === 'meeting' || (st.mode === 'cab' && st.kind === 'milestones')) {
      if (!st.schedule.length) return toast('Add at least one check-in');
      body.schedule = st.schedule.map(x => ({ label: x.label, afterSec: Math.round((+x.min || 1) * 60) }));
    } else body.intervalSec = st.interval;
    if (st.loc && navigator.geolocation) navigator.geolocation.getCurrentPosition(() => {}, () => {}); // prompts permission up front
    try { const j = await api('POST', '/api/threads', body); lastSig = ''; S.lastTie = 0; setThread(j.thread); S.view = 'thread'; render(); } catch (e) { toast(e.message); }
  },
  async knot() {
    try { const j = await api('POST', `/api/threads/${S.thread.id}/knot`); const wasEnded = j.thread.status === 'ended'; S.lastTie = Date.now(); setThread(j.thread); if (wasEnded) S.view = 'summary'; render(); if (!wasEnded) toast('Knot tied. Thread held.'); } catch (e) { toast(e.message); }
  },
  async help() { try { const j = await api('POST', `/api/threads/${S.thread.id}/alert`, { kind: 'help' }); setThread(j.thread); render(); } catch (e) { toast(e.message); } },
  async demomiss() { try { const j = await api('POST', `/api/threads/${S.thread.id}/demo-miss`); setThread(j.thread); render(); } catch (e) { toast(e.message); } },
  async end() {
    if (!confirm('End this thread? ' + (S.thread.stage >= 2 ? 'Your circle will be told you are safe.' : ''))) return;
    try { await flushLoc(); const j = await api('POST', `/api/threads/${S.thread.id}/end`); setThread(j.thread); S.view = 'summary'; render(); } catch (e) { toast(e.message); }
  },
  discard() { S.thread = null; S.view = 'home'; S.setup = null; render(); },
  rec(d, btn) {
    if (!navigator.mediaDevices) return toast('Recording is not supported here');
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const mr = new MediaRecorder(stream), chunks = []; btn.disabled = true; btn.textContent = 'Recording...';
      mr.ondataavailable = e => chunks.push(e.data);
      mr.onstop = () => { stream.getTracks().forEach(t => t.stop()); const r = new FileReader(); r.onload = () => { const k = 'dhaaga_clips_' + S.thread.id; const a = JSON.parse(localStorage.getItem(k) || '[]'); a.push(r.result); localStorage.setItem(k, JSON.stringify(a)); toast('Clip saved on this device'); render(); }; r.readAsDataURL(new Blob(chunks, { type: mr.mimeType })); };
      mr.start(); setTimeout(() => mr.state === 'recording' && mr.stop(), 20000);
    }).catch(() => toast('Microphone permission was not given'));
  },
  async tovault() {
    const t = S.thread; if (!t) return;
    const pass = S.vaultPass || prompt('Choose a vault passphrase. It encrypts this record on your device. If you forget it, the record cannot be recovered.');
    if (!pass) return; if (pass.length < 6) return toast('Use at least 6 characters');
    S.vaultPass = pass;
    const clips = JSON.parse(localStorage.getItem('dhaaga_clips_' + t.id) || '[]');
    const data = { mode: t.mode, startedAt: t.startedAt, endedAt: t.endedAt, events: t.events, trail: t.trail, clips };
    try {
      const enc = await encryptJSON(data, pass);
      const j = await api('POST', '/api/vault', { title: `${MODES[t.mode].label} · ${fmtDT(t.startedAt)}`, meta: { mode: t.mode, events: t.events.length, clips: clips.length }, ...enc });
      localStorage.removeItem('dhaaga_clips_' + t.id);
      toast(`Saved and sealed (#${j.seq})`); S.thread = null; S.setup = null; S.view = 'vault'; go('vault');
    } catch (e) { toast(e.message); }
  },
  async vopen(d) {
    const pass = S.vaultPass || prompt('Vault passphrase'); if (!pass) return;
    try { const rec = await api('GET', `/api/vault/${d.id}`); const data = await decryptJSON(rec, pass); S.vaultPass = pass; S.vaultOpen = { ...rec, data }; render(); } catch (e) { S.vaultPass = ''; toast('Wrong passphrase, or the record is damaged'); }
  },
  vback() { S.vaultOpen = null; render(); },
  async verify(d) {
    const r = await api('GET', `/api/vault/${d.id}/verify`);
    document.getElementById('verifyOut').textContent = r.contentIntact && r.sealIntact ? `Intact. Sealed ${fmtDT(r.sealedAt)} as #${r.seq}; content and chain match.` : 'Warning: this record does not match its seal.';
  },
  async vdel(d) { if (!confirm('Delete this record permanently?')) return; await api('DELETE', `/api/vault/${d.id}`); S.vaultOpen = null; S.vaultItems = (await api('GET', '/api/vault')).items; render(); toast('Deleted'); },
  async draft() {
    const o = S.vaultOpen.data, facts = { name: S.me.name, modeLabel: MODES[o.mode].label, date: new Date(o.startedAt).toLocaleDateString() };
    if (chk('dTl')) facts.timeline = o.events.map(e => `${fmtT(e.t)} - ${e.detail}`);
    if (chk('dLoc') && o.trail.length) { const a = o.trail[0], z = o.trail[o.trail.length - 1]; facts.locationSummary = `trail of ${o.trail.length} points from about ${a.lat.toFixed(4)}, ${a.lng.toFixed(4)} to ${z.lat.toFixed(4)}, ${z.lng.toFixed(4)}`; }
    if ((o.clips || []).length) facts.clips = o.clips.length;
    document.getElementById('draftTxt').value = 'Writing...';
    try { const r = await api('POST', '/api/draft', { facts }); document.getElementById('draftTxt').value = r.draft; } catch (e) { toast(e.message); }
  },
  copydraft() { if (!chk('dOk')) return toast('Confirm you have read and edited the draft first'); navigator.clipboard.writeText(val('draftTxt')).then(() => toast('Copied')); },
  dldraft() {
    if (!chk('dOk')) return toast('Confirm you have read and edited the draft first');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([val('draftTxt')], { type: 'text/plain' })); a.download = 'complaint-draft.txt'; a.click();
  },
  async addc() {
    const name = val('cName').trim(); if (!name) return toast('Add a name');
    try { S.me = (await api('POST', '/api/contacts', { name, phone: val('cPhone'), role: val('cRole') })).user; render(); } catch (e) { toast(e.message); }
  },
  async delc(d) { S.me = (await api('DELETE', `/api/contacts/${d.id}`)).user; render(); },
  async joindemo(d) { S.me = (await api('POST', `/api/contacts/${d.id}/join-demo`)).user; render(); },
  async up(d) { reorder(d.id, -1); }, async down(d) { reorder(d.id, 1); },
  async savedelays() { try { S.me = (await api('PUT', '/api/settings', { stage1Sec: val('d1'), stage2Sec: val('d2') })).user; toast('Timing saved'); } catch (e) { toast(e.message); } },
  async savesettings() {
    try { S.me = (await api('PUT', '/api/settings', { name: val('sName'), emergencyNumber: val('sEm'), retentionDays: val('sRet'), locationDefault: chk('sLoc'), audioAllowed: chk('sAud'), silentTrigger: chk('sSil'), disguise: chk('sDis') })).user; toast('Saved'); render(); } catch (e) { toast(e.message); }
  },
  async savepin() { try { S.me = (await api('POST', '/api/pin/set', { pin: val('pin1'), duressPin: val('pin2') })).user; toast('PINs saved'); render(); } catch (e) { toast(e.message); } },
  async wipe() {
    if (!confirm('Delete your account, circle, threads and vault records from the server? This cannot be undone.')) return;
    await api('DELETE', '/api/me'); localStorage.clear(); location.reload();
  }
};
async function reorder(id, dir) {
  const ids = S.me.contacts.map(c => c.id), i = ids.indexOf(id), j = i + dir; if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]]; S.me = (await api('POST', '/api/contacts/reorder', { ids })).user; render();
}
function syncMs() { // read milestone inputs back into state before any re-render
  document.querySelectorAll('[data-ms]').forEach(el => { const x = S.setup.schedule[+el.dataset.i]; if (x) x[el.dataset.ms] = el.dataset.ms === 'min' ? (parseFloat(el.value) || 1) : el.value; });
}
boot();
