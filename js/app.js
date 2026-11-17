import {
  Cmd, PALETTE, PALETTE_EMPTY, RGB_MODES, flowModesFor, COMMON_EFFECTS, WELCOME_MODES, WARN_COLORS,
  parseFrame, BLOCKED_PREFIXES, OTA_PREFIXES, FIRMWARE_NAME_QUERY,
  inspectFirmware, otaBlocks, otaLengthPayload, KNOWN_FIRMWARE,
} from './protocol.js';
import { Link, WebBluetoothTransport, DemoTransport, describeError } from './transport.js';
import { OtaTransfer } from './ota-transfer.js';
import { DiagnosticLog } from './diagnostics.js';
import { DOOR_EFFECTS, DOOR_REASONS, DOOR_REFUSALS, isDoorFirmware, doorCommand, doorConfiguration, parseDoorReply } from './door-effects.js';

// ---------------------------------------------------------------------------
// tiny DOM + state helpers
// ---------------------------------------------------------------------------

const $ = (s, r = document) => r.querySelector(s);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (typeof v !== 'string' && k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('al.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('al.' + k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};

// Door strip order measured on the car (2026-11-17). Channel Cn lights for door signal DOOR_MAPPING[n]:
// C0 rear-left strip <- rear-left door, C1 front-left <- driver, C2 front-right <- front-right, C3 rear-right <- rear-right.
// The first guess [0, 2, 3, 1] swapped front and rear on both sides.
const DOOR_MAPPING = [2, 0, 1, 3];
function loadDoorPrefs() {
  const prefs = store.get('doorEffects072', { effect: 0, color: '#00ff80', brightness: 60, period: 15, mapping: [...DOOR_MAPPING], reverse: 0, enabled: 15 });
  // one-time fix for phones that saved the old guess; a later manual choice is kept
  if (!store.get('doorMappingFixed', false)) {
    if (String(prefs.mapping) === '0,2,3,1') { prefs.mapping = [...DOOR_MAPPING]; store.set('doorEffects072', prefs); }
    store.set('doorMappingFixed', true);
  }
  return prefs;
}

const emptySlots = () => Array(8).fill(PALETTE_EMPTY);
const diagnostics = new DiagnosticLog({
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
});

const state = {
  connected: false, connecting: false, demo: false, tab: 'rgb', gen: 2,
  // light
  power: null, brightnessAll: null, brightnessZone1: null, brightnessZone2: null, frontBack: null,
  nightDim: null, nightLevel: null, forcePhone: null,
  // rgb lights
  zone: 'all', color: '#ff00ff', color1: null, color2: null, rgbMode: null,
  rgbCustom: false, rgbSlots: emptySlots(), rgbSlot: 0, rgbSpeed: null,
  // light bars
  flowMode: null, flowSpeed: null, flowReverse: null, effectToggle: null, commonEffect: null,
  flowCustom: false, flowSlots: emptySlots(), flowSlot: 0, flowLength: null, flowInterval: null,
  // car
  mic: null, soundSource: null, welcome: null, welcomeMode: null, welcomeColor: null, welcomeSyncSupported: false,
  door: null, radar: null, speed: null, steering: null, airCon: null, blindSpot: null,
  doorColor: null, turnColor: null, blindColor: null, mirror: null,
  // device
  version: {}, statusSeen: false,
  fwName: { status: 'idle', name: null, raw: null, at: null }, // idle | waiting | done | timeout | unsupported
  doorFx: { replies: {}, preferences: loadDoorPrefs() },
  // firmware update. phase: idle | loaded | asking | entering | sending | verifying | done | failed | stalled
  ota: { phase: 'idle', fileName: '', file: null, check: null, sha: '', known: null, block: 0, total: 0, message: '', pieceMode: '20', oldSoftware: '', progress: {} },
  factory: { active: false, edit: false, dial: null, draftDial: null, lamps: null, draftLamps: null, result: null },
  log: diagnostics.entries,
  scenesEdit: false,
};

const binders = new Set();
function bind(fn) { binders.add(fn); fn(); return fn; }
function refresh() { for (const fn of binders) { try { fn(); } catch (e) { console.error(e); } } }
function set(patch) { Object.assign(state, patch); refresh(); }

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------------------------------------------------------------------
// Bluetooth link
// ---------------------------------------------------------------------------

const link = new Link();
let lastTransport = null;

function send(payload, key) {
  if (!link.connected) { toast('Not connected'); return false; }
  // firmware-update opcodes never go through the normal path (the name query has its own guarded action)
  if (OTA_PREFIXES.some((p) => String(payload).toUpperCase().startsWith(p))) {
    addLog('err', `Refused to send <${payload}> (firmware-update command)`);
    return false;
  }
  if (link.otaLock) { toast('Update recovery is locked. Use the firmware update card.'); return false; }
  return link.send(payload, { key });
}

// ---------------------------------------------------------------------------
// custom door colour / open-door effect (custom firmware 261115-072/074/075)
// Settings live in controller RAM only, so the phone keeps them and re-sends
// them every time it connects to a box running the door firmware.
// ---------------------------------------------------------------------------

const DOOR_DEFAULTS = { on: false, effect: 0, color: '#00ff80', brightness: 60, period: 15, mapping: DOOR_MAPPING, reverse: 0, enabled: 15 };
const doorReady = () => state.connected && state.doorFx.verifiedConnection && isDoorFirmware(state.version.software) && !link.otaLock;
function doorPrefs() {
  const prefs = { ...DOOR_DEFAULTS, ...state.doorFx.preferences };
  try { doorConfiguration(prefs); return prefs; } catch { return { ...DOOR_DEFAULTS, on: prefs.on === true }; }
}
/** Send the saved door settings: the full configuration when on, Disable when off. */
function sendDoorPrefs({ quiet = false } = {}) {
  if (!doorReady()) { if (!quiet) toast('Needs the custom door firmware 261115-075'); return false; }
  const prefs = doorPrefs();
  for (const command of prefs.on ? doorConfiguration(prefs) : [doorCommand(0)]) if (!send(command)) return false;
  return true;
}
let doorTimer = null;
/** Save door settings on the phone; send them when the effect is on (or was just switched). */
function setDoorPrefs(patch, { debounce = false } = {}) {
  const prefs = { ...doorPrefs(), ...patch };
  doorConfiguration(prefs); // throws on invalid values
  store.set('doorEffects072', prefs);
  set({ doorFx: { ...state.doorFx, preferences: prefs } });
  if (!prefs.on && !('on' in patch)) return;
  clearTimeout(doorTimer);
  if (debounce) doorTimer = setTimeout(() => sendDoorPrefs(), 400);
  else sendDoorPrefs();
}

// ---------------------------------------------------------------------------
// firmware update (OTA): same procedure as the vendor app, see protocol.js
// ---------------------------------------------------------------------------

/** iPhone/iPad (incl. Bluefy and iPadOS "desktop" mode). The vendor advises another phone when updates fail there. */
function isAppleMobile() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod|Bluefy/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

let otaTimer = null;
let otaBlocksList = [];
let otaPiece = 0; // 0 = whole 200-byte block per write (as the vendor app); else split size
let otaWakeLock = null;
let otaLoadGeneration = 0;
const OTA_ACTIVE = ['asking', 'retrying', 'entering', 'sending', 'verifying', 'waiting'];
const otaTransfer = new OtaTransfer(link, {
  onProgress: progress => {
    otaSet({ progress, block: progress.transferPhase === 'complete' ? progress.totalBlocks : Math.max(0, progress.currentBlock - 1) });
    if (progress.transferPhase === 'complete' || (progress.transferPhase === 'waiting-ack' && progress.writtenBlocks % 50 === 0)) diagnostics.update(otaSnapshot());
  },
  onStall: message => otaFail(message, 'stalled'),
  onComplete: () => { otaClearTimer(); otaVerify(); },
});

function otaSet(patch) { set({ ota: { ...state.ota, ...patch } }); }
function otaSnapshot() {
  const o = state.ota;
  return { phase: o.phase, message: o.message, fileName: o.fileName, bytes: o.file?.length || o.selectedBytes || 0, totalBlocks: o.total, sha256: o.sha,
    expectedSoftware: o.expectedSoftware || '', oldSoftware: o.oldSoftware, pieceMode: o.pieceMode,
    entry: o.entry || {},
    progress: o.progress, locked: link.otaLock, connected: link.connected, device: link.name,
    visibility: document.visibilityState, writeMode: lastTransport?.writeMode || 'unknown' };
}
function otaLog(text) { addLog('dim', `OTA: ${text}`); diagnostics.update(otaSnapshot()); }
function otaClearTimer() { clearTimeout(otaTimer); otaTimer = null; }
function otaArm(ms, onTimeout) { otaClearTimer(); otaTimer = setTimeout(onTimeout, ms); }

async function otaLoadFile(fileObj) {
  if (OTA_ACTIVE.includes(state.ota.phase)) return;
  const generation = ++otaLoadGeneration;
  const buf = new Uint8Array(await fileObj.arrayBuffer());
  const check = inspectFirmware(buf);
  let sha = '';
  try {
    const d = await crypto.subtle.digest('SHA-256', buf);
    sha = Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
  } catch { sha = '(SHA-256 unavailable in this browser)'; }
  if (generation !== otaLoadGeneration || OTA_ACTIVE.includes(state.ota.phase)) return;
  if (state.demo && lastTransport && check.info.embeddedName) lastTransport.otaName = check.info.embeddedName;
  const build = check.info.build?.match(/(\d{4})-(\d{2})-(\d{2})-(\d{3})/);
  const expectedSoftware = build ? `${build[1].slice(-2)}${build[2]}${build[3]}-${build[4]}` : '';
  otaSet({ phase: 'loaded', fileName: fileObj.name, file: buf, check, sha, known: KNOWN_FIRMWARE[sha] || null, block: 0, total: Math.ceil(buf.length / 200), message: '', progress: {}, expectedSoftware });
  otaLog(`loaded ${fileObj.name}, ${buf.length} bytes, sha256 ${sha}, ${check.ok ? 'structure OK' : 'INVALID'}`);
}

function otaFail(message, phase = 'failed') {
  otaClearTimer();
  if (state.ota.phase === 'sending') otaSet({ progress: { ...otaTransfer.progress, elapsedMs: Date.now() - otaTransfer.started } });
  otaTransfer.cancel();
  otaReleaseWake();
  if (phase === 'failed') link.otaLock = false;
  otaSet({ phase, message });
  const p = state.ota.progress;
  otaLog(`${phase.toUpperCase()}: ${message} Last block attempted ${p.currentBlock || 0}/${state.ota.total}; completed writes ${p.writtenBlocks || 0}, controller ACKs ${p.acknowledgedBlocks || 0}, completed-block bytes ${p.bytesWritten || 0}, current-block bytes ${p.currentBlockWritten || 0}.`);
  toast(message, 6000);
}

async function otaAcquireWake() {
  if (otaWakeLock && !otaWakeLock.released) return;
  const run = otaTransfer.run;
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (run !== otaTransfer.run || !OTA_ACTIVE.includes(state.ota.phase)) { lock?.release(); return; }
    otaWakeLock = lock;
  } catch { otaWakeLock = null; }
}
function otaReleaseWake() { try { otaWakeLock?.release(); } catch { /* ignore */ } otaWakeLock = null; }

/** Step 1: ask the box for its file name and compare it with the file's own embedded name. */
function otaBegin() {
  const o = state.ota;
  if (!link.connected) { toast('Not connected'); return; }
  if (OTA_ACTIVE.includes(o.phase)) return;
  if (!o.check?.ok) { toast('This file failed the checks'); return; }
  if (link.otaLock) { otaRetry(); return; }
  otaTransfer.cancel();
  otaBlocksList = otaBlocks(o.file);
  otaPiece = o.pieceMode === 'auto' ? 0 : Number(o.pieceMode);
  link.otaLock = true;
  otaSet({ phase: 'asking', retry: false, message: 'Asking the box for its firmware file name…', block: 0, total: otaBlocksList.length, oldSoftware: state.version.software || '', progress: {}, entry: {} });
  otaLog(`start: ${otaBlocksList.length} blocks, piece size ${otaPiece || 'whole block'}; file ${o.fileName}, bytes ${o.file.length}, sha256 ${o.sha}; ${navigator.userAgent}; visibility ${document.visibilityState}; write ${lastTransport?.writeMode || 'unknown'}`);
  link.send(FIRMWARE_NAME_QUERY, { ota: true });
  otaArm(5000, () => otaFail('The box did not answer the file-name query. No update request was sent.'));
}

/** Step 2: request update entry. Only <14> confirms the bootloader is ready. */
function otaEnterBootloader() {
  link.otaLock = true;
  const payload = otaLengthPayload(state.ota.file.length);
  otaSet({ phase: 'entering', entry: { ...state.ota.entry, payload, requestedAt: new Date().toISOString() },
    message: 'Update mode requested. Waiting for the controller’s <14> ready reply; no firmware blocks sent yet.' });
  otaAcquireWake();
  otaLog(`requesting update mode with <${payload}>; waiting for <14> before block 1`);
  link.send(payload, { ota: true });
  otaArm(20000, otaEntryTimeout);
}

function otaEntryTimeout() {
  const entry = state.ota.entry || {};
  const result = entry.writtenAt ? 'The Bluetooth write completed locally; controller acceptance is unconfirmed.'
    : 'Local completion of the update-request write was not recorded.';
  otaFail(`Update mode was not confirmed: no <14> within 20 s. No firmware blocks were attempted. ${result} Save the report. Changing block piece size does not affect this stage.`, 'stalled');
}

/** After the last block: give the bootloader time to finish, then ask the new firmware for its version. */
function otaVerify() {
  otaSet({ phase: 'verifying', verificationQuerySent: false, block: otaBlocksList.length, message: 'All blocks sent. Waiting for the box to restart…' });
  otaLog('all block writes completed; waiting for a fresh version reply');
  let tries = 0;
  const poll = () => {
    if (state.ota.phase !== 'verifying') return;
    if (tries++ >= 8) {
      otaFail('All block writes completed, but no fresh version reply was received. Installation is not confirmed. Reconnect and copy the Bluetooth log.', 'stalled');
      return;
    }
    link.send('0A01', { ota: true });
    otaArm(5000, poll);
  };
  otaArm(8000, poll);
}

/** Returns true when the frame belonged to the update flow. */
function otaOnFrame(f) {
  const o = state.ota;
  if (!OTA_ACTIVE.includes(o.phase) && o.phase !== 'stalled') return false;
  if (o.phase === 'asking' && f.type === 'firmwareName') {
    otaClearTimer();
    if (f.raw === '1502') { otaFail('The box says firmware update is not supported. Nothing was changed.'); return true; }
    const want = o.check.info.embeddedName;
    if (!want || f.name !== want) {
      otaFail(`Wrong file: the box uses “${f.name}”, this file is “${want || 'unknown'}”. Nothing was changed.`);
      return true;
    }
    otaLog(`box file name ${f.name} matches the file`);
    otaEnterBootloader();
    return true;
  }
  if (o.phase === 'retrying' && f.type === 'firmwareName') {
    otaClearTimer();
    if (f.raw === '1502') { otaRetryRefused(); return true; }
    otaLog(`retry: box answered with ${f.name} (normal firmware is running)`);
    if (f.name !== o.check.info.embeddedName) { otaFail(`Wrong file: the box uses “${f.name}”, this file is “${o.check.info.embeddedName}”.`); return true; }
    otaEnterBootloader();
    return true;
  }
  if (o.phase === 'entering' && f.type === 'firmwareName' && f.raw === '1502') {
    if (o.retry) { otaRetryRefused(); return true; }
    otaFail('The controller refused the update (<1502>). The refusal does not establish its cause or confirm the installed version.');
    return true;
  }
  if (['entering', 'waiting', 'retrying'].includes(o.phase) && f.type === 'otaStart') {
    otaClearTimer(); otaLog('<14> bootloader ready');
    otaSet({ phase: 'sending', entry: { ...o.entry, readyAt: new Date().toISOString() }, message: 'Sending firmware blocks…' });
    otaTransfer.start(otaBlocksList, otaPiece);
    otaAcquireWake();
    return true;
  }
  if (o.phase === 'sending' && f.type === 'otaNext') {
    otaTransfer.ack();
    return true;
  }
  if (o.phase === 'verifying' && o.verificationQuerySent && f.type === 'version') {
    otaClearTimer();
    link.otaLock = false;
    otaReleaseWake();
    if (o.expectedSoftware && f.software !== o.expectedSoftware) {
      otaSet({ phase: 'failed', message: `The controller reports ${f.software || '?'}, but the selected file is expected to report ${o.expectedSoftware}. Installation of the selected build is not confirmed.` });
      otaLog(`VERSION MISMATCH: expected ${o.expectedSoftware}, received ${f.software}`);
      return false;
    }
    otaSet({ phase: 'done', message: o.expectedSoftware
      ? `Update finished. The box now reports software ${f.software || '?'} (before: ${o.oldSoftware || '?'}).`
      : `The controller reports software ${f.software || '?'}. A build marker was not detected in the selected file, so its installation identity is unverified.` });
    otaLog(`done, software ${o.oldSoftware} -> ${f.software}${o.expectedSoftware ? '' : '; selected build identity unverified'}`);
    return false; // let the normal handler store the version too
  }
  return false;
}

/**
 * Recovery as the vendor describes it: power-cycle the box (≈1 min), reconnect, retry from the start.
 * 1. ask for the file name: if the normal firmware answers, run the normal flow (<0E…> → <14> → blocks)
 * 2. no answer within 4 s: the box is probably waiting in update mode → send <0E…> directly and wait for <14>
 */
function otaRetry() {
  const o = state.ota;
  if (OTA_ACTIVE.includes(o.phase)) return;
  if (!o.file || !o.check?.ok) { toast('Pick the firmware file again first'); return; }
  if (!link.connected) { toast('Reconnect to the box first'); return; }
  otaTransfer.cancel();
  otaBlocksList = otaBlocks(o.file);
  otaPiece = o.pieceMode === 'auto' ? 0 : Number(o.pieceMode);
  if (state.demo && lastTransport && o.check.info.embeddedName) lastTransport.otaName = o.check.info.embeddedName;
  link.otaLock = true;
  otaSet({ phase: 'retrying', retry: true, block: 0, progress: {}, entry: {}, message: 'Retrying from the start: asking the box for its file name…' });
  otaAcquireWake();
  otaLog('retry from the start');
  link.send(FIRMWARE_NAME_QUERY, { ota: true });
  otaArm(4000, () => {
    otaLog('no filename reply; controller state is unknown. Explicit retry requests update mode again');
    otaEnterBootloader();
  });
}

/** A refusal does not identify its cause or establish what firmware is running. */
function otaRetryRefused() {
  otaClearTimer();
  link.otaLock = false;
  otaReleaseWake();
  otaSet({ phase: 'failed', message: 'The controller refused the update (<1502>). Some older firmware rejects a repeated file length; that restriction is absent from the traced File122 application. Copy the log and check the reported version before choosing a next step.' });
  otaLog('retry refused with <1502>; cause and installed build not established');
}

/** Manual recovery after a stall: wait for the bootloader's <14> again (sent e.g. after a power cycle). */
function otaWaitForBootloader() {
  if (!state.ota.check?.ok || !link.connected) { toast('Load a valid file and reconnect first'); return; }
  otaBlocksList = otaBlocks(state.ota.file);
  otaPiece = state.ota.pieceMode === 'auto' ? 0 : Number(state.ota.pieceMode);
  link.otaLock = true;
  otaSet({ phase: 'waiting', message: 'Waiting for <14> from the bootloader. No firmware data is sent until it arrives.' });
  otaLog('waiting for <14> (manual recovery)');
}

function otaStopAndUnlock() {
  otaClearTimer();
  if (state.ota.phase === 'sending') otaSet({ progress: { ...otaTransfer.progress } });
  otaTransfer.cancel();
  link.otaLock = false;
  otaReleaseWake();
  otaSet({ phase: state.ota.file ? 'loaded' : 'idle', message: '' });
  otaLog('stopped by user, normal commands unlocked');
}

link.addEventListener('tx-raw', (e) => {
  const d = e.detail;
  if ((d.block - 1) % 50 === 0 || d.block === d.total || !d.ok) {
    addLog('tx', `[firmware block ${d.block}/${d.total}: ${d.written}/${d.length} bytes written${d.ok ? '' : ', FAILED'}]${d.error ? ' ' + d.error : ''}`);
  }
});
link.addEventListener('state', (e) => {
  if (!e.detail.connected && OTA_ACTIVE.includes(state.ota.phase)) {
    otaFail('Bluetooth disconnected during the update. Power-cycle the box if needed, reconnect, open this card and tap “Retry from the start”.', 'stalled');
  }
});
window.addEventListener('beforeunload', (e) => { if (OTA_ACTIVE.includes(state.ota.phase)) { e.preventDefault(); e.returnValue = ''; } });

let fwTimer;
/** One-shot, confirmed query for the firmware file name (sends 0DBB44 only; 0E stays blocked). */
function readFirmwareName() {
  if (!link.connected) { toast('Not connected'); return; }
  if (link.otaLock || OTA_ACTIVE.includes(state.ota.phase)) {
    addLog('dim', 'Firmware name query blocked locally by the update lock; nothing sent. Use the update recovery card.');
    toast('Update recovery is locked. Use the firmware update card.');
    return;
  }
  if (state.fwName.status === 'waiting') return;
  if (!confirm('Ask the controller for its firmware file name?\n\n'
    + 'This sends one command, <0DBB44>: the first step of the vendor’s update, which only makes the box reply with a file name. '
    + 'This app never sends the next step (0E), so nothing is downloaded to the box or written to it.\n\n'
    + 'Do this with the car parked. Afterwards, switch the ignition off and let the box go to sleep before driving.')) return;
  set({ fwName: { status: 'waiting', name: null, raw: null, at: null } });
  if (!link.send(FIRMWARE_NAME_QUERY)) {
    set({ fwName: { ...state.fwName, status: 'idle' } });
    addLog('err', 'Firmware name query was not queued; nothing sent.');
    return;
  }
  addLog('dim', 'Firmware name query queued once; the tx entry records the write attempt.');
  clearTimeout(fwTimer);
  fwTimer = setTimeout(() => { if (state.fwName.status === 'waiting') set({ fwName: { ...state.fwName, status: 'timeout' } }); }, 3000);
}

function addLog(kind, text, note = '') {
  diagnostics.add(kind, text, note);
  renderLog();
}

link.addEventListener('tx', (e) => {
  if (state.ota.phase === 'verifying' && e.detail.payload === '0A01') otaSet({ verificationQuerySent: true });
  addLog('tx', `<${e.detail.payload}>`);
});
link.addEventListener('command-result', (e) => {
  const { payload, ok, error } = e.detail;
  const o = state.ota;
  if (payload !== o.entry?.payload || !['entering', 'sending'].includes(o.phase)) return;
  // <14> may arrive before the GATT promise resolves. Preserve that observation
  // and never replace the block-transfer timer with an entry timer here.
  otaSet({ entry: { ...o.entry, writeCompleted: ok, ...(ok ? { writtenAt: new Date().toISOString() } : { writeError: error }) } });
  otaLog(`update-request Bluetooth write ${ok ? 'completed locally (not a controller acknowledgement)' : `failed: ${error}`}`);
  if (!ok && o.phase === 'entering') otaFail(`Update-request Bluetooth write failed: ${error}. No firmware blocks were attempted. Controller state is unknown; save the report.`, 'stalled');
});
link.addEventListener('error', (e) => { addLog('err', e.detail.message); toast(e.detail.message); });
link.addEventListener('frame', (e) => {
  const f = parseFrame(e.detail.payload);
  const doorReply = parseDoorReply(e.detail.payload);
  if (f.type === 'version') {
    const verified = isDoorFirmware(f.software);
    set({ doorFx: { ...state.doorFx, verifiedConnection: verified } });
    // the box forgets door settings on every restart: re-send the saved ones
    if (verified && doorPrefs().on) setTimeout(() => sendDoorPrefs({ quiet: true }), 500);
  }
  if (doorReply) {
    const replies = { ...state.doorFx.replies, [doorReply.kind]: doorReply.values };
    if (doorReply.kind === 'S') delete replies.X; // an accepted command supersedes an earlier refusal
    set({ doorFx: { ...state.doorFx, replies } });
  }
  // during a firmware update log only every 50th <16>, so the start of the log (the interesting part) survives
  const quietAck = f.type === 'otaNext' && state.ota.phase === 'sending' && (state.ota.block + 1) % 50 !== 0;
  if (!quietAck) addLog('rx', `<${e.detail.payload}>`, f.type);
  applyFrame(f);
});
link.addEventListener('state', (e) => {
  if (e.detail.connected) {
    state.doorFx = { ...state.doorFx, verifiedConnection: false, replies: {} };
    set({ connected: true, connecting: false });
    setTimeout(() => send(Cmd.hello()), 1000); // vendor app waits 1 s, then asks for state
  } else {
    const wasFactory = state.factory.active;
    state.doorFx = { ...state.doorFx, verifiedConnection: false, replies: {} };
    set({ connected: false, connecting: false, factory: { ...state.factory, active: false } });
    if (wasFactory) toast('Disconnected (installer mode ended)');
  }
  renderShell();
});

async function connect({ demo = false, reuse = false } = {}) {
  if (state.connecting) return;
  const steps = [];
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const onStep = (s) => { steps.push(`${stamp()} ${s}`); set({ connectDiag: { ok: null, steps: [...steps] } }); };
  set({ connecting: true, connectDiag: null });
  renderShell();
  try {
    let transport;
    if (reuse && lastTransport) { transport = lastTransport; transport.onStep = onStep; }
    else if (demo) transport = new DemoTransport();
    else {
      const prefix = $('#prefix')?.value ?? store.get('prefix', 'ATW');
      const showAll = $('#show-all')?.checked ?? false;
      store.set('prefix', prefix);
      store.set('showAll', showAll);
      onStep(`start · prefix "${prefix}" · show all ${showAll ? 'on' : 'off'} · ${navigator.userAgent}`);
      transport = new WebBluetoothTransport({ namePrefix: prefix, showAll, onStep });
    }
    state.demo = transport instanceof DemoTransport;
    await link.connect(transport);
    lastTransport = transport;
    addLog('dim', `Connected to ${transport.name}`);
    if (steps.length) set({ connectDiag: null });
  } catch (e) {
    const msg = describeError(e);
    if (e?.extra) steps.push(`${stamp()} ${e.extra}`);
    steps.push(`${stamp()} FAILED at ${e?.step || 'unknown step'}: ${e?.causeText || msg}`);
    set({ connecting: false, connectDiag: { ok: false, steps } });
    renderShell();
    if (e?.name === 'NotFoundError') toast('No device chosen');
    else toast(`Connection failed at ${e?.step || 'connect'}: ${e?.causeText || msg}`, 6000);
    addLog('err', `Connect failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// incoming frames -> state
// ---------------------------------------------------------------------------

function applyFrame(f) {
  if (otaOnFrame(f)) return; // frames consumed by a running firmware update
  switch (f.type) {
    case 'status': {
      const p = {
        statusSeen: true, gen: f.gen, rgbMode: f.rgbMode, flowMode: f.flowMode, power: f.power,
        color1: f.color1, color2: f.color2, brightnessZone1: f.brightnessZone1, brightnessZone2: f.brightnessZone2,
        mic: f.mic, flowSpeed: f.flowSpeed, flowReverse: f.flowReverse,
        brightnessAll: f.brightnessAll ?? f.brightnessZone1,
      };
      if (f.rgbCustomSpeed !== undefined) p.rgbSpeed = f.rgbCustomSpeed;
      if (f.forcePhone !== undefined) p.forcePhone = f.forcePhone;
      if (!wheelDragging) p.color = (state.zone === 'zone2' ? f.color2 : f.color1) || state.color;
      set(p);
      break;
    }
    case 'settings':
      set({
        welcome: f.welcome, door: f.door, radar: f.radar, speed: f.speed, steering: f.steering, airCon: f.airCon,
        nightDim: f.nightDim, frontBack: f.frontBack, welcomeMode: f.welcomeMode,
        welcomeColor: f.welcomeColor, welcomeSyncSupported: f.welcomeSyncSupported, blindSpot: f.blindSpot,
        // the vendor app reads byte 11 both as night level and as sound source
        nightLevel: f.byte11 >= 1 && f.byte11 <= 5 ? f.byte11 : state.nightLevel,
        soundSource: f.byte11 === 1 ? 'horn' : f.byte11 === 0 ? 'mic' : state.soundSource,
      });
      break;
    case 'colors':
      set({
        rgbSlots: f.rgbSlots || state.rgbSlots, rgbCustom: f.rgbCustom,
        flowSlots: f.flowSlots || state.flowSlots, flowCustom: f.flowCustom,
        flowLength: f.flowLength, flowInterval: f.flowInterval, commonEffect: f.commonEffect,
        effectToggle: f.effectToggle == null ? null : f.effectToggle + 1,
        ...(f.rgbCustomSpeed ? { rgbSpeed: f.rgbCustomSpeed } : {}),
      });
      break;
    case 'version': set({ version: { hardware: f.hardware, carModel: f.carModel, software: f.software } }); break;
    case 'mirror': set({ mirror: { mode: f.mode, unlock: f.unlock, door: f.door, turn: f.turn, reverse: f.reverse } }); break;
    case 'dial': set({ factory: { ...state.factory, dial: f, draftDial: { model: [...f.model], function: [...f.function] } } }); break;
    case 'lampLayout': set({ factory: { ...state.factory, lamps: f, draftLamps: { ...f } } }); break;
    case 'factoryResult': set({ factory: { ...state.factory, result: f } }); break;
    case 'firmwareName':
      clearTimeout(fwTimer);
      set({ fwName: { status: 'done', name: f.name, raw: f.raw, at: new Date() } });
      break;
    case 'notSupported':
      if (state.fwName.status === 'waiting') { clearTimeout(fwTimer); set({ fwName: { ...state.fwName, status: 'unsupported' } }); }
      toast('The controller says: not supported on this box');
      break;
    case 'alert': toast(`Controller: ${f.message}`); break;
    case 'keyLearn': case 'root': toast(`Controller: ${f.result}`); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// reusable controls
// ---------------------------------------------------------------------------

function seg(options, get, pick, { cols, disabled } = {}) {
  const wrap = h('div', { class: 'seg', style: { '--cols': String(cols || options.length) } });
  const btns = options.map(([value, label]) => h('button', { class: 'btn', type: 'button', onclick: () => pick(value) }, label));
  wrap.append(...btns);
  bind(() => {
    const cur = get();
    const dis = disabled?.() ?? false;
    btns.forEach((b, i) => { b.classList.toggle('on', cur === options[i][0]); b.disabled = dis; });
  });
  return wrap;
}

function slider(label, min, max, get, onInput) {
  const name = h('span', { class: 'label' });
  const out = h('output');
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: '1', 'aria-label': typeof label === 'string' ? label : '' });
  let dragging = false;
  input.addEventListener('pointerdown', () => { dragging = true; });
  for (const ev of ['pointerup', 'pointercancel', 'change', 'blur']) input.addEventListener(ev, () => { dragging = false; });
  input.addEventListener('input', () => { out.textContent = input.value; onInput(Number(input.value)); });
  bind(() => {
    name.textContent = typeof label === 'function' ? label() : label;
    const v = get();
    if (!dragging && v != null) input.value = String(v);
    out.textContent = v == null && !dragging ? '–' : input.value;
  });
  return h('div', { class: 'slider' }, name, input, out);
}

function swatchGrid(colors, getSelected, pick, { cols = 5, extra } = {}) {
  const grid = h('div', { class: 'swatches', style: { 'grid-template-columns': `repeat(${cols}, 1fr)` } });
  const btns = colors.map((c, i) => h('button', { class: 'swatch', type: 'button', style: { background: c }, 'aria-label': `Colour ${i + 1}`, onclick: () => pick(i) }));
  grid.append(...btns);
  if (extra) grid.append(extra);
  bind(() => { const s = getSelected(); btns.forEach((b, i) => b.classList.toggle('on', s === i)); });
  return grid;
}

function onOffLine(label, hint, key, cmd) {
  return h('div', { class: 'toggle-line' },
    h('div', {}, h('div', {}, label), hint ? h('div', { class: 'hint', style: { margin: '2px 0 0' } }, hint) : null),
    seg([[true, 'ON'], [false, 'OFF']], () => state[key], (v) => { send(cmd(v)); set({ [key]: v }); }));
}

function card(title, sub, ...children) {
  return h('div', { class: 'card' }, h('h2', {}, title, sub ? h('span', { class: 'sub' }, sub) : null), ...children);
}
function detailsCard(title, ...children) {
  return h('details', { class: 'card' }, h('summary', {}, title), ...children);
}

/** 8 custom colour slots + palette to fill them (used by both RGB and light-bar tabs) */
function customSequence({ enabledKey, slotsKey, selKey, enableCmd, tableCmd, clearCmd }) {
  const slots = h('div', { class: 'slots' });
  const slotBtns = Array.from({ length: 8 }, (_, i) => h('button', {
    class: 'swatch', type: 'button', 'aria-label': `Slot ${i + 1}`, onclick: () => set({ [selKey]: i }),
  }));
  slots.append(...slotBtns);
  bind(() => {
    slotBtns.forEach((b, i) => {
      const v = state[slotsKey][i];
      b.classList.toggle('empty', v === PALETTE_EMPTY);
      b.style.background = v === PALETTE_EMPTY ? '' : PALETTE[v];
      b.classList.toggle('on', state[selKey] === i);
    });
  });
  const pickColor = (idx) => {
    const next = [...state[slotsKey]];
    next[state[selKey]] = idx;
    set({ [slotsKey]: next, [selKey]: (state[selKey] + 1) % 8 });
    if (!state[enabledKey]) { send(enableCmd(true)); set({ [enabledKey]: true }); }
    send(tableCmd(next), slotsKey);
  };
  const emptyBtn = h('button', { class: 'swatch empty', type: 'button', 'aria-label': 'Empty slot', title: 'Empty', onclick: () => pickColor(PALETTE_EMPTY) });
  return [
    h('label', { class: 'check' },
      bindCheckbox(() => state[enabledKey], (v) => { send(enableCmd(v)); set({ [enabledKey]: v }); }),
      'Use my own colour sequence'),
    slots,
    h('div', { class: 'hint' }, 'Tap a slot, then a colour. Up to 8 colours cycle in order.'),
    h('div', { style: { height: '8px' } }),
    swatchGrid([...PALETTE], () => state[slotsKey][state[selKey]], pickColor, { cols: 8, extra: emptyBtn }),
    h('div', { class: 'row', style: { 'margin-top': '10px' } },
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { send(clearCmd()); set({ [slotsKey]: emptySlots(), [selKey]: 0 }); } }, 'Clear sequence')),
  ];
}

function bindCheckbox(get, onChange) {
  const cb = h('input', { type: 'checkbox', onchange: () => onChange(cb.checked) });
  bind(() => { cb.checked = !!get(); });
  return cb;
}

// ---------------------------------------------------------------------------
// colour helpers + wheel
// ---------------------------------------------------------------------------

const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
function hsvToRgb(hDeg, s, v = 1) {
  const f = (n) => { const k = (n + hDeg / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
function rgbToHs(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6; else if (max === g) hue = (b - r) / d + 2; else hue = (r - g) / d + 4;
    hue *= 60; if (hue < 0) hue += 360;
  }
  return [hue, max ? d / max : 0];
}

let wheelDragging = false;

function setColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  send(Cmd.color(state.zone, r, g, b), 'color');
  const patch = { color: hex };
  if (state.zone !== 'zone2') patch.color1 = hex;
  if (state.zone !== 'zone1') patch.color2 = hex;
  set(patch);
}

function colorWheel() {
  const marker = h('div', { class: 'marker' });
  const wheel = h('div', { class: 'wheel', role: 'slider', 'aria-label': 'Colour wheel' }, marker);
  const pick = (e) => {
    const r = wheel.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const radius = r.width / 2;
    const sat = Math.min(1, Math.hypot(dx, dy) / radius);
    let hue = (Math.atan2(dx, -dy) * 180) / Math.PI; if (hue < 0) hue += 360;
    setColor(rgbToHex(...hsvToRgb(hue, sat)));
  };
  wheel.addEventListener('pointerdown', (e) => { wheelDragging = true; wheel.setPointerCapture(e.pointerId); pick(e); });
  wheel.addEventListener('pointermove', (e) => { if (wheelDragging) pick(e); });
  const end = () => { wheelDragging = false; };
  wheel.addEventListener('pointerup', end);
  wheel.addEventListener('pointercancel', end);
  bind(() => {
    const [hue, sat] = rgbToHs(...hexToRgb(state.color));
    const a = (hue * Math.PI) / 180;
    marker.style.left = `${50 + Math.sin(a) * sat * 50}%`;
    marker.style.top = `${50 - Math.cos(a) * sat * 50}%`;
    marker.style.background = state.color;
  });
  return wheel;
}

// ---------------------------------------------------------------------------
// scenes (saved favourites, stored only on this phone)
// ---------------------------------------------------------------------------

let scenes = store.get('scenes', []);

function captureScene(name) {
  return {
    name, power: state.power ?? 1, brightnessAll: state.brightnessAll, color: state.color,
    rgbMode: state.rgbMode ?? 0, flowMode: state.flowMode, flowSpeed: state.flowSpeed, flowReverse: state.flowReverse,
  };
}
function applyScene(s) {
  send(Cmd.power(s.power || 1));
  if (s.brightnessAll != null) send(Cmd.brightnessAll(s.brightnessAll));
  send(Cmd.rgbMode(s.rgbMode));
  if ([0x00, 0x03].includes(s.rgbMode) && s.color) { const [r, g, b] = hexToRgb(s.color); send(Cmd.color('all', r, g, b)); }
  if (s.flowMode != null) send(Cmd.flowMode(s.flowMode));
  if (s.flowSpeed != null) send(Cmd.flowSpeed(s.flowSpeed));
  if (s.flowReverse != null) send(Cmd.flowDirection(s.flowReverse));
  set({
    power: s.power || 1, brightnessAll: s.brightnessAll, rgbMode: s.rgbMode, color: s.color, color1: s.color, color2: s.color,
    flowMode: s.flowMode, flowSpeed: s.flowSpeed, flowReverse: s.flowReverse,
  });
  toast(`Scene "${s.name}" applied`);
}

function scenesCard() {
  const row = h('div', { class: 'scenes' });
  const render = () => {
    row.replaceChildren(
      ...scenes.map((s, i) => h('button', {
        class: 'btn small' + (state.scenesEdit ? ' danger' : ''), type: 'button',
        onclick: () => {
          if (state.scenesEdit) {
            if (confirm(`Delete scene "${s.name}"?`)) { scenes.splice(i, 1); store.set('scenes', scenes); render(); }
          } else applyScene(s);
        },
      }, h('i', { style: { background: s.color || '#888' } }), state.scenesEdit ? `✕ ${s.name}` : s.name)),
      h('button', {
        class: 'btn small ghost', type: 'button',
        onclick: () => {
          const name = prompt('Name this scene', `Scene ${scenes.length + 1}`);
          if (!name) return;
          scenes.push(captureScene(name.slice(0, 24)));
          store.set('scenes', scenes);
          render();
          toast('Saved on this phone');
        },
      }, '+ Save current'),
    );
  };
  render();
  const editBtn = h('button', { class: 'btn small ghost', type: 'button', onclick: () => { state.scenesEdit = !state.scenesEdit; editBtn.textContent = state.scenesEdit ? 'Done' : 'Edit'; render(); } }, 'Edit');
  return h('div', { class: 'card' }, h('h2', {}, 'Scenes', h('span', { class: 'sub' }, editBtn)), row,
    h('p', { class: 'hint' }, 'Saves power, brightness, RGB colour/effect and light-bar effect. Stored only on this phone.'));
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

function buildConnect() {
  const v = $('#view-connect');
  const prefix = h('input', { id: 'prefix', type: 'text', value: store.get('prefix', 'ATW'), autocapitalize: 'characters', autocomplete: 'off', spellcheck: false });
  const showAll = h('input', { id: 'show-all', type: 'checkbox', checked: store.get('showAll', false) });
  const connectBtn = h('button', { class: 'btn primary block', type: 'button', onclick: () => connect() }, 'Connect to controller');
  const reconnectBtn = h('button', { class: 'btn block', type: 'button', onclick: () => connect({ reuse: true }) }, 'Reconnect');
  const demoBtn = h('button', { class: 'btn ghost block', type: 'button', onclick: () => connect({ demo: true }) }, 'Try the demo (no car needed)');
  const diagPre = h('pre', { class: 'log', style: { 'max-height': '220px', 'white-space': 'pre-wrap' } });
  const diagCard = h('div', { class: 'card' },
    h('h3', { style: { 'margin-top': 0 } }, 'Connection details'),
    h('p', { class: 'hint' }, 'If connecting fails, copy this and send it over. It shows which step failed.'),
    diagPre,
    h('div', { class: 'row', style: { 'margin-top': '8px' } },
      h('button', { class: 'btn small', type: 'button', onclick: () => copyText((state.connectDiag?.steps || []).join('\n')) }, 'Copy details')),
    h('p', { class: 'hint' }, 'Tips: swipe the official app away in the app switcher (it keeps the connection in the background). Then turn Bluetooth off and on. If the box isn’t listed, tick “Show all Bluetooth devices”.'));
  bind(() => {
    const d = state.connectDiag;
    diagCard.hidden = !d || !d.steps?.length;
    diagPre.textContent = (d?.steps || []).join('\n');
  });
  const noBt = h('div', { class: 'banner info' },
    'This browser has no Web Bluetooth. On iPhone, open this page in the free ', h('b', {}, 'Bluefy'),
    ' browser. On a computer or Android phone, use Chrome or Edge.');

  v.append(
    h('div', { class: 'hero' }, h('div', { class: 'logo' }), h('h2', {}, 'Ambient Lights'),
      h('p', {}, 'Open-source controller for your car’s ambient light box. Talks to it over Bluetooth only — no accounts, no internet.')),
    noBt,
    h('div', { class: 'card' },
      h('div', { class: 'field' }, h('label', { for: 'prefix' }, 'Bluetooth name starts with'), prefix),
      h('label', { class: 'check' }, showAll, 'Show all Bluetooth devices (if yours isn’t listed)'),
      h('div', { style: { height: '6px' } }),
      connectBtn, h('div', { style: { height: '8px' } }), reconnectBtn, h('div', { style: { height: '8px' } }), demoBtn,
      h('p', { class: 'hint' }, 'Your box is called something like ATW-FWD-65E1. Close the official app first — the box accepts only one connection.')),
    diagCard,
  );
  bind(() => {
    noBt.hidden = WebBluetoothTransport.available;
    connectBtn.disabled = state.connecting || !WebBluetoothTransport.available;
    connectBtn.textContent = state.connecting ? 'Connecting…' : 'Connect to controller';
    reconnectBtn.hidden = !(lastTransport instanceof WebBluetoothTransport);
    reconnectBtn.disabled = state.connecting;
    demoBtn.disabled = state.connecting;
  });
}

function buildRgb() {
  const v = $('#view-rgb');
  const hexInput = h('input', {
    type: 'text', maxlength: '7', 'aria-label': 'Hex colour', spellcheck: false,
    onchange: () => { const m = hexInput.value.trim().match(/^#?([0-9a-f]{6})$/i); if (m) setColor('#' + m[1].toLowerCase()); else toast('Use a colour like #FF00AA'); },
  });
  const chip = h('div', { class: 'chip' });
  bind(() => { if (document.activeElement !== hexInput) hexInput.value = state.color.toUpperCase(); chip.style.background = state.color; });

  const modeGroups = RGB_MODES.map((g) => h('div', { class: 'mode-group' },
    h('div', { class: 'label' }, g.group),
    seg(g.items, () => state.rgbMode, (code) => { send(Cmd.rgbMode(code)); set({ rgbMode: code }); }, { cols: 3 })));

  v.append(
    scenesCard(),
    card('Colour', 'door & footwell RGB',
      seg([['all', 'All'], ['zone1', 'Zone 1'], ['zone2', 'Zone 2']], () => state.zone, (z) => {
        const c = z === 'zone2' ? state.color2 : state.color1;
        set({ zone: z, ...(c ? { color: c } : {}) });
      }),
      h('div', { style: { height: '14px' } }),
      h('div', { class: 'wheel-wrap' }, colorWheel(), h('div', { class: 'current-color' }, chip, hexInput)),
      h('h3', {}, 'Common colours'),
      swatchGrid(PALETTE, () => PALETTE.indexOf(state.color), (i) => setColor(PALETTE[i])),
      h('p', { class: 'hint' }, 'Colour shows in the “Single” effects. Picking a colour switches nothing else.')),
    card('RGB effect', null, ...modeGroups),
    card('Custom colour sequence', null,
      ...customSequence({ enabledKey: 'rgbCustom', slotsKey: 'rgbSlots', selKey: 'rgbSlot', enableCmd: Cmd.rgbCustomEnable, tableCmd: Cmd.rgbCustomTable, clearCmd: Cmd.rgbCustomClear }),
      slider('Speed', 1, 10, () => state.rgbSpeed, (x) => { send(Cmd.rgbCustomSpeed(x), 'rgbSpeed'); state.rgbSpeed = x; })),
  );
}

function buildFlow() {
  const v = $('#view-flow');
  const groupsHost = h('div');
  let builtFor = null;
  bind(() => {
    if (builtFor === state.gen) return;
    builtFor = state.gen;
    groupsHost.replaceChildren(...flowModesFor(state.gen).map((g) => h('div', { class: 'mode-group' },
      h('div', { class: 'label' }, g.group),
      seg(g.items, () => state.flowMode, (code) => { send(Cmd.flowMode(code)); set({ flowMode: code }); }, { cols: 3 }))));
  });

  v.append(
    card('Light bar effect', 'addressable strips', groupsHost),
    card('Motion', null,
      slider('Speed', 1, 5, () => state.flowSpeed, (x) => { send(Cmd.flowSpeed(x), 'flowSpeed'); state.flowSpeed = x; }),
      h('h3', {}, 'Flow direction'),
      seg([[false, 'Forward'], [true, 'Reverse']], () => state.flowReverse, (r) => { send(Cmd.flowDirection(r)); set({ flowReverse: r }); })),
    card('Effect toggle', 'variant 1–6',
      seg([1, 2, 3, 4, 5, 6].map((n) => [n, String(n).padStart(2, '0')]), () => state.effectToggle, (n) => {
        if (state.flowCustom) { send(Cmd.flowCustomEnable(false)); state.flowCustom = false; }
        send(Cmd.flowEffectToggle(n)); set({ effectToggle: n });
      }, { cols: 6 })),
    card('Custom colours', null,
      ...customSequence({ enabledKey: 'flowCustom', slotsKey: 'flowSlots', selKey: 'flowSlot', enableCmd: Cmd.flowCustomEnable, tableCmd: Cmd.flowCustomTable, clearCmd: Cmd.flowCustomClear }),
      slider('Length', 1, 10, () => state.flowLength, (x) => { send(Cmd.flowCustomLength(x), 'flowLength'); state.flowLength = x; }),
      slider('Interval', 0, 9, () => state.flowInterval, (x) => { send(Cmd.flowCustomInterval(x), 'flowInterval'); state.flowInterval = x; })),
    detailsCard('Extra effects (hidden in the official app)',
      h('div', { class: 'banner warn' }, 'The vendor code has these “Common effects”, but the iOS app doesn’t show them for your box. They may do nothing — harmless to try.'),
      seg(COMMON_EFFECTS.map((n, i) => [i, n]), () => state.commonEffect, (i) => { send(Cmd.flowCommonEffect(i)); set({ commonEffect: i }); }, { cols: 2 })),
  );
}

function buildLight() {
  const v = $('#view-light');
  const labels = () => (state.frontBack ? ['Center', 'Doors', 'Footwell'] : ['All', 'Zone 1', 'Zone 2']);
  const levelSeg = seg([1, 2, 3, 4, 5].map((n) => [n, String(n)]), () => state.nightLevel, (n) => {
    send(Cmd.nightDim(state.nightDim ?? true, n)); set({ nightLevel: n, nightDim: state.nightDim ?? true });
  }, { cols: 5 });

  v.append(
    card('Power', null,
      seg([[0, 'OFF'], [1, 'ON'], [2, 'AUTO']], () => state.power, (p) => { send(Cmd.power(p)); set({ power: p }); }),
      h('p', { class: 'hint' }, 'AUTO follows the car (lights on with the car’s own interior lighting).')),
    card('Brightness', '0–9',
      slider(() => labels()[0], 0, 9, () => state.brightnessAll, (x) => {
        send(Cmd.brightnessAll(x), 'briAll');
        state.brightnessAll = x;
        if (!state.frontBack) { state.brightnessZone1 = x; state.brightnessZone2 = x; refresh(); }
      }),
      slider(() => labels()[1], 0, 9, () => state.brightnessZone1, (x) => { send(Cmd.brightnessZone(1, x), 'bri1'); state.brightnessZone1 = x; }),
      slider(() => labels()[2], 0, 9, () => state.brightnessZone2, (x) => { send(Cmd.brightnessZone(2, x), 'bri2'); state.brightnessZone2 = x; }),
      h('h3', {}, 'Zone layout'),
      seg([[false, 'Up and down'], [true, 'Front and back']], () => state.frontBack, (fb) => { send(Cmd.zoneLayout(fb)); set({ frontBack: fb }); })),
    card('Night dimming', null,
      h('label', { class: 'check' }, bindCheckbox(() => state.nightDim, (on) => {
        send(Cmd.nightDim(on, state.nightLevel ?? 3)); set({ nightDim: on, nightLevel: state.nightLevel ?? 3 });
      }), 'Dim while driving at night'),
      levelSeg,
      h('p', { class: 'hint' }, 'Level 1–5 = how much to dim. The box detects night from the car (headlights / light sensor).')),
    card('Control mode', null,
      seg([[false, 'Car & phone'], [true, 'Phone only']], () => state.forcePhone, (fp) => { send(Cmd.controlMode(fp)); set({ forcePhone: fp }); }),
      h('p', { class: 'hint' }, '“Car & phone” lets the car’s own ambient-light menu change the lights too. “Phone only” keeps your settings from this app.')),
  );
}

function doorLightCard() {
  const status = h('p', { class: 'hint' });
  const picker = h('input', { type: 'color', class: 'input', style: { height: '44px', padding: '4px' }, 'aria-label': 'Any door colour', onchange: () => setDoorPrefs({ color: picker.value.toLowerCase() }) });
  const body = h('div', {},
    h('div', { class: 'toggle-line' },
      h('div', {}, h('div', {}, 'Custom open-door light'), h('div', { class: 'hint', style: { margin: '2px 0 0' } }, 'Replaces the normal door warning while a door is open')),
      seg([[true, 'ON'], [false, 'OFF']], () => doorPrefs().on, (on) => setDoorPrefs({ on }))),
    h('h3', {}, 'Door colour'),
    swatchGrid(PALETTE, () => PALETTE.indexOf(doorPrefs().color), (i) => setDoorPrefs({ color: PALETTE[i] })),
    h('div', { class: 'field', style: { 'margin-top': '10px' } }, h('label', {}, 'Any colour'), picker),
    h('h3', {}, 'Effect when a door is open'),
    seg(DOOR_EFFECTS.map((label, i) => [i, label]), () => doorPrefs().effect, (effect) => setDoorPrefs({ effect }), { cols: 3 }),
    h('h3', {}, 'Speed'),
    seg([[5, 'Fast'], [15, 'Normal'], [30, 'Slow']], () => doorPrefs().period, (period) => setDoorPrefs({ period })),
    slider('Brightness', 1, 10, () => Math.max(1, Math.round(doorPrefs().brightness / 10)), (x) => setDoorPrefs({ brightness: x * 10 }, { debounce: true })),
    h('p', { class: 'hint' }, 'Works while the ignition is on. Saved on this phone and sent again every time you connect. Which strip belongs to which door can be changed under Device › Custom door effects (advanced).'));
  bind(() => {
    const prefs = doorPrefs();
    if (document.activeElement !== picker) picker.value = prefs.color;
    const supported = state.doorFx.verifiedConnection && isDoorFirmware(state.version.software);
    body.hidden = !supported;
    const s = state.doorFx.replies.S;
    status.textContent = !supported ? 'Needs the custom door firmware 261115-075 (Device › Firmware update).'
      : !prefs.on ? 'Off: doors show the normal warning.'
        : !s ? 'On: settings sent.'
          : s[4] === 1 ? 'On: a door effect is showing now.'
            : s[4] === 0 ? 'On and ready: open a door.'
              : s[4] === 6 ? 'On: settings not confirmed yet, switch it OFF and ON again.'
                : `On, waiting: ${DOOR_REASONS[s[4]] || 'unknown state'}.`;
  });
  return card('Doors', 'custom firmware', status, body);
}

function buildCar() {
  const v = $('#view-car');
  const syncBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { send(Cmd.welcomeColorSyncRgb()); set({ welcomeColor: 'sync' }); } }, 'Use RGB colour');
  bind(() => { syncBtn.hidden = !state.welcomeSyncSupported; syncBtn.classList.toggle('on', state.welcomeColor === 'sync'); });

  const mirrorInputs = ['unlock', 'door', 'turn', 'reverse'].map((ev) => {
    const input = h('input', { type: 'number', min: '0', max: '60', inputmode: 'numeric', class: 'input' });
    input.addEventListener('change', () => {
      const s = Math.max(0, Math.min(60, Math.round(Number(input.value) || 0)));
      input.value = String(s);
      send(Cmd.mirrorDelay(ev, s));
      set({ mirror: { ...(state.mirror || {}), [ev]: s } });
    });
    bind(() => { if (document.activeElement !== input) input.value = state.mirror?.[ev] ?? ''; });
    return h('div', { class: 'field' }, h('label', {}, { unlock: 'On unlock', door: 'On door open', turn: 'On turn signal', reverse: 'On reverse' }[ev] + ' (s)'), input);
  });

  v.append(
    card('Reacts to the car', null,
      onOffLine('Door', 'Flash when a door opens', 'door', Cmd.activeDoor),
      onOffLine('Radar', 'Parking sensors', 'radar', Cmd.activeRadar),
      onOffLine('Speed', 'Changes with driving speed', 'speed', Cmd.activeSpeed),
      onOffLine('Steering', 'Turn signals', 'steering', Cmd.activeSteering),
      onOffLine('Air', 'Colour follows A/C', 'airCon', Cmd.activeAirCon),
      onOffLine('Blind spot', 'Warns of cars beside you', 'blindSpot', Cmd.activeBlindSpot),
      h('p', { class: 'hint' }, 'Needs the matching signal wired / CAN support for your car. If a feature isn’t supported the box will say so.')),
    card('Warning colours', null,
      h('h3', {}, 'Door'), swatchGrid(WARN_COLORS, () => state.doorColor, (i) => { send(Cmd.doorColor(i)); set({ doorColor: i }); }, { cols: 4 }),
      h('h3', {}, 'Turn signal'), swatchGrid(WARN_COLORS, () => state.turnColor, (i) => { send(Cmd.turnColor(i)); set({ turnColor: i }); }, { cols: 4 }),
      h('h3', {}, 'Blind spot'), swatchGrid(WARN_COLORS.slice(0, 2), () => state.blindColor, (i) => { send(Cmd.blindColor(i)); set({ blindColor: i }); }, { cols: 4 }),
      h('p', { class: 'hint' }, 'The box doesn’t report these back, so nothing is highlighted until you pick one.')),
    doorLightCard(),
    card('Welcome light', 'when you unlock / open',
      seg([[true, 'ON'], [false, 'OFF']], () => state.welcome, (on) => { send(Cmd.welcome(on)); set({ welcome: on }); }),
      h('h3', {}, 'Animation'),
      seg(WELCOME_MODES.map((n, i) => [i, n]), () => state.welcomeMode, (m) => { send(Cmd.welcomeMode(m)); set({ welcomeMode: m }); }, { cols: 2 }),
      h('h3', {}, 'Colour'),
      swatchGrid(PALETTE, () => state.welcomeColor, (i) => { send(Cmd.welcomeColor(i)); set({ welcomeColor: i }); }),
      h('div', { class: 'row', style: { 'margin-top': '8px' } }, syncBtn)),
    card('Music', null,
      slider('Mic sensitivity', 0, 9, () => state.mic, (x) => { send(Cmd.micSensitivity(x), 'mic'); state.mic = x; }),
      h('h3', {}, 'Sound source'),
      seg([['mic', 'Box microphone'], ['horn', 'Car speakers']], () => state.soundSource, (s) => { send(Cmd.soundSource(s === 'horn')); set({ soundSource: s }); }),
      h('p', { class: 'hint' }, 'Used by the “Rhythm” effects. The microphone is inside the controller box, not your phone.')),
    detailsCard('Mirror welcome light (if fitted)',
      h('p', { class: 'hint' }, 'Only for kits with mirror puddle lights. The official app hides this unless the box reports the module.'),
      seg([[0, 'OFF'], [1, 'ON'], [2, 'AUTO']], () => state.mirror?.mode, (m) => { send(Cmd.mirrorLight(m)); set({ mirror: { ...(state.mirror || {}), mode: m } }); }),
      h('h3', {}, 'Stay on for'),
      h('div', { class: 'lamp-grid' }, ...mirrorInputs),
      h('p', { class: 'hint' }, '0 = off. Above 15 km/h the box switches it off by itself.')),
    buildLab(),
  );
}

// ---------------------------------------------------------------------------
// "Explore hidden options": look for firmware features the official app never uses
// ---------------------------------------------------------------------------

const PROBES = [
  { id: 'door', label: 'Door reaction (31)', op: '31', known: '00 = off, 01 = on', from: 2, to: 9, trigger: 'Open and close a door.', restore: () => Cmd.activeDoor(state.door ?? true) },
  { id: 'doorColor', label: 'Door warning colour (46)', op: '46', known: '00–03 = red, yellow, purple, blue', from: 4, to: 15, trigger: 'Open a door.', restore: () => Cmd.doorColor(state.doorColor ?? 0) },
  { id: 'air', label: 'A/C reaction (35)', op: '35', known: '00 = off, 01 = on', from: 2, to: 9, trigger: 'Change the A/C temperature up and down.', restore: () => Cmd.activeAirCon(state.airCon ?? false) },
  { id: 'steering', label: 'Turn-signal reaction (34)', op: '34', known: '00 = off, 01 = on', from: 2, to: 9, trigger: 'Use the indicator.', restore: () => Cmd.activeSteering(state.steering ?? false) },
  { id: 'turnColor', label: 'Turn-signal colour (45)', op: '45', known: '00–03', from: 4, to: 15, trigger: 'Use the indicator (with Steering ON).', restore: () => Cmd.turnColor(state.turnColor ?? 0) },
  { id: 'speed', label: 'Speed reaction (33)', op: '33', known: '00 = off, 01 = on', from: 2, to: 9, trigger: 'Needs driving — test later, not while parked.', restore: () => Cmd.activeSpeed(state.speed ?? false) },
  { id: 'radar', label: 'Parking-radar reaction (32)', op: '32', known: '00 = off, 01 = on', from: 2, to: 9, trigger: 'Engage reverse near an obstacle.', restore: () => Cmd.activeRadar(state.radar ?? false) },
  { id: 'welcomeMode', label: 'Welcome animation (39)', op: '39', known: '00–05', from: 6, to: 15, trigger: 'Lock, then unlock the car.', restore: () => Cmd.welcomeMode(state.welcomeMode ?? 0) },
];

const lab = {
  findings: store.get('labFindings', []),
  watching: false,
  events: [],
  lastTx: 0,
  pending: null, // { payload, timer, onResult }
};

link.addEventListener('tx', () => { lab.lastTx = Date.now(); });
link.addEventListener('frame', (e) => {
  const f = parseFrame(e.detail.payload);
  if (lab.pending && (f.type === 'notSupported' || f.type === 'alert')) {
    const p = lab.pending;
    lab.pending = null;
    clearTimeout(p.timer);
    p.onResult(f.type === 'notSupported' || f.code === 0 ? 'rejected' : f.code === 1 ? 'ok' : 'error', f);
  }
  // anything arriving >1.5 s after our last command was sent by the box on its own
  if (lab.watching && Date.now() - lab.lastTx > 1500) {
    lab.events.push({ t: new Date(), payload: e.detail.payload, type: f.type });
    lab.renderEvents?.();
  }
});

function buildLab() {
  // --- 1. event watcher
  const evList = h('pre', { class: 'log', style: { 'max-height': '160px' } });
  const watchBtn = h('button', { class: 'btn primary', type: 'button' }, 'Start watching');
  lab.renderEvents = () => {
    evList.replaceChildren(...(lab.events.length
      ? lab.events.slice(-40).map((ev) => h('div', { class: 'rx' }, `${ev.t.toTimeString().slice(0, 8)} ← <${ev.payload}>  (${ev.type})`))
      : [h('div', { class: 'dim' }, lab.watching ? 'Watching… nothing received yet.' : 'Not watching.')]));
  };
  watchBtn.addEventListener('click', () => {
    lab.watching = !lab.watching;
    if (lab.watching) lab.events = [];
    watchBtn.textContent = lab.watching ? 'Stop watching' : 'Start watching';
    watchBtn.classList.toggle('primary', !lab.watching);
    lab.renderEvents();
  });
  lab.renderEvents();

  // --- 2. hidden value prober
  const select = h('select', { class: 'input', 'aria-label': 'Setting to explore' }, ...PROBES.map((p) => h('option', { value: p.id }, p.label)));
  const knownLine = h('p', { class: 'hint' });
  const valueOut = h('output', { style: { 'font-variant-numeric': 'tabular-nums', 'font-size': '18px', 'min-width': '72px', 'text-align': 'center' } });
  const result = h('p', { class: 'hint' }, 'Pick a setting and a value, then Send.');
  const verdictRow = h('div', { class: 'seg', style: { '--cols': '2' }, hidden: true });
  let probe = PROBES[0];
  let value = probe.from;
  let lastSent = null;

  const hx2 = (n) => n.toString(16).padStart(2, '0').toUpperCase();
  const renderProbe = () => {
    knownLine.textContent = `Official values: ${probe.known}. To test: ${probe.trigger}`;
    valueOut.textContent = `${probe.op} ${hx2(value)}`;
  };
  select.addEventListener('change', () => { probe = PROBES.find((p) => p.id === select.value); value = probe.from; renderProbe(); });
  const step = (d) => { value = Math.min(probe.to, Math.max(probe.from, value + d)); renderProbe(); };

  const sendProbe = () => {
    if (!link.connected) { toast('Not connected'); return; }
    const payload = probe.op + hx2(value);
    lastSent = { probe: probe.id, label: probe.label, payload };
    verdictRow.hidden = true;
    result.className = 'hint';
    result.textContent = `Sent <${payload}> … waiting for the box`;
    if (lab.pending) clearTimeout(lab.pending.timer);
    lab.pending = {
      payload,
      timer: setTimeout(() => {
        lab.pending = null;
        lastSent.reply = 'none';
        result.className = 'hint warn';
        result.textContent = `No objection from the box to <${payload}>. ${probe.trigger} Did anything look different?`;
        verdictRow.hidden = false;
      }, 1500),
      onResult: (kind) => {
        lastSent.reply = kind;
        if (kind === 'rejected') {
          result.className = 'hint';
          result.textContent = `The box rejected <${payload}> (not supported). Restoring the official value.`;
          send(probe.restore());
          addFinding({ ...lastSent, verdict: 'rejected by box' });
        } else {
          result.className = 'hint warn';
          result.textContent = `The box answered "${kind}" to <${payload}>. ${probe.trigger} Did anything look different?`;
          verdictRow.hidden = false;
        }
      },
    };
    send(payload);
  };

  const addFinding = (f) => {
    const d = new Date();
    const at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 5)}`;
    lab.findings.push({ ...f, at });
    store.set('labFindings', lab.findings);
    renderFindings();
  };
  verdictRow.append(
    h('button', { class: 'btn', type: 'button', onclick: () => { addFinding({ ...lastSent, verdict: 'NEW behaviour' }); verdictRow.hidden = true; result.className = 'hint'; result.textContent = 'Saved. Keep it, or tap Restore to go back.'; } }, 'Something new!'),
    h('button', { class: 'btn', type: 'button', onclick: () => { addFinding({ ...lastSent, verdict: 'no visible change' }); verdictRow.hidden = true; send(probe.restore()); result.className = 'hint'; result.textContent = 'Saved and restored. Try the next value.'; step(1); } }, 'No change'),
  );

  const findingsPre = h('pre', { class: 'log', style: { 'max-height': '160px' } });
  const renderFindings = () => {
    findingsPre.replaceChildren(...(lab.findings.length
      ? lab.findings.map((f) => h('div', { class: f.verdict === 'NEW behaviour' ? 'rx' : 'dim' }, `${f.at}  <${f.payload}>  ${f.verdict}`))
      : [h('div', { class: 'dim' }, 'No results yet.')]));
  };
  renderFindings();
  renderProbe();

  return detailsCard('Explore hidden effects',
    h('p', { class: 'hint', style: { 'margin-top': 0 } }, 'The door, A/C and turn-signal animations are drawn by the box’s own firmware. The official app can only switch them on/off and choose 4 door colours — there is no command for a new animation. These tools check whether the firmware secretly supports more.'),
    h('h3', {}, '1 · Does the box report car events?'),
    h('p', { class: 'hint' }, 'Start watching, then open a door, change the temperature, use the indicator. If messages appear here, this app could later trigger its own reactions (e.g. switch the light bars to red “Closing” when a door opens).'),
    watchBtn, h('div', { style: { height: '8px' } }), evList,
    h('h3', {}, '2 · Try values the official app never sends'),
    h('div', { class: 'banner warn' }, 'Park the car first. The box either rejects an unknown value, ignores it, or shows something new. Restore always puts the official value back.'),
    select, knownLine,
    h('div', { class: 'row', style: { 'justify-content': 'center' } },
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Previous value', onclick: () => step(-1) }, '−'),
      valueOut,
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Next value', onclick: () => step(1) }, '+')),
    h('div', { class: 'seg', style: { '--cols': '2', 'margin-top': '10px' } },
      h('button', { class: 'btn primary', type: 'button', onclick: sendProbe }, 'Send test value'),
      h('button', { class: 'btn', type: 'button', onclick: () => { send(probe.restore()); result.className = 'hint'; result.textContent = 'Official value restored.'; verdictRow.hidden = true; } }, 'Restore')),
    result, verdictRow,
    h('h3', {}, '3 · Effect toggle'),
    h('p', { class: 'hint' }, 'Light bars → Effect toggle 01–06 is undocumented. It might switch the animation style the box uses for these reactions too — change it, then open a door / change the temperature and compare.'),
    h('h3', {}, 'Your results'),
    findingsPre,
    h('div', { class: 'row', style: { 'margin-top': '8px' } },
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => copyText(lab.findings.map((f) => `${f.at} ${f.label} <${f.payload}> reply=${f.reply} -> ${f.verdict}`).join('\n')) }, 'Copy results'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { if (confirm('Clear all results?')) { lab.findings = []; store.set('labFindings', []); renderFindings(); } } }, 'Clear')),
  );
}

// ---------------------------------------------------------------------------
// device / installer
// ---------------------------------------------------------------------------

let logPre, logCard, otaCard, offlineTools, deviceTools;

function buildDoorEffects() {
  const prefs = doorPrefs();
  const color = h('input', { type: 'color', class: 'input', value: prefs.color, 'aria-label': 'Door warning color' });
  const effect = h('select', { class: 'input' }, ...DOOR_EFFECTS.map((label, i) => h('option', { value: String(i) }, label)));
  effect.value = String(prefs.effect);
  const brightness = h('input', { type: 'number', min: '0', max: '100', step: '1', class: 'input', value: String(prefs.brightness) });
  const period = h('select', { class: 'input' }, ...[5, 10, 15, 20, 30, 50, 100].map(n => h('option', { value: String(n) }, `${n / 10} seconds per cycle`)));
  period.value = String(prefs.period);
  const maps = [], reverses = [], enables = [];
  const mappingRows = Array.from({ length: 4 }, (_, slot) => {
    const map = h('select', { class: 'input', 'aria-label': `C${slot} door signal` }, ...[0, 1, 2, 3].map(n => h('option', { value: String(n) }, `Door signal ${n + 1}`)));
    map.value = String(prefs.mapping[slot]); maps.push(map);
    const reverse = h('input', { type: 'checkbox', checked: !!(prefs.reverse & (1 << slot)) }); reverses.push(reverse);
    const enable = h('input', { type: 'checkbox', checked: !!(prefs.enabled & (1 << slot)) }); enables.push(enable);
    return h('div', { class: 'field' }, h('label', {}, `Strip channel C${slot}`), map,
      h('label', { class: 'check' }, enable, 'Use custom effect on this channel'), h('label', { class: 'check' }, reverse, 'Reverse animation direction'));
  });
  const actions = [];
  const sendDoor = payload => {
    if (!state.doorFx.verifiedConnection || !isDoorFirmware(state.version.software)) { toast('This control requires a fresh 261115-072, -074 or -075 firmware reply'); return false; }
    return send(payload);
  };
  const button = (label, fn, primary = false) => {
    const b = h('button', { class: `btn ${primary ? 'primary ' : ''}block`, type: 'button', onclick: fn }, label); actions.push(b); return b;
  };
  const apply = button('Apply and enable door effects', () => {
    try {
      const config = { effect: Number(effect.value), color: color.value, brightness: Number(brightness.value), period: Number(period.value),
        mapping: maps.map(m => Number(m.value)), reverse: reverses.reduce((n, c, i) => n | (c.checked ? 1 << i : 0), 0),
        enabled: enables.reduce((n, c, i) => n | (c.checked ? 1 << i : 0), 0) };
      const commands = doorConfiguration(config);
      for (const command of commands) if (!sendDoor(command)) return;
      const saved = { ...config, on: true };
      store.set('doorEffects072', saved); set({ doorFx: { ...state.doorFx, preferences: saved } });
      toast('Settings queued. Read controller status to confirm.');
    } catch (e) { toast(e.message); }
  }, true);
  const read = button('Read door effect status', () => sendDoor(doorCommand(2)));
  const stop = button('Disable custom door effects', () => {
    if (!sendDoor(doorCommand(0))) return;
    const saved = { ...doorPrefs(), on: false };
    store.set('doorEffects072', saved); set({ doorFx: { ...state.doorFx, preferences: saved } });
  });
  const status = h('p', { class: 'hint' });
  bind(() => {
    const supported = state.doorFx.verifiedConnection && isDoorFirmware(state.version.software);
    actions.forEach(b => { b.disabled = !supported || !state.connected || link.otaLock; });
    const s = state.doorFx.replies.S, x = state.doorFx.replies.X;
    status.textContent = !supported ? 'Requires the custom 261115-072, -074 or -075 firmware. These controls do not operate on 071 or vendor firmware.'
      : s ? `Last read: ${s[0] ? 'Enabled' : 'Disabled'} · ignition value ${s[1]} · door bits ${s[2].toString(16).toUpperCase()} · active channels ${s[3].toString(16).toUpperCase()} · ${DOOR_REASONS[s[4]] || 'Unknown state'}`
        : 'Read status to check the controller. Settings are disabled after a controller restart until you apply them again.';
    if (supported && x) status.textContent += ` · Last refusal: ${DOOR_REFUSALS[x[0]] || `code ${x[0]}`}`;
  });
  return detailsCard('Custom door effects (advanced)', status,
    h('p', { class: 'hint' }, 'Experimental: configure while parked. Native welcome and A/C overlays have priority. Settings stay in controller RAM until its next restart; preferences are saved on this phone. This version does not add a leaving animation.'),
    h('div', { class: 'field' }, h('label', {}, 'Door warning color'), color),
    h('div', { class: 'field' }, h('label', {}, 'Effect'), effect),
    h('div', { class: 'field' }, h('label', {}, 'Brightness limit (%) — also follows native dimming'), brightness),
    h('div', { class: 'field' }, h('label', {}, 'Effect cycle'), period),
    h('details', {}, h('summary', {}, 'Map doors and animation direction'),
      h('p', { class: 'hint' }, 'The default order was measured on the car: C0 rear left, C1 front left, C2 front right, C3 rear right. To check a channel, tick only that channel, apply, and open doors one at a time. Open one door and read status to see its signal bit (1, 2, 4, or 8). Assign each of the four signals once.'), ...mappingRows),
    apply, read, stop,
    h('p', { class: 'hint' }, 'Disable ends automatic effects. After closing a door, the controller sends a flat native-color hand-back while normal animation packets continue; exact receiver restoration still needs verification.'));
}
function renderLog() {
  if (!logPre || logPre.closest('details')?.open === false) return;
  const fmt = (d) => d.toTimeString().slice(0, 8);
  logPre.replaceChildren(...state.log.slice(-150).map((e) => h('div', { class: e.kind },
    `${fmt(e.t)} ${e.kind === 'tx' ? '→' : e.kind === 'rx' ? '←' : '•'} ${e.text}${e.note ? `  (${e.note})` : ''}`)));
  logPre.scrollTop = logPre.scrollHeight;
}

function factoryEnter() {
  set({ factory: { ...state.factory, active: true, edit: false } });
  send(Cmd.factoryEnter());
}
function factoryExit() {
  if (!state.factory.active) return;
  if (link.connected) send(Cmd.factoryExit());
  set({ factory: { ...state.factory, active: false, edit: false } });
}

function bitsRow(which) {
  const host = h('div', { class: 'bits' });
  bind(() => {
    const d = state.factory.draftDial;
    if (!d) { host.replaceChildren(); return; }
    const arr = d[which];
    host.style.setProperty('--n', String(arr.length));
    host.replaceChildren(...arr.map((on, i) => h('button', {
      class: 'bit' + (on ? ' on' : ''), type: 'button', disabled: !state.factory.edit, 'aria-pressed': on ? 'true' : 'false',
      onclick: () => {
        const nd = { model: [...d.model], function: [...d.function] };
        nd[which][i] = !nd[which][i];
        set({ factory: { ...state.factory, draftDial: nd } });
      },
    }, h('span', { class: 'knob' }), String(i + 1))));
  });
  return host;
}

const onList = (arr) => arr.map((b, i) => (b ? i + 1 : null)).filter(Boolean).join(', ') || 'none';
const bitStr = (arr) => arr.map((b) => (b ? '1' : '0')).join('');

function lampEditor() {
  const host = h('div');
  const L = [
    ['driver', 'Driver side (“Host”)', 'driverRightOut', ['Left out', 'Right out'], Cmd.lampsDriver, (v) => Cmd.dirDriver(v)],
    ['passenger', 'Passenger side (“Copilot”)', 'passengerRightOut', ['Left out', 'Right out'], Cmd.lampsPassenger, (v) => Cmd.dirPassenger(v)],
    ['frontDoors', 'Front doors', null, null, Cmd.lampsFrontDoors, null],
    ['rearDoors', 'Rear doors', null, null, Cmd.lampsRearDoors, null],
  ];
  const doors = [['lfFrontOut', 'Left front', 'lf'], ['rfFrontOut', 'Right front', 'rf'], ['lrFrontOut', 'Left rear', 'lr'], ['rrFrontOut', 'Right rear', 'rr']];
  let built = false;
  bind(() => {
    const d = state.factory.draftLamps;
    if (!d) { host.replaceChildren(h('p', { class: 'hint' }, 'Not read yet.')); built = false; return; }
    if (built) return; // controls keep themselves in sync below
    built = true;
    const edit = () => state.factory.edit;
    const upd = (patch) => set({ factory: { ...state.factory, draftLamps: { ...state.factory.draftLamps, ...patch } } });
    const boxes = L.map(([key, label, dirKey, dirLabels]) => {
      const input = h('input', { type: 'number', min: '0', max: '200', inputmode: 'numeric', class: 'input', onchange: () => upd({ [key]: Math.max(0, Math.min(200, Math.round(Number(input.value) || 0))) }) });
      bind(() => { if (document.activeElement !== input) input.value = String(state.factory.draftLamps?.[key] ?? ''); input.disabled = !edit(); });
      return h('div', { class: 'box' }, h('b', {}, label), h('label', { class: 'hint', style: { margin: 0 } }, 'LEDs'), input,
        dirKey ? seg([[false, dirLabels[0]], [true, dirLabels[1]]], () => state.factory.draftLamps?.[dirKey], (val) => upd({ [dirKey]: val }), { disabled: () => !edit() }) : null);
    });
    const doorBoxes = d.layout === 'perDoor' ? doors.map(([key, label]) => h('div', { class: 'box' }, h('b', {}, label),
      seg([[true, 'Front out'], [false, 'Back out']], () => state.factory.draftLamps?.[key], (val) => upd({ [key]: val }), { disabled: () => !edit() }))) : [];
    host.replaceChildren(h('div', { class: 'lamp-grid' }, ...boxes), doorBoxes.length ? h('h3', {}, 'Door strip direction') : null, h('div', { class: 'lamp-grid' }, ...doorBoxes));
  });
  const applyBtn = h('button', {
    class: 'btn primary block', type: 'button',
    onclick: () => {
      const a = state.factory.lamps, d = state.factory.draftLamps;
      const cmds = [], lines = [];
      for (const [key, label, dirKey, dirLabels, countCmd, dirCmd] of L) {
        if (a[key] !== d[key]) { cmds.push(countCmd(d[key])); lines.push(`${label}: ${a[key]} → ${d[key]} LEDs`); }
        if (dirKey && a[dirKey] !== d[dirKey]) { cmds.push(dirCmd(d[dirKey])); lines.push(`${label}: ${dirLabels[+a[dirKey]]} → ${dirLabels[+d[dirKey]]}`); }
      }
      for (const [key, label, door] of doors) {
        if (d.layout === 'perDoor' && a[key] !== d[key]) { cmds.push(Cmd.dirDoor(door, d[key])); lines.push(`${label}: ${a[key] ? 'Front' : 'Back'} out → ${d[key] ? 'Front' : 'Back'} out`); }
      }
      if (!cmds.length) { toast('Nothing changed'); return; }
      if (!confirm(`Write these changes to the controller?\n\n${lines.join('\n')}`)) return;
      cmds.forEach((c) => send(c));
      set({ factory: { ...state.factory, lamps: { ...d } } });
      toast('Layout sent. Use “Start test” to check.');
    },
  }, 'Write layout changes');
  bind(() => { applyBtn.hidden = !state.factory.edit || !state.factory.draftLamps; });
  return [host, h('div', { style: { height: '10px' } }), applyBtn];
}

function buildDevice() {
  const v = $('#view-device');
  const kv = h('dl', { class: 'kv' });
  bind(() => {
    const g = { 0: 'Legacy (status 0x12)', 1: 'Gen 1 (status 0x1F)', 2: 'Gen 2 (status 0x4E)', 3: 'Gen 3 (status 0x5A)' };
    const rows = [
      ['Name', link.name || '–'],
      ['Car model', state.version.carModel || '–'],
      ['Hardware', state.version.hardware || '–'],
      ['Software', state.version.software || '–'],
      ['Protocol', state.statusSeen ? g[state.gen] : 'waiting for status…'],
    ];
    kv.replaceChildren(...rows.flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val)]));
  });

  // --- installer
  const editCb = bindCheckbox(() => state.factory.edit, (on) => {
    if (on && !confirm('Allow changes to installer settings?\n\nThese describe how the box is wired into your car. Note down / copy the current values first (see “Backup”).')) { refresh(); return; }
    set({ factory: { ...state.factory, edit: on } });
  });
  const enterBtn = h('button', { class: 'btn primary', type: 'button', onclick: factoryEnter }, 'Read installer settings');
  const exitBtn = h('button', { class: 'btn', type: 'button', onclick: factoryExit }, 'Leave installer mode');
  const statusLine = h('p', { class: 'hint' });
  const factoryBody = h('div');
  bind(() => {
    enterBtn.hidden = state.factory.active;
    exitBtn.hidden = !state.factory.active;
    factoryBody.hidden = !state.factory.active;
    statusLine.textContent = state.factory.active ? 'Installer mode is on (the official app does the same when you open Factory Setting). It ends when you leave this tab.' : 'Read-only until you tick “Allow changes”.';
  });

  const dialSummary = h('p', { class: 'hint' });
  bind(() => {
    const d = state.factory.dial;
    dialSummary.textContent = d ? `Current: model switches ON = ${onList(d.model)}; function switches ON = ${onList(d.function)}  (${bitStr(d.model)} / ${bitStr(d.function)})` : 'Not read yet.';
  });
  const writeDialBtn = h('button', {
    class: 'btn primary block', type: 'button',
    onclick: () => {
      const a = state.factory.dial, d = state.factory.draftDial;
      if (bitStr(a.model) === bitStr(d.model) && bitStr(a.function) === bitStr(d.function)) { toast('Nothing changed'); return; }
      if (!confirm(`Change the dial?\n\nModel:    ${bitStr(a.model)} → ${bitStr(d.model)}\nFunction: ${bitStr(a.function)} → ${bitStr(d.function)}\n\nWrong values can stop car integration (doors, turn signals, …) from working until set back.`)) return;
      send(a.bits9 ? Cmd.dial9(d.model, d.function) : Cmd.dial(d.model, d.function));
      set({ factory: { ...state.factory, dial: { ...a, model: [...d.model], function: [...d.function] } } });
    },
  }, 'Write dial');
  bind(() => { writeDialBtn.hidden = !state.factory.edit || !state.factory.draftDial; });

  const backupPre = h('pre', { class: 'log', style: { 'max-height': '160px' } });
  bind(() => {
    const f = state.factory;
    const b = {
      saved: new Date().toISOString().slice(0, 10), device: link.name, version: state.version,
      dial: f.dial ? { model: bitStr(f.dial.model), function: bitStr(f.dial.function), bits9: f.dial.bits9 } : null,
      lamps: f.lamps ? Object.fromEntries(Object.entries(f.lamps).filter(([k]) => !['raw', 'bytes', 'op', 'type'].includes(k))) : null,
      lightParameter: f.result?.lightParameter ?? null,
    };
    backupPre.textContent = JSON.stringify(b, null, 1);
  });

  const swapStep = (step, label, gated) => {
    const b = h('button', { class: 'btn', type: 'button', onclick: () => send(Cmd.doorSwap(step)) }, label);
    if (gated) bind(() => { b.disabled = !state.factory.edit; });
    return b;
  };

  factoryBody.append(
    h('h3', {}, 'Dial (virtual DIP switches)'),
    h('p', { class: 'hint' }, 'These are switches stored in the box. The firmware decides what they mean, and neither the app nor the vendor documents it. Most likely the ', h('b', {}, 'Model'), ' dial picks the car profile (which car’s CAN signals to read and how the strips are laid out), and the ', h('b', {}, 'Function'), ' dial turns options on or off. Leave them as the installer set them unless you have the manual.'),
    h('div', { class: 'hint' }, 'Model'), bitsRow('model'),
    h('div', { class: 'hint' }, 'Function'), bitsRow('function'),
    dialSummary, writeDialBtn,
    h('h3', {}, 'Light bar layout'),
    h('p', { class: 'hint' }, 'How many LEDs each strip has and which end the cable enters. Wrong values make flowing effects run backwards or stop early.'),
    ...lampEditor(),
    h('h3', {}, 'Test'),
    h('div', { class: 'seg', style: { '--cols': '2' } },
      h('button', { class: 'btn', type: 'button', onclick: () => send(Cmd.testDisplay(true)) }, 'Start test'),
      h('button', { class: 'btn', type: 'button', onclick: () => send(Cmd.testDisplay(false)) }, 'Stop test')),
    h('p', { class: 'hint' }, 'Light bars should flow clockwise; door RGB lights flash: left front red, right front green, left rear blue, right rear pink.'),
    h('h3', {}, 'Door light order'),
    h('p', { class: 'hint' }, 'If the door colours in the test are in the wrong place: Activate twice (lights flash), Swap until correct, then Confirm to save.'),
    h('div', { class: 'seg', style: { '--cols': '4' } }, swapStep('activate', 'Activate'), swapStep('swap', 'Swap'), swapStep('reset', 'Reset', true), swapStep('confirm', 'Confirm', true)),
    h('h3', {}, 'Backup of current values'),
    backupPre,
    h('p', { class: 'hint' }, 'Screenshot this before changing anything.'),
    h('label', { class: 'check', style: { 'margin-top': '8px' } }, editCb, 'Allow changes (I have a backup)'),
  );

  const installer = detailsCard('Installer settings (factory menu)',
    h('div', { class: 'banner warn' }, 'This is the vendor’s hidden menu (PIN 1688). Reading is safe. Firmware update, key learning, parameter/customer-code import and original-light flashing are deliberately left out of this app.'),
    h('div', { class: 'row' }, enterBtn, exitBtn), statusLine, factoryBody);
  installer.addEventListener('toggle', () => { if (!installer.open) factoryExit(); });

  // --- firmware file name (read-only first step of the vendor update)
  const fwBtn = h('button', { class: 'btn primary', type: 'button', onclick: readFirmwareName }, 'Read firmware file name');
  const fwOut = h('div');
  bind(() => {
    const s = state.fwName;
    fwBtn.disabled = !state.connected || link.otaLock || OTA_ACTIVE.includes(state.ota.phase) || s.status === 'waiting';
    fwBtn.textContent = s.status === 'waiting' ? 'Waiting for reply…' : 'Read firmware file name';
    if (s.status === 'done') {
      fwOut.replaceChildren(
        h('dl', { class: 'kv', style: { 'margin-top': '12px' } },
          h('dt', {}, 'File name'), h('dd', {}, s.name || '(empty)'),
          h('dt', {}, 'Raw reply'), h('dd', {}, `<${s.raw}>`),
          h('dt', {}, 'Software'), h('dd', {}, state.version.software || '–'),
          h('dt', {}, 'Car model'), h('dd', {}, state.version.carModel || '–')),
        h('div', { class: 'banner warn' }, 'Done. Switch the ignition off and let the box go to sleep before driving. That clears its “update may follow” wait.'),
        h('button', {
          class: 'btn small', type: 'button',
          onclick: () => copyText(JSON.stringify({ fileName: s.name, raw: `<${s.raw}>`, version: state.version, device: link.name, at: s.at?.toISOString() }, null, 1)),
        }, 'Copy result'));
    } else if (s.status === 'timeout') {
      fwOut.replaceChildren(h('p', { class: 'hint' }, 'No reply within 3 seconds. The box may use a different update command. Copy the Bluetooth log and share it. Switch the ignition off and on before trying again.'));
    } else if (s.status === 'unsupported') {
      fwOut.replaceChildren(h('p', { class: 'hint' }, 'The box answered “not supported”. Switch the ignition off and on before driving.'));
    } else {
      fwOut.replaceChildren();
    }
  });
  const fwCard = detailsCard('Firmware file name',
    h('p', { class: 'hint' }, 'Reads the name of the firmware file this controller uses, so it can be downloaded and studied on a computer. Read-only: the app sends only the first step of the vendor update (0DBB44). It never sends the step that starts an update.'),
    h('p', { class: 'hint' }, 'During update recovery this standalone query is locked. Use the firmware update card to retry.'), fwBtn, fwOut);

  // --- firmware update (OTA)
  const otaInput = h('input', { type: 'file', accept: '.bin,application/octet-stream', class: 'input', onchange: () => { if (otaInput.files?.[0]) otaLoadFile(otaInput.files[0]); } });
  const otaFileInfo = h('div');
  const otaAck = bindCheckbox(() => state.ota.ack, (v) => otaSet({ ack: v }));
  const otaAckUnknown = bindCheckbox(() => state.ota.ackUnknown, (v) => otaSet({ ackUnknown: v }));
  const otaAckUnknownRow = h('label', { class: 'check' }, otaAckUnknown, 'This is NOT a known vendor file. I accept that the box may reject it or stay in update mode until a valid file is sent.');
  const otaConfirm = h('input', { type: 'text', class: 'input', placeholder: 'type UPDATE', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, oninput: () => refresh() });
  const otaPieceSel = h('select', { class: 'input', onchange: () => otaSet({ pieceMode: otaPieceSel.value }) },
    h('option', { value: '20' }, '20-byte pieces (tested on this controller)'),
    h('option', { value: '100' }, '100-byte pieces'),
    h('option', { value: 'auto' }, 'Whole 200-byte blocks'));
  const otaStartBtn = h('button', { class: 'btn danger block', type: 'button', onclick: otaBegin }, 'Start firmware update');
  const otaStopBtn = h('button', { class: 'btn block', type: 'button', onclick: otaStopAndUnlock }, 'Stop and unlock normal commands');
  const otaWaitBtn = h('button', { class: 'btn block', type: 'button', onclick: otaWaitForBootloader }, 'Wait for the box (<14>) and restart from block 1');
  const otaRetryBtn = h('button', { class: 'btn primary block', type: 'button', onclick: otaRetry }, 'Retry from the start (after power-cycling the box)');
  const otaIosWarn = h('div', { class: 'banner warn' },
    h('b', {}, 'You are on an iPhone/iPad. '),
    'The vendor’s advice for failed updates is “just change your phone”: use an Android phone with Chrome for the firmware update. ',
    'iOS pauses this page as soon as Bluefy is not in front, and its Bluetooth packet size is unknown. If you continue here anyway, keep the screen on and Bluefy in front until it finishes.');
  const otaProgress = h('progress', { max: '1', value: '0', style: { width: '100%', height: '14px' } });
  const otaMsg = h('p', { class: 'hint' });
  const otaSetup = h('div');
  bind(() => {
    const o = state.ota;
    const c = o.check;
    otaFileInfo.replaceChildren();
    if (c) {
      const t = c.info.text || {};
      otaFileInfo.append(
        h('dl', { class: 'kv', style: { 'margin-top': '10px' } },
          h('dt', {}, 'File'), h('dd', {}, `${o.fileName} · ${c.info.size.toLocaleString()} bytes · ${o.total} blocks`),
          h('dt', {}, 'Vendor file'), h('dd', {}, o.known ? `✓ ${o.known}` : '✗ not a known vendor original'),
          h('dt', {}, 'Header'), h('dd', {}, `${t.bin || '?'} · ${t.carname || '?'} · ${t.mcu || '?'}`),
          h('dt', {}, 'Image'), h('dd', {}, `${c.info.build || '?'} · reports itself as ${c.info.embeddedName || '?'}`),
          h('dt', {}, 'SHA-256'), h('dd', { style: { 'word-break': 'break-all' } }, o.sha)),
        ...c.errors.map((e) => h('div', { class: 'banner warn' }, '✗ ' + e)),
        ...c.warnings.map((w) => h('p', { class: 'hint' }, '⚠ ' + w)));
    }
    const running = OTA_ACTIVE.includes(o.phase);
    otaIosWarn.hidden = !isAppleMobile();
    const typed = otaConfirm.value.trim().toUpperCase() === 'UPDATE';
    otaAckUnknownRow.hidden = !c || !!o.known;
    otaSetup.hidden = running || o.phase === 'stalled';
    otaInput.disabled = running;
    otaPieceSel.value = o.pieceMode;
    otaPieceSel.disabled = running;
    otaStartBtn.disabled = !c?.ok || !o.ack || (!o.known && !o.ackUnknown) || !typed || !link.connected || running;
    otaStartBtn.textContent = link.otaLock ? 'Retry firmware update from the start' : 'Start firmware update';
    otaStopBtn.hidden = !(running || o.phase === 'stalled' || link.otaLock);
    otaWaitBtn.hidden = o.phase !== 'stalled';
    otaWaitBtn.disabled = !link.connected || !c?.ok;
    otaRetryBtn.hidden = o.phase !== 'stalled';
    otaRetryBtn.disabled = !link.connected || !c?.ok;
    otaProgress.hidden = !(running || ['stalled', 'done'].includes(o.phase));
    otaProgress.max = String(Math.max(1, o.total));
    otaProgress.value = String(o.phase === 'done' ? o.total : o.block);
    const p = o.progress;
    otaMsg.textContent = (o.message || '') + (p.currentBlock ? ` Block ${p.currentBlock}/${o.total}; ${p.writtenBlocks} blocks written, ${p.acknowledgedBlocks} controller ACKs; ${Math.round((p.elapsedMs || 0) / 1000)} s elapsed.` : '');
    otaMsg.className = o.phase === 'failed' || o.phase === 'stalled' ? 'banner warn' : 'hint';
  });
  otaSetup.append(
    h('label', { class: 'check', style: { 'margin-top': '10px' } }, otaAck,
      'Car parked, controller power maintained throughout the update, phone charged and next to the box. I will keep this page open in the foreground until it finishes.'),
    otaAckUnknownRow,
    h('div', { class: 'field' }, h('label', {}, 'Type UPDATE to enable the button'), otaConfirm),
    otaStartBtn);
  otaCard = detailsCard('Firmware update (experimental)',
    h('div', { class: 'banner warn' },
      'This writes new firmware into the controller, using the same procedure as the vendor app (reverse engineered; their bootloader could not be inspected). ',
      'A failed or interrupted update can leave the box waiting in update mode. Only use a file downloaded from the vendor for your box’s exact file name.'),
    otaIosWarn,
    h('p', { class: 'hint' }, 'Ignition on is a precaution against the controller losing power, not a requirement of the update command. Ignition-off recovery has worked on the tested installation. The radio being on alone does not confirm that the lighting controller will remain powered; this depends on its wiring and sleep behavior.'),
    h('p', { class: 'hint' }, h('b', {}, 'Before you start: '), 'the update resets your light settings (colours, effects, light bar options). Take screenshots of the Car and Light tabs, and of the installer “Backup” box, so you can set everything up again afterwards.'),
    h('p', { class: 'hint' }, '1. Get the file (e.g. File122.bin) onto this phone. The app cannot download it: the vendor server blocks browsers, and the app makes no network requests. 2. Pick it below; the app checks it. 3. The app asks the box for its file name and refuses if it does not match the file.'),
    otaInput, otaFileInfo, h('div', { class: 'field' }, h('label', {}, 'Block writes'), otaPieceSel), otaSetup, otaProgress, otaMsg, otaRetryBtn, otaWaitBtn, otaStopBtn,
    h('details', { style: { 'margin-top': '8px' } }, h('summary', {}, 'If it stops'),
      h('p', { class: 'hint' }, 'If no <14> arrives and the block count stays at zero, update mode was not confirmed. Block piece size has not been used yet. Save the report before retrying. A size or bootloader limitation is not established by this timeout; comparing a previously working image with this same app can help isolate it.'),
      h('p', { class: 'hint' }, 'For an interrupted block transfer, the vendor’s recovery procedure is to switch the car off, cut the control box’s main power for about a minute (power connector or its fuse), reconnect power, reconnect in this app, and tap “Retry from the start”. The app asks for the filename, then requests update mode again. Silence alone does not establish that the bootloader is running. Copy the Bluetooth log and keep it.'),
      h('p', { class: 'hint' }, '“Wait for the box” only listens for the box asking for block 1 (<14>), without sending anything.')));

  // --- log + console
  logPre = h('pre', { class: 'log' });
  const storageStatus = h('p', { class: 'hint' });
  bind(() => { storageStatus.textContent = diagnostics.persistent === false ? 'Browser storage is unavailable. Copy or save the report before closing this page.' : ''; });
  logCard = detailsCard('Bluetooth log',
    h('p', { class: 'hint' }, 'Available while disconnected. The latest 400 entries and update summary are saved on this phone when browser storage is available. Save a report before clearing browser data.'), storageStatus, logPre,
    h('div', { class: 'row', style: { 'margin-top': '8px' } },
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { diagnostics.clear(); renderLog(); } }, 'Clear'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => copyText(diagnostics.text()) }, 'Copy'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: saveDiagnosticReport }, 'Save report')));
  logCard.addEventListener('toggle', renderLog);

  const raw = h('input', { type: 'text', class: 'input', placeholder: 'e.g. 0701', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false });
  const sendRaw = () => {
    const p = raw.value.trim().replace(/^<|>$/g, '').toUpperCase();
    if (!/^[0-9A-F]{2,40}$/.test(p)) { toast('Hex only, e.g. 0701'); return; }
    if (BLOCKED_PREFIXES.some((b) => p.startsWith(b))) { toast('Blocked: firmware/flash/import command'); return; }
    send(p);
  };
  const consoleCard = detailsCard('Raw command console',
    h('p', { class: 'hint' }, 'Sends <payload> exactly like the official app’s debug screen (PIN 6666). Firmware-update and import commands are blocked.'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, raw), h('button', { class: 'btn primary', type: 'button', onclick: sendRaw }, 'Send')));

  deviceTools = h('div', {}, otaCard, logCard);
  offlineTools = h('div', { id: 'offline-tools' });
  $('#view-connect').append(offlineTools);
  v.append(
    card('Controller', null, kv,
      h('div', { class: 'row', style: { 'margin-top': '12px' } },
        h('button', { class: 'btn', type: 'button', onclick: () => send(Cmd.hello()) }, 'Refresh state'),
        h('button', { class: 'btn danger', type: 'button', onclick: async () => { factoryExit(); await new Promise((r) => setTimeout(r, 150)); link.disconnect(); } }, 'Disconnect'))),
    installer, fwCard, buildDoorEffects(), deviceTools, consoleCard,
    card('About', null, h('p', { class: 'hint', style: { margin: 0 } },
      'Independent controller built from a protocol analysis of the vendor app. It makes no network requests and saves scenes, connection preferences and recent Bluetooth diagnostics on this phone. Not affiliated with the hardware vendor.')),
  );
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy not allowed here — select the text instead'); }
}

function saveDiagnosticReport() {
  const report = diagnostics.report({ app: 'ambient-lights-uploader-2', userAgent: navigator.userAgent,
    visibility: document.visibilityState, connected: link.connected, device: link.name,
    version: state.version, doorEffects: state.doorFx.replies, writeMode: lastTransport?.writeMode || 'unknown', storageAvailable: !!diagnostics.persistent });
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const anchor = h('a', { href: url, download: `ambient-lights-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json` });
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// shell: tabs + connection pill
// ---------------------------------------------------------------------------

const TABS = ['rgb', 'flow', 'light', 'car', 'device'];

function showTab(tab) {
  if (state.tab === 'device' && tab !== 'device') factoryExit();
  state.tab = tab;
  store.set('tab', tab);
  renderShell();
  window.scrollTo({ top: 0 });
}

function renderShell() {
  const connected = state.connected;
  if (offlineTools && deviceTools) {
    const host = connected ? deviceTools : offlineTools;
    for (const card of [otaCard, logCard]) if (card.parentNode !== host) host.append(card);
  }
  $('#view-connect').hidden = connected;
  for (const t of TABS) $(`#view-${t}`).hidden = !connected || state.tab !== t;
  for (const b of document.querySelectorAll('#tabbar button')) {
    b.classList.toggle('on', connected && b.dataset.tab === state.tab);
    b.disabled = !connected;
  }
  $('#conn-dot').className = 'dot' + (connected ? ' on' : state.connecting ? ' busy' : '');
  $('#conn-label').textContent = connected ? link.name : state.connecting ? 'Connecting…' : 'Not connected';
}

function init() {
  const saved = diagnostics.lastUpdate;
  if (saved && (saved.locked || ['retrying', 'entering', 'sending', 'verifying', 'waiting', 'stalled'].includes(saved.phase))) {
    link.otaLock = true;
    otaSet({ phase: 'stalled', message: 'A previous update was interrupted or unverified. Re-select the firmware file, reconnect and explicitly retry from the start. The saved report is available below.',
      fileName: saved.fileName || '', selectedBytes: saved.bytes || 0, sha: saved.sha256 || '',
      expectedSoftware: saved.expectedSoftware || '', oldSoftware: saved.oldSoftware || '', entry: saved.entry || {},
      total: saved.totalBlocks || saved.progress?.totalBlocks || 0, progress: saved.progress || {} });
  }
  buildConnect();
  buildRgb();
  buildFlow();
  buildLight();
  buildCar();
  buildDevice();
  state.tab = TABS.includes(store.get('tab', 'rgb')) ? store.get('tab', 'rgb') : 'rgb';
  for (const b of document.querySelectorAll('#tabbar button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  // leave installer mode if the page is hidden/closed
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) factoryExit();
    if (OTA_ACTIVE.includes(state.ota.phase) || state.ota.phase === 'stalled') {
      otaLog(`page visibility changed to ${document.visibilityState}`);
      if (!document.hidden && state.ota.phase !== 'stalled') otaAcquireWake();
    }
  });
  window.addEventListener('pagehide', () => { factoryExit(); if (OTA_ACTIVE.includes(state.ota.phase)) otaLog('page hidden/closed during update; automatic resume is disabled'); });
  if (diagnostics.entries.length) addLog('dim', 'Page opened; previous diagnostics restored. No update is resumed automatically.');
  renderShell();
  if (new URLSearchParams(location.search).has('demo')) connect({ demo: true });
}

init();
