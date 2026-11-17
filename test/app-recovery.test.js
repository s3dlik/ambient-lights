import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as protocol from '../js/protocol.js';
import * as transport from '../js/transport.js';
import { OtaTransfer } from '../js/ota-transfer.js';
import { DiagnosticLog } from '../js/diagnostics.js';

// Small DOM fixture for exercising the actual app event handlers and card placement.
// This verifies behavior, not browser layout or CSS.
class Element extends EventTarget {
  constructor(tag) {
    super(); Object.assign(this, { tag, nodeType: 1, children: [], dataset: {}, value: '', checked: false, disabled: false });
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  setAttribute(k, v) { this[k] = v; }
  append(...children) { for (const c of children) { c.remove?.(); c.parentNode = this; this.children.push(c); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
  replaceChildren(...children) { for (const c of [...this.children]) c.remove?.(); this._text = ''; this.append(...children); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return (this._text || '') + this.children.map(c => c.textContent).join(''); }
  closest(tag) { return this.tag === tag ? this : this.parentNode?.closest(tag); }
  querySelector(selector) { return this.all().find(e => selector.startsWith('#') ? e.id === selector.slice(1) : e.tag === selector) || null; }
  all() { return this.children.flatMap(c => [c, ...(c.all?.() || [])]); }
}

function appHarness(storage = new Map()) {
  const body = new Element('body');
  for (const id of ['view-connect', 'view-rgb', 'view-flow', 'view-light', 'view-car', 'view-device', 'tabbar', 'toast', 'conn-dot', 'conn-label']) {
    const e = new Element('section'); e.id = id; body.append(e);
  }
  const tabs = body.querySelector('#tabbar');
  for (const tab of ['rgb', 'flow', 'light', 'car', 'device']) { const b = new Element('button'); b.dataset.tab = tab; tabs.append(b); }
  const document = Object.assign(new EventTarget(), {
    body, visibilityState: 'visible', hidden: false,
    createElement: tag => new Element(tag),
    createTextNode: text => { const e = new Element('#text'); e.nodeType = 3; e.textContent = text; return e; },
    querySelector: selector => body.querySelector(selector),
    querySelectorAll: selector => selector === '#tabbar button' ? tabs.children : [],
  });
  const timers = new Map(); let nextTimer = 0;
  const context = vm.createContext({ ...protocol, ...transport, OtaTransfer, DiagnosticLog,
    document, window: Object.assign(new EventTarget(), { scrollTo() {} }),
    navigator: { userAgent: 'test browser', platform: 'test', clipboard: { writeText: async () => {} } },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    location: { search: '' }, URLSearchParams, crypto: webcrypto, console,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), confirm: () => true,
  });
  const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from '[^']+';\s*/gm, '')
    .replace(/\binit\(\);\s*$/, '');
  vm.runInContext(source + '\nglobalThis.api = { state, link, diagnostics, init, buildConnect, buildDevice, renderShell, readFirmwareName, otaBegin, otaRetry, otaOnFrame, otaFail, otaStopAndUnlock, otaLoadFile, otaTransfer, otaSet };', context);
  return { ...context.api, document, body, storage, timers };
}

test('the actual app keeps update recovery and the Bluetooth log accessible while disconnected', () => {
  const app = appHarness();
  app.buildConnect(); app.buildDevice(); app.renderShell();
  const offline = app.body.querySelector('#offline-tools');
  assert.match(offline.textContent, /Bluetooth log/);
  assert.match(offline.textContent, /Save report/);
  assert.match(offline.textContent, /Retry from the start/);
  app.state.connected = true; app.renderShell();
  assert.equal(offline.children.length, 0);
  assert.match(app.body.querySelector('#view-device').textContent, /Bluetooth log/);
  app.state.connected = false; app.renderShell();
  assert.match(offline.textContent, /Bluetooth log/);
  assert.equal(app.body.querySelector('#view-device').hidden, true);
});

test('the actual standalone filename action reports a local lock and sends no bytes', () => {
  const app = appHarness();
  const writes = [];
  app.link.transport = { connected: true, write: async bytes => writes.push(bytes) };
  app.link.otaLock = true;
  app.readFirmwareName();
  assert.equal(writes.length, 0);
  assert.match(app.diagnostics.text(), /blocked locally/);
  assert.doesNotMatch(app.diagnostics.text(), /query queued/);
});

test('a delayed bootloader-ready frame cannot restart a stalled or stopped upload', () => {
  const app = appHarness();
  let writes = 0;
  app.link.transport = { connected: true, write: async () => writes++ };
  app.state.ota.phase = 'stalled';
  app.otaOnFrame({ type: 'otaStart' });
  assert.equal(writes, 0);
  app.otaStopAndUnlock();
  app.otaOnFrame({ type: 'otaStart' });
  assert.equal(writes, 0);
  assert.equal(app.state.ota.phase, 'idle');
});

test('a fresh old-version reply does not falsely confirm installation of a new build', () => {
  const app = appHarness();
  app.state.ota = { ...app.state.ota, phase: 'verifying', verificationQuerySent: true, expectedSoftware: '261115-071' };
  app.link.otaLock = true;
  app.otaOnFrame({ type: 'version', software: '261115-070' });
  assert.equal(app.state.ota.phase, 'failed');
  assert.match(app.state.ota.message, /not confirmed/);
  assert.match(app.diagnostics.text(), /VERSION MISMATCH/);
  assert.equal(app.link.otaLock, false); // normal application answered; controls may be used
});

test('matching fresh version completes verification and records the exact build', () => {
  const app = appHarness();
  app.state.ota = { ...app.state.ota, phase: 'verifying', verificationQuerySent: true, expectedSoftware: '261115-071', oldSoftware: '261115-070' };
  app.otaOnFrame({ type: 'version', software: '261115-071' });
  assert.equal(app.state.ota.phase, 'done');
  assert.match(app.diagnostics.text(), /261115-070 -> 261115-071/);
});

test('unsolicited version frames before the verification query do not finish the update', () => {
  const app = appHarness();
  app.state.ota = { ...app.state.ota, phase: 'verifying', verificationQuerySent: false, expectedSoftware: '261115-071' };
  app.otaOnFrame({ type: 'version', software: '261115-071' });
  assert.equal(app.state.ota.phase, 'verifying');
});

test('refresh restores recovery lock and diagnostics without resuming any writes', () => {
  const app = appHarness();
  app.link.otaLock = true;
  app.state.ota = { ...app.state.ota, total: 1164, progress: { currentBlock: 1007, writtenBlocks: 1006, acknowledgedBlocks: 1006, totalBlocks: 1164 } };
  app.otaFail('Bluetooth disconnected', 'stalled');
  const reloaded = appHarness(app.storage);
  reloaded.init();
  assert.equal(reloaded.state.ota.phase, 'stalled');
  assert.equal(reloaded.link.otaLock, true);
  assert.equal(reloaded.state.ota.progress.currentBlock, 1007);
  assert.equal(reloaded.link.queue.length, 0);
  assert.equal(reloaded.state.ota.file, null);
  assert.match(reloaded.body.querySelector('#offline-tools').textContent, /previous update was interrupted/);
});

test('recovery reselects a file without discarding the lock or resetting the transfer automatically', async () => {
  const app = appHarness();
  app.link.otaLock = true;
  app.state.ota.phase = 'stalled';
  await app.otaLoadFile({ name: 'bad.bin', arrayBuffer: async () => new ArrayBuffer(100) });
  assert.equal(app.link.otaLock, true);
  assert.equal(app.state.ota.check.ok, false);
  assert.equal(app.link.queue.length, 0);
});

test('the actual app runs filename, length, block transfer and a matching post-transfer version query', async () => {
  const app = appHarness();
  const file = Uint8Array.from({ length: 436 }, (_, i) => i % 251);
  const sent = [];
  const received = [];
  let byteCount = 0;
  app.state.ota = { ...app.state.ota, file, fileName: 'test.bin', sha: 'test-sha', expectedSoftware: '261115-071',
    check: { ok: true, info: { embeddedName: 'File999.bin' } }, total: 3 };
  app.link.gapMs = 0;
  app.link.transport = { connected: true, write: async bytes => {
    const text = new TextDecoder().decode(bytes);
    if (text === '<0DBB44>') {
      sent.push(text); queueMicrotask(() => app.otaOnFrame({ type: 'firmwareName', name: 'File999.bin' }));
    } else if (text === '<0E000436>') {
      sent.push(text); queueMicrotask(() => app.otaOnFrame({ type: 'otaStart' }));
    } else if (text === '<0A01>') {
      sent.push(text); queueMicrotask(() => app.otaOnFrame({ type: 'version', software: '261115-071' }));
    } else {
      received.push(bytes.slice()); byteCount += bytes.length;
      if (byteCount % 200 === 0 && byteCount < file.length) queueMicrotask(() => app.otaOnFrame({ type: 'otaNext' }));
    }
  } };
  app.otaBegin();
  for (let i = 0; i < 100 && app.state.ota.phase !== 'verifying'; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(app.state.ota.phase, 'verifying');
  assert.deepEqual(Buffer.concat(received), Buffer.from(file));
  const poll = [...app.timers.values()].find(t => t.ms === 8000);
  assert.ok(poll);
  poll.fn();
  for (let i = 0; i < 100 && app.state.ota.phase !== 'done'; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(app.state.ota.phase, 'done');
  assert.equal(app.link.otaLock, false);
  assert.deepEqual(sent, ['<0DBB44>', '<0E000436>', '<0A01>']);
  assert.equal(app.diagnostics.lastUpdate.phase, 'done');
  app.otaTransfer.cancel();
});
