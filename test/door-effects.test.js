import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doorCommand, doorConfiguration, parseDoorReply, isDoorFirmware, goodbyeCommand, hasGoodbye } from '../js/door-effects.js';
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
  assert.throws(()=>doorCommand(6));
  assert.throws(()=>doorCommand(1,[1,2,3,4,5,6]));
});

test('runtime replies decode only the exact 072 diagnostic formats', () => {
  assert.deepEqual(parseDoorReply('072 S 0103050101'),{kind:'S',values:[1,3,5,1,1]});
  assert.deepEqual(parseDoorReply('<072 M 78000F0F>'),{kind:'M',values:[0x78,0,15,15]});
  assert.deepEqual(parseDoorReply('072 N 00000100'),{kind:'N',values:[0,0,1,0]});
  assert.deepEqual(parseDoorReply('<072 X 03>'),{kind:'X',values:[3]});
  for (const text of ['071 IDLE','072 S 00','072 Q 0000','072 S ZZZZZZZZZZ','072 ARMED','072 X 0303']) assert.equal(parseDoorReply(text),null);
});

test('door panel firmware gate accepts only 072 and 074', () => {
  for (const v of ['261115-072','261115-074','261115-075','261115-076']) assert.equal(isDoorFirmware(v),true);
  for (const v of ['261115-071','261115-073','261115-007','']) assert.equal(isDoorFirmware(v),false);
});

test('goodbye command is op 5 with on/off and 100 ms stage time, only on 076', () => {
  assert.equal(goodbyeCommand(true,10),doorCommand(5,[1,10]));
  assert.equal(goodbyeCommand(false,5),doorCommand(5,[0,5]));
  for (const bad of [2,51,1.5]) assert.throws(()=>goodbyeCommand(true,bad));
  assert.equal(hasGoodbye('261115-076'),true);
  for (const v of ['261115-075','261115-072','']) assert.equal(hasGoodbye(v),false);
});
