// Smoke harness for @camusugar/dsh-notify client artifact.
// Stubs window.__ModuleLoader__, DOM, Notification, and a fake uiSession.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8');

// --- timer / forbidden-API tripwires -------------------------------------
let timers = 0;
globalThis.setTimeout = () => { timers++; throw new Error('setTimeout used'); };
globalThis.setInterval = () => { timers++; throw new Error('setInterval used'); };
globalThis.requestAnimationFrame = () => { timers++; throw new Error('rAF used'); };

// --- DOM / window stubs ----------------------------------------------------
const listeners = { document: new Map(), window: new Map() };
const emit = (target, type) => {
  const set = target === 'document' ? listeners.document : listeners.window;
  for (const fn of [...(set.get(type) ?? [])]) fn();
};
let visibility = 'hidden';
let focused = false;
globalThis.window = {
  __ModuleLoader__: { load: (m) => { globalThis.__loaded = m; } },
  addEventListener: (t, f) => { (listeners.window.get(t) ?? listeners.window.set(t, []).get(t)).push(f); },
  removeEventListener: (t, f) => { const a = listeners.window.get(t) ?? []; listeners.window.set(t, a.filter((x) => x !== f)); },
};
globalThis.document = {
  get visibilityState() { return visibility; },
  hasFocus: () => focused,
  addEventListener: (t, f) => { (listeners.document.get(t) ?? listeners.document.set(t, []).get(t)).push(f); },
  removeEventListener: (t, f) => { const a = listeners.document.get(t) ?? []; listeners.document.set(t, a.filter((x) => x !== f)); },
};
try {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
} catch {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
}
const IS_ZH = globalThis.navigator.language.startsWith('zh');

// --- Notification stub -----------------------------------------------------
class FakeNotification {
  static permission = 'granted';
  static shown = [];
  constructor(title, opts = {}) {
    this.title = title;
    this.opts = opts;
    this.closed = false;
    this.onclick = null;
    FakeNotification.shown.push(this);
  }
  close() { this.closed = true; }
}
globalThis.Notification = FakeNotification;

// --- load artifact ---------------------------------------------------------
new Function(src)();
assert.ok(globalThis.__loaded, 'loader received the row');
assert.equal(globalThis.__loaded.id, '@camusugar/dsh-notify');
const mod = globalThis.__loaded.factory(() => { throw new Error('factory used require'); });
assert.deepEqual(mod.inject, ['uiSession']);
assert.equal(typeof mod.apply, 'function');

// --- fake ctx / uiSession ---------------------------------------------------
const flush = () => new Promise((r) => Promise.resolve().then(r).then(r).then(r));
let disposeEffect = null;
let effectCount = 0;

function makeCtx({ uiSession }) {
  const state = { subscribers: [], snapshot: new Map() };
  const service = uiSession === 'none' ? undefined
    : uiSession === 'drift' ? {}
    : {
      sessionStatus: {
        snapshot: new Map(),
        subscribe: (fn) => { state.subscribers.push(fn); return () => { const i = state.subscribers.indexOf(fn); if (i >= 0) state.subscribers.splice(i, 1); }; },
        getSnapshot: () => state.snapshot,
      },
    };
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: {
          s1: { displayTitle: '会话一' },
          s2: { displayTitle: '会话二' },
        },
      }),
    },
  };
  const ctx = {
    get: (n) => (n === 'uiSession' ? service : n === 'sessions' ? sessions : undefined),
    effect: (fn, name) => {
      effectCount += 1;
      assert.ok(name, 'effect named');
      disposeEffect = fn();
    },
  };
  return { ctx, state, service, sessions };
}

function setPending(state, sessionId, pi) {
  state.snapshot.set(sessionId, { running: true, pendingInteraction: pi, completionUnread: false });
  for (const fn of state.subscribers) fn();
}
const setAway = (away) => {
  visibility = away ? 'hidden' : 'visible';
  focused = !away;
  emit('document', 'visibilitychange');
  emit('window', away ? 'blur' : 'focus');
};

// --- case 1: approval pending while away -> zh notification ----------------
{
  const { ctx, state } = makeCtx({ uiSession: 'ok' });
  mod.apply(ctx);
  assert.equal(effectCount, 1, 'one effect registered');
  setPending(state, 's1', { key: 'approval:1', kind: 'approval', sessionId: 's1', toolName: 'pwsh', displayReason: '需要提权访问网络' });
  await flush();
  assert.equal(FakeNotification.shown.length, 1, 'one notification shown');
  const n = FakeNotification.shown[0];
  assert.equal(n.title, 'DeepSeek Harness 等待你批准');
  assert.ok(n.opts.body.includes('pwsh'), 'body has toolName: ' + n.opts.body);
  assert.ok(n.opts.body.includes('需要提权访问网络'), 'body has reason');
  assert.equal(n.opts.tag, 'dsh-notify:approval:1');
  assert.ok(n.opts.body.includes('会话一'), 'body has session label: ' + n.opts.body);
  setAway(false);
  assert.ok(n.closed, 'closed when user returns');
  disposeEffect();
  assert.equal(state.subscribers.length, 0, 'unsubscribed on dispose');
  assert.equal(listeners.document.get('visibilitychange')?.length ?? 0, 0, 'listeners removed on dispose');
}

// --- case 2: question pending -> body has question text; resolve closes ----
{
  FakeNotification.shown.length = 0;
  setAway(true);
  const { ctx, state } = makeCtx({ uiSession: 'ok' });
  mod.apply(ctx);
  setPending(state, 's1', { key: 'question:1', kind: 'question', sessionId: 's1', questions: [{ question: '选哪个方案？' }, { question: '第二个问题' }] });
  await flush();
  assert.equal(FakeNotification.shown.length, 1);
  assert.equal(FakeNotification.shown[0].title, 'DeepSeek Harness 等待你回答');
  assert.ok(FakeNotification.shown[0].opts.body.includes('选哪个方案？'));
  setPending(state, 's1', { key: 'question:1', kind: 'question', sessionId: 's1', questions: [{ question: '选哪个方案？' }] });
  await flush();
  assert.equal(FakeNotification.shown.length, 1, 'same key not re-raised');
  setPending(state, 's1', undefined);
  assert.ok(FakeNotification.shown[0].closed, 'closed on resolve');
  disposeEffect();
}

// --- case 3: replacement key swaps the notification ------------------------
{
  FakeNotification.shown.length = 0;
  setAway(true);
  const { ctx, state } = makeCtx({ uiSession: 'ok' });
  mod.apply(ctx);
  setPending(state, 's1', { key: 'plan:1', kind: 'plan', sessionId: 's1' });
  await flush();
  setPending(state, 's1', { key: 'plan:2', kind: 'plan', sessionId: 's1' });
  await flush();
  assert.equal(FakeNotification.shown.length, 2, 'replacement raises a new note');
  assert.ok(FakeNotification.shown[0].closed, 'old note closed');
  assert.ok(!FakeNotification.shown[1].closed, 'new note open');
  disposeEffect();
  assert.ok(FakeNotification.shown[1].closed, 'dispose closes remaining notes');
}

// --- case 4: user present from the start -> no notification ----------------
{
  FakeNotification.shown.length = 0;
  visibility = 'visible';
  focused = true;
  const { ctx, state } = makeCtx({ uiSession: 'ok' });
  mod.apply(ctx);
  setPending(state, 's1', { key: 'approval:9', kind: 'approval', sessionId: 's1', toolName: 'edit' });
  await flush();
  assert.equal(FakeNotification.shown.length, 0, 'no note while user is present');
  setAway(true);
  await flush();
  assert.equal(FakeNotification.shown.length, 1, 'late away raises the note');
  disposeEffect();
}

// --- case 5: missing / drifted uiSession -> silent no-op -------------------
{
  for (const variant of ['none', 'drift']) {
    FakeNotification.shown.length = 0;
    const before = effectCount;
    const { ctx } = makeCtx({ uiSession: variant });
    assert.doesNotThrow(() => mod.apply(ctx), `no throw for ${variant}`);
    assert.equal(effectCount, before, `no effect for ${variant}`);
  }
}

// --- case 6: permission denied -> no notification --------------------------
{
  FakeNotification.shown.length = 0;
  FakeNotification.permission = 'denied';
  const { ctx, state } = makeCtx({ uiSession: 'ok' });
  mod.apply(ctx);
  setPending(state, 's1', { key: 'approval:2', kind: 'approval', sessionId: 's1', toolName: 'pwsh' });
  await flush();
  assert.equal(FakeNotification.shown.length, 0, 'denied permission shows nothing');
  disposeEffect();
  FakeNotification.permission = 'granted';
}

// --- case 7: snapshot shape drift -> self-disarm, no throw to publisher -----
{
  FakeNotification.shown.length = 0;
  setAway(true);
  const { ctx, state, service } = makeCtx({ uiSession: 'ok' });
  mod.apply(ctx);
  setPending(state, 's1', { key: 'approval:3', kind: 'approval', sessionId: 's1', toolName: 'pwsh' });
  await flush();
  assert.equal(FakeNotification.shown.length, 1, 'note raised before drift');
  const garbage = { values: () => { throw new Error('boom'); } };
  service.sessionStatus.getSnapshot = () => garbage;
  assert.doesNotThrow(() => { for (const fn of state.subscribers) fn(); }, 'drift must not throw to the publisher');
  assert.ok(FakeNotification.shown[0].closed, 'drift closes the open note');
  assert.equal(state.subscribers.length, 0, 'drift disarms the subscription');
  assert.doesNotThrow(() => emit('window', 'focus'), 'disarmed sync is inert');
  disposeEffect();
}

// --- case 8: two concurrent sessions -> independent notes, independent close -
{
  FakeNotification.shown.length = 0;
  setAway(true);
  const { ctx, state } = makeCtx({ uiSession: 'ok' });
  mod.apply(ctx);
  setPending(state, 's1', { key: 'approval:10', kind: 'approval', sessionId: 's1', toolName: 'pwsh', displayReason: '提权' });
  setPending(state, 's2', { key: 'question:20', kind: 'question', sessionId: 's2', questions: [{ question: 's2 的问题' }] });
  await flush();
  assert.equal(FakeNotification.shown.length, 2, 'one note per concurrent session');
  const [n1, n2] = FakeNotification.shown;
  assert.ok(n1.opts.body.includes('会话一') && n1.opts.body.includes('pwsh'), 's1 note: ' + n1.opts.body);
  assert.ok(n2.opts.body.includes('会话二') && n2.opts.body.includes('s2 的问题'), 's2 note: ' + n2.opts.body);
  // resolve only s1 -> only n1 closes
  setPending(state, 's1', undefined);
  assert.ok(n1.closed, 's1 note closed on its own resolve');
  assert.ok(!n2.closed, 's2 note stays open');
  assert.equal(FakeNotification.shown.length, 2, 'no extra note raised');
  // s2 gets a replacement -> old closed, new raised
  setPending(state, 's2', { key: 'question:21', kind: 'question', sessionId: 's2', questions: [{ question: 's2 的新问题' }] });
  await flush();
  assert.ok(n2.closed, 'replaced s2 note closed');
  assert.equal(FakeNotification.shown.length, 3, 'replacement raised a new note');
  assert.ok(!FakeNotification.shown[2].closed, 'new s2 note open');
  disposeEffect();
  assert.ok(FakeNotification.shown[2].closed, 'dispose closes the rest');
}

// --- source scan: no timers, no require usage -------------------------------
assert.ok(!/setTimeout|setInterval|requestAnimationFrame|requestIdleCallback/.test(src), 'no timer APIs in source');
assert.ok(!/\brequire\s*\(/.test(src), 'no require calls in source');

console.log('ALL SMOKE TESTS PASSED');
