'use strict';
// End-to-end smoke test of the whole safety flow against a real running server.
// Run: npm test   (takes about 30 seconds because it waits for real escalation timers)
const os = require('os'), path = require('path'), assert = require('assert');
process.env.DB_FILE = path.join(os.tmpdir(), `dhaaga-test-${Date.now()}.json`);
process.env.BASE_URL = 'http://test.local';
const app = require('../server');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  let token = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-token': token }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const ok = (m) => console.log('  ok -', m);

  const reg = await call('POST', '/api/register', { name: 'Anika' });
  token = reg.body.token; assert(token); ok('registered');
  let me = (await call('POST', '/api/contacts', { name: 'Maya', phone: '+919999900001', role: 'responder' })).body.user;
  me = (await call('POST', '/api/contacts', { name: 'Ravi', phone: '+919999900002', role: 'trusted' })).body.user;
  assert.equal(me.contacts.length, 2); ok('circle: 1 Responder + 1 trusted contact');
  await call('PUT', '/api/settings', { stage1Sec: 10, stage2Sec: 10 });

  // Change 1: a meeting thread with scheduled check-ins
  const t0 = (await call('POST', '/api/threads', { mode: 'meeting', consentLocation: true, schedule: [{ label: 'First check-in', afterSec: 6 }, { label: 'Finished', afterSec: 60 }] })).body.thread;
  assert.equal(t0.type, 'fixed'); assert.equal(t0.nextLabel, 'First check-in'); ok('Change 1: scheduled check-ins (meeting)');
  const dup = await call('POST', '/api/threads', { mode: 'cab', intervalSec: 60 }); assert.equal(dup.status, 409); ok('only one thread at a time');
  await call('POST', `/api/threads/${t0.id}/loc`, { points: [{ lat: 15.85, lng: 74.49, acc: 12, t: Date.now() }] });

  // Missed check-in => stage 1 only (no one alerted yet)
  await sleep(7500);
  let t = (await call('GET', `/api/threads/${t0.id}`)).body.thread;
  assert.equal(t.stage, 1); ok('Stage 1 Check: missed check-in only asks her first');
  assert.equal((await call('GET', '/api/outbox')).body.messages.length, 0); ok('nobody alerted during Stage 1');
  let circle = (await call('GET', `/api/outbox`)).body; // no messages yet
  const links = t.links;

  // Unanswered => stage 2, Responder only
  await sleep(10500);
  t = (await call('GET', `/api/threads/${t0.id}`)).body.thread;
  assert.equal(t.stage, 2); let ob = (await call('GET', '/api/outbox')).body.messages;
  assert.equal(ob.length, 1); assert.equal(ob[0].role, 'responder'); ok('Change 2 / Stage 2 Connect: only the Responder alerted');
  assert(/try calling her first/.test(ob[0].text) && !/attack|danger/i.test(ob[0].text)); ok('wording: missed check-in is not treated as proof of an attack');

  // Circle link: Responder sees location only now
  const tt = links[me.contacts[0].id].split('/c/')[1];
  let cv = await (await fetch(`${base}/api/circle/${tt}`)).json();
  assert.equal(cv.alerted, true); assert(cv.last && cv.last.lat === 15.85); ok('Responder link shows temporary live location');
  const ackR = await fetch(`${base}/api/circle/${tt}/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'heading' }) });
  assert.equal(ackR.status, 200); ok('Responder can acknowledge "heading to her"');
  const trustedTT = links[me.contacts[1].id].split('/c/')[1];

  // Unresolved => stage 3, trusted contacts
  await sleep(10500);
  t = (await call('GET', `/api/threads/${t0.id}`)).body.thread;
  assert.equal(t.stage, 3); ob = (await call('GET', '/api/outbox')).body.messages;
  assert(ob.some(m => m.role === 'trusted' && /emergency services/.test(m.text))); ok('Stage 3 Escalate: trusted contact alerted with emergency-call option');

  // She confirms safe => everyone told, location hidden again
  const k = await call('POST', `/api/threads/${t0.id}/knot`);
  assert.equal(k.body.thread.stage, 0); ob = (await call('GET', '/api/outbox')).body.messages;
  assert(ob.filter(m => /confirmed she is safe/.test(m.text)).length === 2); ok('"I\'m safe" cancels the alert and tells the whole circle');
  cv = await (await fetch(`${base}/api/circle/${trustedTT}`)).json();
  assert.equal(cv.alerted, false); assert(!cv.last); ok('location link goes dark again after she is safe');

  // Finish the schedule
  const e = await call('POST', `/api/threads/${t0.id}/end`); assert.equal(e.body.thread.status, 'ended'); ok('thread ended');

  // Discreet trigger jumps straight to Connect
  const t1 = (await call('POST', '/api/threads', { mode: 'walk', intervalSec: 120, consentLocation: false })).body.thread;
  const al = await call('POST', `/api/threads/${t1.id}/alert`, { kind: 'silent' });
  assert.equal(al.body.thread.stage, 2); assert.equal(al.body.thread.reason, 'asked'); ok('Change 3: discreet trigger raises Stage 2 quietly');
  cv = await (await fetch(`${base}/api/circle/${al.body.thread.links[me.contacts[0].id].split('/c/')[1]}`)).json();
  assert(!cv.trail && !cv.last); ok('no location shared when she did not consent to a trail');
  await call('POST', `/api/threads/${t1.id}/end`);

  // Optional PIN disguise + duress
  const bad = await call('POST', '/api/pin/set', { pin: '1234', duressPin: '1234' }); assert.equal(bad.status, 400);
  await call('POST', '/api/pin/set', { pin: '2468', duressPin: '1357' });
  assert.equal((await call('POST', '/api/pin/check', { pin: '2468' })).body.result, 'open');
  const t2 = (await call('POST', '/api/threads', { mode: 'cab', intervalSec: 60, consentLocation: true })).body.thread;
  assert.equal((await call('POST', '/api/pin/check', { pin: '1357' })).body.result, 'stay');
  assert.equal((await call('GET', `/api/threads/${t2.id}`)).body.thread.stage, 2); ok('Change 3: optional duress PIN works while the app runs');
  await call('POST', `/api/threads/${t2.id}/end`);

  // Change 4: vault is ciphertext-only, sealed, verifiable, deletable
  const v = await call('POST', '/api/vault', { title: 'Test', salt: 'c2FsdA==', iv: 'aXY=', ciphertext: 'Y2lwaGVydGV4dA==', meta: {} });
  assert(v.body.id && v.body.seq === 1);
  const ver = await call('GET', `/api/vault/${v.body.id}/verify`); assert(ver.body.contentIntact && ver.body.sealIntact); ok('Change 4: vault record sealed and verifiable');
  assert.equal((await call('DELETE', `/api/vault/${v.body.id}`)).status, 200);
  assert.equal((await call('GET', `/api/vault/${v.body.id}`)).status, 404); ok('Change 4: user can delete a record');

  // Complaint draft: facts only, placeholders for the rest
  const d = await call('POST', '/api/draft', { facts: { name: 'Anika', modeLabel: 'Cab ride', date: '24/10/2026', timeline: ['10:00 - Check-in missed'] } });
  assert(/\[ADD YOUR ACCOUNT HERE\]/.test(d.body.draft) && /not legal advice/i.test(d.body.draft)); ok('complaint draft: facts + placeholders + disclaimer');

  // Auth
  token = 'nope'; assert.equal((await call('GET', '/api/me')).status, 401); ok('unauthorised requests rejected');
  console.log('\nAll checks passed.'); srv.close(); process.exit(0);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
