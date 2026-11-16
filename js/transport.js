// Bluetooth link + a simulated controller for testing without the car.
import { UUID, encodeFrame, FrameBuffer, hexToBytes, bytesToHex } from './protocol.js';

/**
 * Serialised write queue on top of a raw transport.
 * - one GATT write at a time (iOS/Bluefy reject overlapping writes)
 * - commands with the same `key` coalesce: only the newest value is sent
 *   (so dragging a colour/brightness slider can't flood the controller)
 */
export class Link extends EventTarget {
  constructor() {
    super();
    this.transport = null;
    this.queue = [];
    this.busy = false;
    this.gapMs = 35;
    this.frames = new FrameBuffer();
  }

  get connected() { return !!this.transport?.connected; }
  get name() { return this.transport?.name || ''; }

  async connect(transport) {
    await this.disconnect();
    this.transport = transport;
    this.frames = new FrameBuffer();
    transport.onData = (bytes) => {
      this.emit('rx-raw', { text: String.fromCharCode(...bytes) });
      for (const payload of this.frames.push(bytes)) this.emit('frame', { payload });
    };
    transport.onDisconnect = () => { this.queue = []; this.emit('state', { connected: false }); };
    await transport.connect();
    this.emit('state', { connected: true, name: transport.name });
  }

  async disconnect() {
    this.queue = [];
    if (this.transport) {
      const t = this.transport;
      this.transport = null;
      try { await t.disconnect(); } catch { /* ignore */ }
      this.emit('state', { connected: false });
    }
  }

  /** Queue a command payload (hex string without < >). */
  send(payload, { key } = {}) {
    if (!this.connected) return false;
    if (key) {
      const pending = this.queue.find((q) => q.key === key);
      if (pending) { pending.payload = payload; return true; }
    }
    this.queue.push({ payload, key });
    this.pump();
    return true;
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && this.connected) {
        const { payload } = this.queue.shift();
        this.emit('tx', { payload });
        try {
          await this.transport.write(encodeFrame(payload));
        } catch (e) {
          this.emit('error', { message: `Write failed: ${e.message || e}` });
        }
        await new Promise((r) => setTimeout(r, this.gapMs));
      }
    } finally {
      this.busy = false;
    }
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

// ---------------------------------------------------------------------------
// Web Bluetooth (Chrome/Edge on desktop & Android, Bluefy on iPhone)
// ---------------------------------------------------------------------------

/** Full 128-bit form of a 16-bit Bluetooth UUID. Some iOS Web Bluetooth browsers (Bluefy) reject bare numbers. */
export const uuid128 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

/** Describe any thrown value (DOMException, Error, string, number…) for the diagnostics panel. */
export function describeError(e) {
  if (e == null) return String(e);
  if (typeof e === 'string') return e;
  if (typeof e !== 'object') return `bare ${typeof e} ${String(e)} (no error object; a native error code from the browser)`;
  const parts = [e.name, e.message, e.code !== undefined && e.code !== 0 ? `code ${e.code}` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
}

/** Error that remembers which connection step failed. */
export class ConnectError extends Error {
  constructor(step, cause, extra = '') {
    super(`${step}: ${describeError(cause)}`);
    this.name = cause?.name === 'NotFoundError' ? 'NotFoundError' : 'ConnectError';
    this.step = step;
    this.causeText = describeError(cause);
    this.extra = extra;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WebBluetoothTransport {
  static get available() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  constructor({ namePrefix = '', showAll = false, onStep = () => {} } = {}) {
    this.namePrefix = namePrefix.trim();
    this.showAll = showAll;
    this.onStep = onStep;
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this._onNotify = (e) => {
      const v = e.target.value;
      this.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    };
    this._onGone = () => this.onDisconnect();
  }

  get connected() { return !!this.device?.gatt?.connected; }
  get name() { return this.device?.name || 'Controller'; }

  async step(name, fn) {
    this.onStep(name);
    try { return await fn(); } catch (e) {
      if (e instanceof ConnectError) throw e;
      throw new ConnectError(name, e);
    }
  }

  async connect() {
    const service128 = uuid128(UUID.service);
    if (!this.device) {
      const optionalServices = [service128, ...UUID.advertised.map(uuid128)];
      const options = this.showAll
        ? { acceptAllDevices: true, optionalServices }
        : {
          filters: [
            ...(this.namePrefix ? [{ namePrefix: this.namePrefix }] : []),
            { services: [service128] },
            ...UUID.advertised.map((s) => ({ services: [uuid128(s)] })),
          ],
          optionalServices,
        };
      this.device = await this.step('choose device', () => navigator.bluetooth.requestDevice(options));
      this.device.addEventListener('gattserverdisconnected', this._onGone);
    }

    // iOS frequently fails the first GATT connect to these JDY-style modules: retry a few times
    const server = await this.step('connect (GATT)', async () => {
      let last;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { return await this.device.gatt.connect(); } catch (e) {
          last = e;
          this.onStep(`connect (GATT) attempt ${attempt} failed: ${describeError(e)}`);
          try { this.device.gatt.disconnect(); } catch { /* ignore */ }
          await sleep(600 * attempt);
        }
      }
      throw last;
    });

    let service;
    try {
      service = await this.step('open service FFE0', () => server.getPrimaryService(service128));
    } catch (e) {
      throw new ConnectError(e.step, e.causeText, await this.listServices(server));
    }
    try {
      this.notifyChar = await this.step('find notify FFE1', () => service.getCharacteristic(uuid128(UUID.notify)));
      this.writeChar = await this.step('find write FFE2', () => service.getCharacteristic(uuid128(UUID.write)));
    } catch (e) {
      throw new ConnectError(e.step, e.causeText, await this.listCharacteristics(service));
    }
    this.notifyChar.addEventListener('characteristicvaluechanged', this._onNotify);
    await this.step('start notifications', () => this.notifyChar.startNotifications());
  }

  async listServices(server) {
    try {
      const all = await server.getPrimaryServices();
      return 'services on the box: ' + (all.map((s) => s.uuid).join(', ') || 'none visible');
    } catch (e) { return `could not list services (${describeError(e)})`; }
  }

  async listCharacteristics(service) {
    try {
      const all = await service.getCharacteristics();
      const props = (p) => Object.entries({ read: p.read, write: p.write, writeNR: p.writeWithoutResponse, notify: p.notify, indicate: p.indicate }).filter(([, v]) => v).map(([k]) => k).join('/');
      return 'characteristics in FFE0: ' + (all.map((c) => `${c.uuid} [${props(c.properties || {})}]`).join(', ') || 'none visible');
    } catch (e) { return `could not list characteristics (${describeError(e)})`; }
  }

  async write(bytes) {
    const c = this.writeChar;
    if (!c) throw new Error('not connected');
    if (c.properties?.writeWithoutResponse && c.writeValueWithoutResponse) return c.writeValueWithoutResponse(bytes);
    if (c.writeValueWithResponse) return c.writeValueWithResponse(bytes);
    return c.writeValue(bytes);
  }

  async disconnect() {
    try { this.notifyChar?.removeEventListener('characteristicvaluechanged', this._onNotify); } catch { /* ignore */ }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Demo controller – behaves like your box (values from your screenshots).
// Lets you try the app in any browser. Real-box behaviour after commands is
// unknown; the demo answers every change with a fresh status frame.
// ---------------------------------------------------------------------------

const bcd = (n, digits = 4) => String(n).padStart(digits, '0');
const h2 = (n) => (n & 0xff).toString(16).padStart(2, '0').toUpperCase();

export class DemoTransport {
  constructor() {
    this.connected = false;
    this.name = 'ATW-DEMO (simulated)';
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.factory = false;
    this.s = {
      rgbMode: 0, flowMode: 0x18, power: 1, c1: [255, 0, 255], c2: [139, 0, 255],
      b1: 6, b2: 6, mic: 0, flowSpeed: 3, flowRev: 0, bAll: 6, rgbSpeed: 9, forcePhone: 0,
      welcome: 1, door: 1, radar: 0, speed: 0, steering: 0, air: 0, night: 1, frontBack: 0, welcomeMode: 5, welcomeColor: 0x16, b11: 0, blind: 2,
      rgbSlots: [0, 15, 15, 15, 15, 15, 15, 15], rgbCustom: 0, flowSlots: [15, 15, 15, 15, 15, 15, 15, 15], flowCustom: 0, len: 3, interval: 5, toggle: 0,
      dialModel: '10110110', dialFunction: '00000001',
      lamps: { driver: 20, driverDir: 1, passenger: 114, passengerDir: 0, front: 60, rear: 65, lf: 1, lr: 1, rf: 1, rr: 1 },
    };
  }

  async connect() { await wait(400); this.connected = true; }
  async disconnect() { this.connected = false; this.onDisconnect(); }

  async write(bytes) {
    if (!this.connected) throw new Error('not connected');
    const text = String.fromCharCode(...bytes);
    const payload = text.replace(/^<|>$/g, '');
    await wait(5);
    setTimeout(() => this.handle(payload), 60);
  }

  reply(hex) {
    // the real box sometimes splits frames over several notifications – mimic that
    const text = `<${hex}>`;
    for (let i = 0; i < text.length; i += 20) {
      const chunk = text.slice(i, i + 20);
      this.onData(Uint8Array.from(chunk, (c) => c.charCodeAt(0)));
    }
  }

  statusHex() {
    const s = this.s;
    return bytesToHex([0x4e, s.rgbMode, s.flowMode, s.power, ...s.c1, ...s.c2, s.b1, s.b2, s.mic, s.flowSpeed, s.flowRev, s.bAll, s.rgbSpeed, s.forcePhone]);
  }
  settingsHex() {
    const s = this.s;
    return bytesToHex([0x26, s.welcome, s.door, s.radar, s.speed, s.steering, s.air, s.night, s.frontBack, s.welcomeMode, s.welcomeColor, s.b11, 0, s.blind]);
  }
  colorsHex() {
    const s = this.s;
    const pack = (a) => [0, 2, 4, 6].map((i) => (a[i] << 4) | a[i + 1]);
    return bytesToHex([0x27, ...pack(s.rgbSlots), s.rgbCustom, ...pack(s.flowSlots), s.flowCustom, s.len, s.interval, 0, s.rgbSpeed, s.toggle]);
  }
  versionHex() {
    return '13' + bytesToHex(Array.from('V6.303229-B6 260506-006', (c) => c.charCodeAt(0)));
  }
  lampsHex() {
    const l = this.s.lamps;
    return '4F000000' + bcd(l.driver) + h2(l.driverDir) + bcd(l.passenger) + h2(l.passengerDir) + bcd(l.front) + h2(l.lf) + bcd(l.rear) + h2(l.lr) + h2(l.rf) + h2(l.rr);
  }

  handle(p) {
    const s = this.s;
    const v = (from, len = 2) => parseInt(p.substr(from, len), 16);
    const op = p.slice(0, 2).toUpperCase();
    const sub = p.slice(0, 4).toUpperCase();
    let changed = true;

    if (sub === '0A01') {
      this.reply(this.statusHex()); this.reply(this.settingsHex()); this.reply(this.colorsHex()); this.reply(this.versionHex());
      return;
    }
    // firmware-name query: the real box answers in plain ASCII, not hex (first step of the vendor update)
    if (p.toUpperCase() === '0DBB44') { this.reply('1501File000-DEMO.bin'); return; }
    if (sub === '2101') { this.factory = true; this.reply('23' + s.dialModel + s.dialFunction); this.reply(this.lampsHex()); this.reply('25000000012300'); return; }
    if (sub === '2100') { this.factory = false; return; }

    // unknown values for on/off settings: answer "not supported" like the real box does for unsupported features
    if (['30', '31', '32', '33', '34', '35', '44'].includes(op) && v(2) > 1) { this.reply('19'); return; }

    switch (op) {
      case '07': s.power = v(2); break;
      case '02': s.bAll = v(4); s.b1 = s.b2 = s.bAll; break;
      case '01': if (p[3] === '1') s.b1 = v(4); else s.b2 = v(4); break;
      case '06': s.c1 = s.c2 = [v(2), v(4), v(6)]; break;
      case '10': s.c1 = [v(2), v(4), v(6)]; break;
      case '09': s.c2 = [v(2), v(4), v(6)]; break;
      case '04': s.rgbMode = v(2); break;
      case '1E': s.flowMode = v(2); break;
      case '0B': s.flowSpeed = v(2); break;
      case '0C': s.flowRev = v(2); break;
      case '3E': s.rgbSpeed = v(2); break;
      case '51': s.forcePhone = v(2); break;
      case '14': s.frontBack = v(2); break;
      case '1A': s.night = v(2); break;
      case '30': s.welcome = v(2); break;
      case '31': s.door = v(2); break;
      case '32': s.radar = v(2); break;
      case '33': s.speed = v(2); break;
      case '34': s.steering = v(2); break;
      case '35': s.air = v(2); break;
      case '44': s.blind = v(2); break;
      case '39': s.welcomeMode = v(2); break;
      case '38': s.welcomeColor = 0x10 | (v(2) & 0x0f); break;
      case '2B': s.rgbCustom = v(2); break;
      case '3B': s.flowCustom = v(2); break;
      case '2A': s.rgbSlots = [...p.slice(2, 10)].map((c) => parseInt(c, 16)); break;
      case '3A': s.flowSlots = [...p.slice(2, 10)].map((c) => parseInt(c, 16)); break;
      case '3C': s.len = v(2); break;
      case '3D': s.interval = v(2); break;
      case '29': s.toggle = parseInt(p.slice(2), 10) - 1; break;
      case '59': case '5A': case '5B': case '5C': case '5D': this.reply('56000000000000'); changed = false; break; // pretend: no mirror module
      case '20': if (this.factory) { s.dialModel = p.slice(2, 10); s.dialFunction = p.slice(10, 18); this.reply('2E01'); } changed = false; break;
      case '4C': case '4D': changed = false; break;
      default: changed = false;
    }
    if (changed) {
      this.reply(this.statusHex());
      if (['30', '31', '32', '33', '34', '35', '44', '39', '38', '1A', '14'].includes(op)) this.reply(this.settingsHex());
      if (['2A', '2B', '3A', '3B', '3C', '3D', '29'].includes(op)) this.reply(this.colorsHex());
    }
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export { hexToBytes };
