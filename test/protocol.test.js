import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Cmd, encodeFrame, parseFrame, FrameBuffer, OTA_PREFIXES, BLOCKED_PREFIXES, FIRMWARE_NAME_QUERY,
  inspectFirmware, otaBlocks, otaLengthPayload, KNOWN_FIRMWARE,
} from '../js/protocol.js';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Build a small fake vendor file with the real layout: 256-byte header block, then XOR 0x33 body (vector table at 512). */
function fakeFirmware({ name = 'File999.bin', size = 6000 } = {}) {
  const f = new Uint8Array(size);
  f.set([0xbe, 0xef, 0xe9, 0x91]);
  const text = 'bin: N32G452x_App.bin\r\ncarname: TEST\r\nmcu: DEV_MCU_ANT\r\ncustomer: Common\r\nsubcustomer: Common\r\nfirmware: Unknown\r\n';
  f.set(Buffer.from(text, 'latin1'), 4);
  for (let i = 4 + text.length; i < 512; i++) f[i] = (i * 73) & 0xff;
  const img = new Uint8Array(size - 512);
  new DataView(img.buffer).setUint32(0, 0x200083f0, true);
  new DataView(img.buffer).setUint32(4, 0x080061ad, true);
  img.set(Buffer.from(`xx<1501${name}>yyV6.30zz2026-11-15-007`, 'latin1'), 64);
  for (let i = 0; i < img.length; i++) f[512 + i] = img[i] ^ 0x33;
  return f;
}

test('firmware file inspector accepts the vendor layout and rejects garbage', () => {
  const ok = inspectFirmware(fakeFirmware());
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.equal(ok.info.text.bin, 'N32G452x_App.bin');
  assert.equal(ok.info.embeddedName, 'File999.bin');
  assert.equal(ok.info.build, 'V6.30 2026-11-15-007');
  assert.equal(ok.info.sp, 0x200083f0);
  const bad = fakeFirmware(); bad[0] = 0;
  assert.equal(inspectFirmware(bad).ok, false);
  const noVec = fakeFirmware(); noVec[512] ^= 0xff; noVec[515] ^= 0xff;
  assert.equal(inspectFirmware(noVec).ok, false);
  assert.equal(inspectFirmware(new Uint8Array(100)).ok, false);
});

test('real File122 (if present locally) passes the checks and is recognised', { skip: !existsSync('firmware/server_File122_V6.30_2026-11-15_original.bin') }, () => {
  const f = new Uint8Array(readFileSync('firmware/server_File122_V6.30_2026-11-15_original.bin'));
  const r = inspectFirmware(f);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.info.embeddedName, 'File122.bin');
  assert.equal(r.info.reset, 0x080061ad);
  assert.ok(KNOWN_FIRMWARE[createHash('sha256').update(f).digest('hex')]);
  assert.equal(otaLengthPayload(f.length), '0E231636');
  assert.equal(otaBlocks(f).length, 1159);
});

test('OTA payloads are built exactly like the vendor app', () => {
  assert.equal(otaLengthPayload(80044), '0E080044');
  assert.throws(() => otaLengthPayload(0));
  assert.throws(() => otaLengthPayload(1e6));
  const blocks = otaBlocks(new Uint8Array(450));
  assert.deepEqual(blocks.map((b) => b.length), [200, 200, 50]);
});

test('a running update locks out normal commands', async () => {
  const link = new Link();
  const sent = [];
  link.addEventListener('tx', (e) => sent.push(e.detail.payload));
  await link.connect(new DemoTransport());
  link.otaLock = true;
  assert.equal(link.send(Cmd.power(0)), false);
  assert.equal(link.send('0A01', { ota: true }), true);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sent, ['0A01']);
  await link.disconnect();
});

test('demo box interrupted mid-update stays silent until the update request is repeated', async () => {
  const frames = [];
  const link = new Link();
  link.gapMs = 1;
  link.addEventListener('frame', (e) => frames.push(parseFrame(e.detail.payload)));
  await link.connect(new DemoTransport());
  link.send(otaLengthPayload(5000), { ota: true });
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(frames.some((f) => f.type === 'otaStart'));
  await link.sendRaw(new Uint8Array(200));
  await link.disconnect(); // interrupted
  frames.length = 0;
  await link.connect(new DemoTransport()); // "power-cycled" box, still in update mode
  link.send(FIRMWARE_NAME_QUERY, { ota: true });
  link.send('0A01', { ota: true });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(frames, [], 'no answers while waiting in update mode');
  link.send(otaLengthPayload(5000), { ota: true });
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(frames.some((f) => f.type === 'otaStart'), 'asks for block 1 again');
  await link.disconnect();
  DemoTransport.stuckInUpdate = false;
});

test('full simulated update through the demo bootloader', async () => {
  const link = new Link();
  link.gapMs = 1;
  const frames = [];
  link.addEventListener('frame', (e) => frames.push(parseFrame(e.detail.payload)));
  const demo = new DemoTransport();
  await link.connect(demo);
  const file = fakeFirmware({ size: 1050 }); // 6 blocks: 5 x 200 + 50
  const blocks = otaBlocks(file);
  const waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const f = frames.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('timeout');
  };
  link.otaLock = true;
  link.send(otaLengthPayload(file.length), { ota: true });
  await waitFor((f) => f.type === 'otaStart');
  for (let i = 0; i < blocks.length; i++) {
    const before = frames.filter((f) => f.type === 'otaNext').length;
    assert.equal(await link.sendRaw(blocks[i], { pieceSize: i % 2 ? 20 : 0 }), true);
    if (i < blocks.length - 1) await waitFor(() => frames.filter((f) => f.type === 'otaNext').length > before);
  }
  link.send('0A01', { ota: true });
  const v = await waitFor((f) => f.type === 'version');
  assert.equal(v.software, '261115-007');
  // same length again -> the box refuses with <1502>
  frames.length = 0;
  link.send(otaLengthPayload(file.length), { ota: true });
  const r = await waitFor((f) => f.raw === '1502');
  assert.equal(r.type, 'firmwareName');
  await link.disconnect();
});
import { DemoTransport, Link, uuid128, describeError, ConnectError } from '../js/transport.js';

test('Bluetooth UUIDs are passed in full 128-bit form', () => {
  assert.equal(uuid128(0xffe0), '0000ffe0-0000-1000-8000-00805f9b34fb');
  assert.equal(uuid128(0xaf30), '0000af30-0000-1000-8000-00805f9b34fb');
});

test('connection errors stay readable whatever the browser throws', () => {
  assert.match(describeError(2), /bare number 2/);
  assert.equal(describeError('boom'), 'boom');
  assert.equal(describeError(Object.assign(new Error('GATT fail'), { name: 'NetworkError' })), 'NetworkError · GATT fail');
  const ce = new ConnectError('choose device', 2);
  assert.equal(ce.step, 'choose device');
  assert.match(ce.message, /choose device: bare number 2/);
  assert.equal(new ConnectError('choose device', Object.assign(new Error('x'), { name: 'NotFoundError' })).name, 'NotFoundError');
});

const ascii = (u8) => String.fromCharCode(...u8);

test('frames are ASCII wrapped in < >', () => {
  assert.equal(ascii(encodeFrame('0701')), '<0701>');
  assert.deepEqual([...encodeFrame('0A01')], [0x3c, 0x30, 0x41, 0x30, 0x31, 0x3e]);
});

test('commands match the vendor app byte-for-byte', () => {
  assert.equal(Cmd.hello(), '0A01');
  assert.equal(Cmd.power(2), '0702');
  assert.equal(Cmd.brightnessAll(6), '020006');
  assert.equal(Cmd.brightnessZone(2, 9), '010209');
  assert.equal(Cmd.color('all', 255, 64, 0), '06ff4000');
  assert.equal(Cmd.color('zone1', 1, 2, 3), '10010203');
  assert.equal(Cmd.color('zone2', 1, 2, 3), '09010203');
  assert.equal(Cmd.rgbMode(0x0a), '040A');
  assert.equal(Cmd.flowMode(0x19), '1E19');
  assert.equal(Cmd.flowSpeed(3), '0B03');
  assert.equal(Cmd.flowEffectToggle(4), '2904');
  assert.equal(Cmd.rgbCustomTable([0, 9, 10, 14]), '2A09aeffff');
  assert.equal(Cmd.rgbCustomSpeed(10), '3E0a');
  assert.equal(Cmd.nightDim(true, 3), '1A0103');
  assert.equal(Cmd.controlMode(true), '5101');
  assert.equal(Cmd.mirrorDelay('unlock', 45), '5A45'); // decimal digits (BCD), not 0x2D
  assert.equal(Cmd.welcomeMode(5), '3905');
  assert.equal(Cmd.lampsPassenger(114), '0F0114');
  assert.equal(Cmd.dial([1, 0, 1, 1, 0, 1, 1, 0].map(Boolean), [0, 0, 0, 0, 0, 0, 0, 1].map(Boolean)), '201011011000000001');
  assert.equal(Cmd.dirDoor('lr', true), '4A01');
  assert.equal(Cmd.doorSwap('confirm'), '4D005502');
});

test('values are clamped to safe ranges', () => {
  assert.equal(Cmd.brightnessAll(99), '020009');
  assert.equal(Cmd.power(7), '0702');
  assert.equal(Cmd.lampsDriver(9999), '1C0200');
});

test('FrameBuffer reassembles split and joined notifications', () => {
  const fb = new FrameBuffer();
  assert.deepEqual(fb.push('<4E00'), []);
  assert.deepEqual(fb.push('18><1300>junk<'), ['4E0018', '1300']);
  assert.deepEqual(fb.push('19>'), ['19']);
});

test('parses gen-2 status', () => {
  const f = parseFrame('4E001801FF00FF8B00FF060600030006090000');
  assert.equal(f.type, 'status');
  assert.equal(f.gen, 2);
  assert.equal(f.flowMode, 0x18);
  assert.equal(f.power, 1);
  assert.equal(f.color1, '#ff00ff');
  assert.equal(f.brightnessAll, 6);
  assert.equal(f.rgbCustomSpeed, 9);
  assert.equal(f.forcePhone, false);
});

test('parses version, dial and lamp layout', () => {
  const v = parseFrame('13' + Buffer.from('V6.303229-B6 260506-006').toString('hex').toUpperCase());
  assert.deepEqual([v.hardware, v.carModel, v.software], ['V6.30', '3229-B6', '260506-006']);

  const d = parseFrame('231011011000000001');
  assert.equal(d.type, 'dial');
  assert.deepEqual(d.model.map(Number), [1, 0, 1, 1, 0, 1, 1, 0]);
  assert.deepEqual(d.function.map(Number), [0, 0, 0, 0, 0, 0, 0, 1]);

  const l = parseFrame('4F00000000200101140000600100650101' + '01');
  assert.equal(l.type, 'lampLayout');
  assert.equal(l.driver, 20);
  assert.equal(l.driverRightOut, true);
  assert.equal(l.passenger, 114);
  assert.equal(l.passengerRightOut, false);
  assert.equal(l.frontDoors, 60);
  assert.equal(l.rearDoors, 65);
  assert.equal(l.rfFrontOut, true);
});

test('firmware file name and garbage never throw', () => {
  assert.equal(parseFrame('1501abc.bin').type, 'firmwareName');
  assert.equal(parseFrame('zz').type, 'text');
  assert.equal(parseFrame('').type, 'text');
});

test('firmware name reply is raw ASCII and may arrive in pieces', () => {
  // as sent by the gen-0 firmware: "<1501File004.bin>", the server expects the part after "15xx"
  const f = parseFrame('1501File006.bin');
  assert.equal(f.type, 'firmwareName');
  assert.equal(f.name, 'File006.bin');
  const fb = new FrameBuffer();
  assert.deepEqual(fb.push('<1501File00'), []);
  assert.deepEqual(fb.push('6.bin>'), ['1501File006.bin']);
});

test('no regular command can start a firmware update', () => {
  assert.equal(FIRMWARE_NAME_QUERY, '0DBB44');
  for (const p of OTA_PREFIXES) assert.ok(BLOCKED_PREFIXES.includes(p), `${p} must stay blocked in the raw console`);
  for (const [name, fn] of Object.entries(Cmd)) {
    for (const args of [[], [1, 1, 1, 1], [0, 0, 0, 0], [true], [false]]) {
      let out;
      try { out = fn(...args); } catch { continue; }
      if (typeof out !== 'string') continue;
      assert.ok(!OTA_PREFIXES.some((p) => out.toUpperCase().startsWith(p)), `Cmd.${name}(${args}) produced ${out}`);
    }
  }
});

test('demo controller answers the firmware name query', async () => {
  const link = new Link();
  const frames = [];
  link.addEventListener('frame', (e) => frames.push(parseFrame(e.detail.payload)));
  await link.connect(new DemoTransport());
  link.send(FIRMWARE_NAME_QUERY);
  await new Promise((r) => setTimeout(r, 300));
  const f = frames.find((x) => x.type === 'firmwareName');
  assert.ok(f, `got ${frames.map((x) => x.type)}`);
  assert.equal(f.name, 'File000-DEMO.bin');
  await link.disconnect();
});

test('demo controller round-trip through the Link', async () => {
  const link = new Link();
  const frames = [];
  link.addEventListener('frame', (e) => frames.push(parseFrame(e.detail.payload)));
  await link.connect(new DemoTransport());
  link.send(Cmd.hello());
  link.send(Cmd.power(0));
  await new Promise((r) => setTimeout(r, 400));
  const types = frames.map((f) => f.type);
  assert.ok(types.includes('status') && types.includes('settings') && types.includes('version') && types.includes('colors'));
  assert.equal(frames.filter((f) => f.type === 'status').at(-1).power, 0);
  await link.disconnect();
});

test('slider spam is coalesced to the latest value', async () => {
  const link = new Link();
  const sent = [];
  link.addEventListener('tx', (e) => sent.push(e.detail.payload));
  await link.connect(new DemoTransport());
  for (let i = 0; i <= 9; i++) link.send(Cmd.brightnessAll(i), { key: 'bri' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(sent.length <= 2, `sent ${sent.length}`);
  assert.equal(sent.at(-1), '020009');
  await link.disconnect();
});
