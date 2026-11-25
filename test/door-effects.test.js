import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doorCommand, doorConfiguration, parseDoorReply, isDoorFirmware, goodbyeCommand, hasGoodbye, snapshotCommand, savesInBox, needsGoodbyeSignal } from '../js/door-effects.js';
import { BLOCKED_PREFIXES } from '../js/protocol.js';

test('072 commands are exact ten-byte frames with XOR checksum and stay outside OTA opcodes', () => {
  const commands=doorConfiguration({ effect: 4, color: '#1181f3', brightness: 60, period: 15, mapping: [0,2,3,1], reverse: 5, enabled: 15 });
  assert.equal(commands.length,3);
  for (const payload of [...commands,doorCommand(0),doorCommand(2),doorCommand(5,[1,10])]) {
    const bytes=Buffer.from(payload,'hex');
    assert.equal(bytes.length,10);
    assert.deepEqual([...bytes.subarray(0,3)],[0x7e,0xd7,0x72]);
    assert.equal(bytes.subarray(0,9).reduce((sum,n)=>sum^n,0xa5),bytes[9]);
    assert.equal(BLOCKED_PREFIXES.some(prefix=>payload.startsWith(prefix)),false);
  }
  assert.equal(Buffer.from(commands[1],'hex')[4],0x78);
  assert.deepEqual([...Buffer.from(commands[0],'hex').subarray(4,9)],[4,17,129,243,60]);
});

test('malformed colors, mappings, brightness and timing cannot be queued', () => {
  const valid={effect:0,color:'#00ff80',brightness:60,period:15,mapping:[0,2,3,1],reverse:0,enabled:15};
  for (const patch of [{effect:5},{color:'#123'},{brightness:101},{brightness:1.5},{period:4},{period:101},{mapping:[0,0,2,3]},{mapping:[0,1,2,4]},{enabled:0},{reverse:16}]) assert.throws(()=>doorConfiguration({...valid,...patch}));
  assert.throws(()=>doorCommand(7));
  assert.throws(()=>doorCommand(1,[1,2,3,4,5,6]));
});

test('runtime replies decode only the exact 072 diagnostic formats', () => {
  assert.deepEqual(parseDoorReply('072 S 0103050101'),{kind:'S',values:[1,3,5,1,1]});
  // 084: light state, goodbye state and frames sent follow
  assert.deepEqual(parseDoorReply('<072 S 0101010104040005>'),{kind:'S',values:[1,1,1,1,4,4,0,5]});
  for (const text of ['072 S 01010101040400','072 S 010101010404000500']) assert.equal(parseDoorReply(text),null);
  assert.deepEqual(parseDoorReply('<072 M 78000F0F>'),{kind:'M',values:[0x78,0,15,15]});
  assert.deepEqual(parseDoorReply('072 N 00000100'),{kind:'N',values:[0,0,1,0]});
  assert.deepEqual(parseDoorReply('<072 X 03>'),{kind:'X',values:[3]});
  for (const text of ['071 IDLE','072 S 00','072 Q 0000','072 S ZZZZZZZZZZ','072 ARMED','072 X 0303']) assert.equal(parseDoorReply(text),null);
});

test('door panel firmware gate accepts 072 and every custom build from 074 on, including future ones', () => {
  for (const v of ['261115-072','261115-074','261115-075','261115-076','261115-080','261115-081','261115-120']) assert.equal(isDoorFirmware(v),true);
  for (const v of ['261115-071','261115-073','261115-007','261115-80','260506-080','',undefined,null]) assert.equal(isDoorFirmware(v),false);
  // newer builds keep the newest feature set without an app update
  for (const v of ['261115-080','261115-081']) { assert.equal(hasGoodbye(v),true); assert.equal(savesInBox(v),true); assert.equal(needsGoodbyeSignal(v),false); }
  assert.equal(needsGoodbyeSignal('261115-077'),true);
});

test('goodbye command is op 5 with on/off and 100 ms stage time, only on 076', () => {
  assert.equal(goodbyeCommand(true,10),doorCommand(5,[1,10]));
  assert.equal(goodbyeCommand(false,5),doorCommand(5,[0,5]));
  for (const bad of [2,51,1.5]) assert.throws(()=>goodbyeCommand(true,bad));
  assert.equal(hasGoodbye('261115-076'),true);
  for (const v of ['261115-075','261115-072','']) assert.equal(hasGoodbye(v),false);
});

test('077 goodbye signal, car-state snapshot and D replies', () => {
  assert.equal(goodbyeCommand(true,10,[16,4,1]),doorCommand(5,[1,10,16,4,1]));
  assert.equal(goodbyeCommand(true,10),doorCommand(5,[1,10,0,0,0]));
  for (const bad of [[64,1,0],[0,256,0],[0,1,2],[0,1]]) assert.throws(()=>goodbyeCommand(true,10,bad));
  assert.equal(snapshotCommand(3),doorCommand(6,[3]));
  assert.throws(()=>snapshotCommand(4));
  const d='072 D 03'+'00112233445566778899AABBCCDDEEFF';
  assert.deepEqual(parseDoorReply(d).values,[3,0,0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88,0x99,0xaa,0xbb,0xcc,0xdd,0xee,0xff]);
  assert.equal(parseDoorReply('072 D 0300'),null);
  assert.equal(savesInBox('261115-077'),true);
  assert.equal(savesInBox('261115-076'),false);
  assert.equal(hasGoodbye('261115-077'),true);
});
