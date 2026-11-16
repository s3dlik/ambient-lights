import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cmd, encodeFrame, parseFrame, FrameBuffer, OTA_PREFIXES, BLOCKED_PREFIXES, FIRMWARE_NAME_QUERY } from '../js/protocol.js';
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
