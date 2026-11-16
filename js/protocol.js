// LOMO / lmyiot car ambient-light controller – BLE protocol.
// Reconstructed from the vendor Android app (com.lomo.ambientlight v1.81.3).
//
// Transport: service FFE0, write FFE2 (without response), notify FFE1.
// Framing:   every command is an ASCII hex string wrapped in '<' '>'.
//            e.g. command "0701" is sent as the 6 bytes  < 0 7 0 1 >
// Replies:   same framing on FFE1; the hex inside decodes to bytes, byte[0] = opcode.
//
// Pure module (no DOM / Bluetooth), so it can be unit-tested in Node.

export const UUID = {
  service: 0xffe0,
  notify: 0xffe1,
  write: 0xffe2,
  // services the vendor app scans for (advertised by the controller)
  advertised: [0xaf30, 0xfff0, 0xfee7],
};

// ---------- encoding helpers (mirror the vendor app exactly) ----------

/** String.format("%02x") – lowercase hex byte */
const hx = (n) => (n & 0xff).toString(16).padStart(2, '0');
/** String.format("%0Nd") – decimal digits, which end up as BCD on the wire */
const dd = (n, width = 2) => String(Math.max(0, Math.trunc(n))).padStart(width, '0');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));
const onOff = (on) => (on ? '01' : '00');
/** palette slot as written by the app: 0-9 digit, 10-15 lowercase hex */
const nib = (n) => clamp(n, 0, 15).toString(16);

export function encodeFrame(payload) {
  if (!/^[0-9A-Za-z]*$/.test(payload)) throw new Error(`Payload must be ASCII hex/alnum: ${payload}`);
  const text = `<${payload}>`;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

// ---------- palette (index -> RGB) shared by several commands ----------

export const PALETTE = [
  '#ff0000', '#ff4000', '#ffff00', '#00ff00', '#46ffff',
  '#0000ff', '#8b00ff', '#ff0020', '#ff00ff', '#ffffff',
  '#00ff80', '#51ffae', '#ff2c40', '#c1ff98', '#596eff',
];
export const PALETTE_EMPTY = 15;

// ---------- commands ----------

export const ZONE = { all: '06', zone1: '10', zone2: '09' };

export const Cmd = {
  hello: () => '0A01', // sent ~1 s after connecting; box answers with its full state

  // power & brightness
  power: (mode) => '070' + clamp(mode, 0, 2), // 0 off, 1 on, 2 auto (follow car)
  brightnessAll: (v) => '0200' + hx(clamp(v, 0, 9)),
  brightnessZone: (zone, v) => '010' + clamp(zone, 1, 2) + hx(clamp(v, 0, 9)),
  zoneLayout: (frontBack) => (frontBack ? '1401' : '1400'), // up/down vs front/back
  nightDim: (enabled, level) => '1A' + onOff(enabled) + dd(clamp(level, 0, 5)),
  controlMode: (forcePhone) => '51' + dd(forcePhone ? 1 : 0),

  // static colour
  color: (zone, r, g, b) => (ZONE[zone] || ZONE.all) + hx(r) + hx(g) + hx(b),

  // "RGB" effect modes (gen >= 1): 0x00 .. 0x14
  rgbMode: (code) => '04' + hx(clamp(code, 0, 0x14)).toUpperCase(),
  rgbModeLegacy: (code) => '08' + hx(code), // gen 0 boxes only
  rgbCustomEnable: (on) => (on ? '2B01' : '2B00'),
  rgbCustomTable: (slots) => '2A' + padSlots(slots).map(nib).join(''),
  rgbCustomClear: () => '2AFFFFFFFF',
  rgbCustomSpeed: (v) => '3E' + hx(clamp(v, 1, 10)),

  // "Symphony" / flowing light-bar effects
  flowMode: (code) => '1E' + hx(clamp(code, 0, 0x1e)).toUpperCase(),
  flowModeLegacy: (code) => '110' + clamp(code, 0, 5),
  flowSpeed: (v) => '0B' + hx(clamp(v, 1, 5)),
  flowDirection: (reverse) => (reverse ? '0C01' : '0C00'),
  flowEffectToggle: (n) => '29' + dd(clamp(n, 1, 6)),
  flowCommonEffect: (i) => '28' + hx(clamp(i, 0, 7)),
  flowCustomEnable: (on) => (on ? '3B01' : '3B00'),
  flowCustomTable: (slots) => '3A' + padSlots(slots).map(nib).join(''),
  flowCustomClear: () => '3AFFFFFFFF',
  flowCustomLength: (v) => '3C' + hx(clamp(v, 1, 10)),
  flowCustomInterval: (v) => '3D' + hx(clamp(v, 0, 9)),

  // car integration / settings
  micSensitivity: (v) => '0300' + hx(clamp(v, 0, 9)),
  soundSource: (carHorn) => (carHorn ? '1B01' : '1B00'),
  welcome: (on) => '30' + onOff(on),
  welcomeMode: (m) => '390' + clamp(m, 0, 5),
  welcomeColor: (index) => '38' + hx(clamp(index, 0, 14)),
  welcomeColorSyncRgb: () => '380F',
  activeDoor: (on) => '31' + onOff(on),
  activeRadar: (on) => '32' + onOff(on),
  activeSpeed: (on) => '33' + onOff(on),
  activeSteering: (on) => '34' + onOff(on),
  activeAirCon: (on) => '35' + onOff(on),
  activeBlindSpot: (on) => '44' + onOff(on),
  doorColor: (i) => '46' + hx(clamp(i, 0, 3)),
  turnColor: (i) => '45' + hx(clamp(i, 0, 3)),
  blindColor: (i) => '47' + hx(clamp(i, 0, 1)),
  mirrorLight: (mode) => '59' + hx(clamp(mode, 0, 2)),
  mirrorDelay: (event, seconds) => ({ unlock: '5A', door: '5B', turn: '5C', reverse: '5D' }[event]) + dd(clamp(seconds, 0, 60)),

  // installer / factory (only send while in factory mode)
  factoryEnter: () => '2101',
  factoryExit: () => '2100',
  dial: (modelBits, functionBits) => '20' + bits(modelBits, 8) + bits(functionBits, 8),
  dial9: (modelBits, functionBits) => '56' + bits(modelBits, 9) + '0' + bits(functionBits, 8),
  lampsDriver: (n) => '1C' + dd(clamp(n, 0, 200), 4),
  lampsPassenger: (n) => '0F' + dd(clamp(n, 0, 200), 4),
  lampsFrontDoors: (n) => '13' + dd(clamp(n, 0, 200), 4),
  lampsRearDoors: (n) => '1D' + dd(clamp(n, 0, 200), 4),
  dirDriver: (rightOut) => (rightOut ? '2C01' : '2C00'),
  dirPassenger: (rightOut) => (rightOut ? '2F01' : '2F00'),
  // per-door wiring direction (new layout): true = "Front Out"
  dirDoor: (door, frontOut) => ({ lf: '48', rf: '49', lr: '4A', rr: '4B' }[door]) + onOff(frontOut),
  testDisplay: (on) => (on ? '4C01' : '4C00'),
  doorSwap: (step) => '4D0055' + { swap: '01', reset: '03', activate: '00', confirm: '02' }[step],
};

function padSlots(slots) {
  const s = Array.from(slots || []).slice(0, 8);
  while (s.length < 8) s.push(PALETTE_EMPTY);
  return s;
}
function bits(arr, n) {
  const a = Array.from(arr || []).slice(0, n);
  while (a.length < n) a.push(false);
  return a.map((b) => (b ? '1' : '0')).join('');
}

/** Payloads this app refuses to send from the raw console (firmware update / unknown risky ops). */
export const BLOCKED_PREFIXES = ['0D', '0E', '41', '43', '40', '22'];

/** Firmware-update opcodes. The app's normal send path refuses them outright. */
export const OTA_PREFIXES = ['0D', '0E'];

/**
 * Asks the box for its firmware file name: the first step of the vendor update flow.
 * Firmware analysis (gen 0, see firmware/README.md): the box only replies `<15xx…name…>` (raw ASCII,
 * not hex) and sets a RAM flag meaning "expect 0E next". Nothing is written to flash. Only a following
 * `<0E…>` frame would arm the update and reset the box into its bootloader, and this app never sends one.
 * Sent through a dedicated, confirmed action only, never through `Cmd` or the raw console.
 */
export const FIRMWARE_NAME_QUERY = '0DBB44';

// ---------- firmware update (OTA) ----------
//
// Procedure, as implemented by the vendor app (FactoryActivity / WLSAPI, carLight 1.81.3):
//   1. <0DBB44>                      -> box replies <15xx…name…> (plain ASCII) or <1502> = "update not supported"
//   2. file = hex-decoded JSON "result" from the vendor server, sent byte-for-byte (header + XOR body, nothing decoded)
//   3. <0E%06d(file length)>         -> box stores length + flag 0x55AA44BB and resets into its bootloader
//                                       (box answers <1502> instead if the length equals the last update's length)
//   4. bootloader replies <14>       -> send block 0; every <16> -> next block
//      blocks = 200 raw bytes (last one shorter), one GATT write each, write-without-response, no framing/checksum
//   5. no completion message: the vendor app just closes its progress dialog after the last block.

export const OTA_BLOCK = 200;

/** `<0E%06d>`: the step that resets the box into its bootloader. Deliberately NOT part of `Cmd`. */
export function otaLengthPayload(length) {
  if (!Number.isInteger(length) || length <= 0 || length > 999999) throw new Error(`bad firmware length ${length}`);
  return '0E' + String(length).padStart(6, '0');
}

/** Split a firmware file into the 200-byte blocks the bootloader expects. */
export function otaBlocks(file, size = OTA_BLOCK) {
  const out = [];
  for (let i = 0; i < file.length; i += size) out.push(file.subarray(i, Math.min(file.length, i + size)));
  return out;
}

/** SHA-256 of vendor files we have checked byte-for-byte (see firmware/README.md). */
export const KNOWN_FIRMWARE = {
  '3e7821d56bc890b38a5fae0de27db4081ecde21400918b0572c993589bb99235': 'File122.bin · V6.30 · 2026-11-15 (vendor original, N32G452)',
  'cc8577815f8927849aec8a9e9dbeba123abbef8e53cee18752096d088381c7b3': 'File004.bin · V3.00 (vendor original from the APK, gen 0)',
  '242a1ffc98036a15676ede90df4b98444250310ba969a5bf21e60e60cf9a30d5': 'File006.bin · V3.20 (vendor original, gen 0)',
};

/**
 * Inspect a vendor firmware file (as downloaded) without changing it.
 * Layout: 256-byte header block (plain text + opaque 128-byte block), then XOR 0x33 body whose
 * last 256 image bytes come first, so the Cortex-M vector table sits at file offset 512.
 */
export function inspectFirmware(file) {
  const errors = [];
  const warnings = [];
  const info = { size: file?.length ?? 0 };
  if (!(file instanceof Uint8Array) || file.length < 4096) {
    errors.push('File is too small to be controller firmware.');
    return { ok: false, errors, warnings, info };
  }
  const magic = (file[0] << 24 | file[1] << 16 | file[2] << 8 | file[3]) >>> 0;
  if (magic !== 0xbeefe991) errors.push('Missing vendor header (expected BE EF E9 91 at the start).');

  // text header: "key: value\r\n" lines up to and including the "firmware:" line
  const head = String.fromCharCode(...file.subarray(4, 256));
  const fwLine = head.indexOf('firmware:');
  const textEnd = fwLine >= 0 ? head.indexOf('\r\n', fwLine) : -1;
  if (textEnd < 0) errors.push('Header text not found.');
  else {
    info.text = {};
    for (const line of head.slice(0, textEnd).split('\r\n')) {
      const m = line.match(/^([a-z]+):\s?(.*)$/);
      if (m) info.text[m[1]] = m[2];
    }
    info.textLength = 4 + textEnd + 2;
  }

  const dec = (i) => file[i] ^ 0x33;
  const u32 = (i) => (dec(i) | dec(i + 1) << 8 | dec(i + 2) << 16 | dec(i + 3) << 24) >>> 0;
  info.sp = u32(512);
  info.reset = u32(516);
  if ((info.sp & 0xfff00000) !== 0x20000000) errors.push(`Stack pointer ${hex32(info.sp)} is not in RAM: not a valid image.`);
  if ((info.reset & 1) !== 1 || info.reset < 0x08006000 || info.reset >= 0x08080000) errors.push(`Reset address ${hex32(info.reset)} is not inside the app area (0x08006000…): not a valid image.`);

  // the image carries its own "<15xx…name…>" reply string, and a "Vx.yy" + "yyyy-mm-dd-nnn" build tag
  const imageText = [];
  for (let i = 512; i < file.length; i++) imageText.push(String.fromCharCode(dec(i)));
  const s = imageText.join('');
  const nm = s.match(/<15[0-9A-F]{2}([A-Za-z0-9_.-]{3,40})>/);
  info.embeddedName = nm ? nm[1] : null;
  const ver = s.match(/V\d\.\d\d/);
  const date = s.match(/20\d\d-\d\d-\d\d-\d{3}/);
  info.build = [ver?.[0], date?.[0]].filter(Boolean).join(' ') || null;
  if (!info.embeddedName) warnings.push('The image does not contain its own file name, so it can’t be matched to the box.');
  return { ok: errors.length === 0, errors, warnings, info };
}

const hex32 = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0').toUpperCase();

// ---------- effect catalogues ----------

// "RGB" tab, gen >= 1 (names as in the official iOS app 2.6.6)
export const RGB_MODES = [
  { group: 'Single', items: [[0x00, 'Single'], [0x01, 'Colour water'], [0x02, 'Random']] },
  { group: 'Breathe', items: [[0x03, 'Single'], [0x04, 'Colour water'], [0x05, 'Random']] },
  { group: 'Gradient', items: [[0x06, 'Colour water'], [0x07, 'C Y Pe'], [0x08, 'R Y P'], [0x09, 'R B'], [0x0a, 'G B'], [0x0b, 'Random']] },
  { group: 'Strobe', items: [[0x0c, 'Colour water'], [0x0d, 'R G B'], [0x0e, 'C Y Pe']] },
  { group: 'Rhythm', items: [[0x0f, 'Colour water'], [0x10, 'R Y P'], [0x11, 'C Y Pe']] },
  { group: 'Motion', items: [[0x12, 'B R'], [0x13, 'R G'], [0x14, 'Bluish red']] },
];

// "Color" tab (flowing light bars). gen: minimum box generation / which variant shows it.
export function flowModesFor(gen) {
  const streamer = [[0x03, 'Streamer'], [0x04, 'Closing'], [0x05, 'Optical'], [0x06, 'Pull curtain'], [0x07, 'Closing 2']];
  streamer.push(gen >= 2 ? [0x19, 'Ping-pong'] : [0x08, 'Piled up']);
  streamer.push([0x09, 'CTL'], [0x0a, 'Magic'], [0x0b, 'Meteor']);
  const groups = [
    { group: 'Illusion', items: [[0x00, 'Illusion'], [0x01, 'Light'], [0x02, 'Breathe']] },
    { group: 'Streamer', items: streamer },
  ];
  if (gen === 2) groups.push({ group: 'Stack', items: [[0x08, 'Stack'], [0x1a, 'Stack 2'], [0x1b, 'Aggregate']] });
  if (gen === 3) groups.push({ group: 'Stack', items: [[0x08, 'Stack']] });
  groups.push(
    { group: 'Tailing', items: [[0x0c, 'Colour water'], [0x0d, 'Colourful'], [0x0e, 'Single']] },
    { group: 'Rhythm (music)', items: [[0x0f, 'Spectrum'], [0x10, 'Stretch'], [0x11, 'Optical'], [0x12, 'Snap-in'], [0x13, 'Beam'], [0x14, 'Single']] },
    { group: 'Motion', items: [[0x15, 'Stretch'], [0x16, 'Snap-in'], [0x17, 'R B']] },
    { group: 'Single', items: [[0x18, 'Sync']] },
  );
  if (gen === 3) groups.push({ group: 'Water ripple', items: [[0x1c, 'Follow'], [0x1d, 'Phantom'], [0x1e, 'Colourful']] });
  return groups;
}

export const COMMON_EFFECTS = ['Ambilight', 'R&B ambilight', 'R&P ambilight', 'Colourful tail', 'Colour water', 'Sport bar', 'Colourful music', 'Sport music'];
export const WELCOME_MODES = ['Center', 'Door', 'Door + colour', 'Four-door sync 1', 'Four-door sync 2', 'Four-door sync 3'];
export const WARN_COLORS = ['#e53528', '#ffd400', '#d936ee', '#0a8cff']; // red, yellow, purple, blue

// ---------- reply decoding ----------

/** Accumulates notification chunks and yields complete '<…>' payload strings. */
export class FrameBuffer {
  constructor() { this.buf = ''; }
  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : String.fromCharCode(...chunk);
    this.buf += text;
    const out = [];
    for (;;) {
      const start = this.buf.indexOf('<');
      if (start < 0) { this.buf = ''; break; }
      const end = this.buf.indexOf('>', start + 1);
      if (end < 0) { this.buf = this.buf.slice(start); break; }
      out.push(this.buf.slice(start + 1, end));
      this.buf = this.buf.slice(end + 1);
    }
    if (this.buf.length > 4096) this.buf = ''; // garbage protection
    return out;
  }
}

export function hexToBytes(hex) {
  if (hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

const ascii = (b, from, to) => String.fromCharCode(...b.slice(from, to)).replace(/\0/g, '').trim();
/** two bytes shown in hex and read as decimal by the vendor app = BCD */
const bcd2 = (b, i) => parseInt(hx(b[i]) + hx(b[i + 1]), 10);
const bcd1 = (v) => parseInt(hx(v), 10);
const rgb = (b, i) => '#' + hx(b[i]) + hx(b[i + 1]) + hx(b[i + 2]);
const nibbles = (b, from, count) => {
  const out = [];
  for (let i = 0; i < count; i++) out.push(b[from + i] >> 4, b[from + i] & 0xf);
  return out;
};
const at = (b, i) => (i < b.length ? b[i] : undefined);

const STATUS_GEN = { 0x12: 0, 0x1f: 1, 0x4e: 2, 0x5a: 3 };

/** Decode one frame payload (the text between '<' and '>'). Never throws. */
export function parseFrame(payload) {
  const base = { raw: payload };
  try {
    if (/^15/.test(payload)) return { ...base, type: 'firmwareName', name: payload.slice(4) };
    const b = hexToBytes(payload);
    if (!b || !b.length) return { ...base, type: 'text' };
    const op = b[0];
    const r = { ...base, op, bytes: b };

    if (op in STATUS_GEN && b.length >= 15) {
      return {
        ...r, type: 'status', gen: STATUS_GEN[op],
        rgbMode: b[1], flowMode: b[2], power: b[3],
        color1: rgb(b, 4), color2: rgb(b, 7),
        brightnessZone1: b[10], brightnessZone2: b[11], mic: b[12],
        flowSpeed: b[13], flowReverse: b[14] === 1,
        brightnessAll: at(b, 15), rgbCustomSpeed: at(b, 16), forcePhone: at(b, 17) === undefined ? undefined : at(b, 17) === 1,
      };
    }
    switch (op) {
      case 0x13:
        return { ...r, type: 'version', hardware: ascii(b, 1, 6), carModel: ascii(b, 6, 14), software: ascii(b, 14, 24) };
      case 0x26: {
        const tri = (v) => (v === 1 ? true : v === 0 ? false : null);
        const wc = at(b, 10);
        return {
          ...r, type: 'settings',
          welcome: tri(b[1]), door: tri(b[2]), radar: tri(b[3]), speed: tri(b[4]), steering: tri(b[5]), airCon: tri(b[6]),
          nightDim: at(b, 7) === 1, frontBack: at(b, 8) === 1, welcomeMode: at(b, 9),
          welcomeSyncSupported: wc !== undefined && (wc & 0xf0) === 0x10,
          welcomeColor: wc === undefined ? undefined : (wc & 0x0f) === 0x0f ? 'sync' : wc & 0x0f,
          byte11: at(b, 11), // vendor app reads this as BOTH sound source and night level (?)
          appType: at(b, 12), blindSpot: tri(at(b, 13)),
        };
      }
      case 0x27:
        return {
          ...r, type: 'colors',
          rgbSlots: b.length >= 5 ? nibbles(b, 1, 4) : undefined, rgbCustom: at(b, 5) === 1,
          flowSlots: b.length >= 10 ? nibbles(b, 6, 4) : undefined, flowCustom: at(b, 10) === 1,
          flowLength: at(b, 11), flowInterval: at(b, 12), commonEffect: at(b, 13),
          rgbCustomSpeed: at(b, 14), effectToggle: at(b, 15),
        };
      case 0x56:
        // delays are sent as decimal digits and come back the same way (BCD)
        if (b.length >= 6) return { ...r, type: 'mirror', mode: b[1], unlock: bcd1(b[2]), door: bcd1(b[3]), turn: bcd1(b[4]), reverse: bcd1(b[5]) };
        break;
      case 0x23: { // dial: hex chars after the opcode are '0'/'1'
        const s = payload.slice(2);
        return { ...r, type: 'dial', bits9: false, model: [...s.slice(0, 8)].map((c) => c === '1'), function: [...s.slice(8, 16)].map((c) => c === '1') };
      }
      case 0x57: {
        const s = payload.slice(2);
        return { ...r, type: 'dial', bits9: true, model: [...s.slice(0, 9)].map((c) => c === '1'), function: [...s.slice(10, 18)].map((c) => c === '1') };
      }
      case 0x24: case 0x4f: case 0x58: {
        if (b.length < 16) break;
        const out = {
          ...r, type: 'lampLayout', layout: op === 0x24 ? 'old' : 'perDoor',
          driver: bcd2(b, 4), driverRightOut: b[6] !== 0,
          passenger: bcd2(b, 7), passengerRightOut: b[9] !== 0,
          frontDoors: bcd2(b, 10), rearDoors: bcd2(b, 13),
        };
        if (op === 0x24) { out.frontFrontOut = b[12] === 1; out.rearFrontOut = b[15] === 1; }
        else if (b.length >= 18) {
          out.lfFrontOut = b[12] === 1; out.lrFrontOut = b[15] === 1; out.rfFrontOut = b[16] === 1; out.rrFrontOut = b[17] === 1;
        }
        if (op === 0x58 && b.length >= 22) { out.thirdRow = bcd2(b, 18); out.thirdLeftFront = b[20] === 1; out.thirdRightFront = b[21] === 1; }
        return out;
      }
      case 0x25:
        return { ...r, type: 'factoryResult', lightParameter: b.length >= 6 ? bcd2(b, 4) : undefined, soundSource: at(b, 6) === 0xff ? 'unsupported' : at(b, 6) === 1 ? 'carHorn' : 'mic' };
      case 0x19: return { ...r, type: 'notSupported' };
      case 0x2e: return { ...r, type: 'alert', code: b[1], message: ['Not supported', 'OK', 'Failed', 'Needs small-light wire or light sensor', 'Needs CAN or light sensor'][b[1]] || 'Unknown' };
      case 0x17: return { ...r, type: 'keyLearn', result: ['success', 'fail', 'not supported'][b[1]] };
      case 0x18: return { ...r, type: 'root', result: ['not supported', 'ok', 'fail'][b[1]] };
      case 0x14: return { ...r, type: 'otaStart' };
      case 0x16: return { ...r, type: 'otaNext' };
    }
    return { ...r, type: 'unknown' };
  } catch (e) {
    return { ...base, type: 'error', error: String(e) };
  }
}
