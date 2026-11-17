import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OtaTransfer } from '../js/ota-transfer.js';
import { Link } from '../js/transport.js';
import { DiagnosticLog } from '../js/diagnostics.js';
import { otaBlocks } from '../js/protocol.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await wait(5); }
  assert.fail('Condition did not become true');
}
const blocks = [new Uint8Array(200), new Uint8Array(200), new Uint8Array(36)];

test('an ACK arriving inside the write waits for completion and cannot leave a stale timer', async () => {
  const first = deferred();
  const sent = [];
  let complete = 0;
  const stalls = [];
  const transfer = new OtaTransfer({ sendRaw: async bytes => {
    sent.push(bytes.length);
    if (sent.length === 1) { transfer.ack(); return first.promise; }
    transfer.ack(); return true;
  } }, { ackTimeout: 20, onComplete: () => complete++, onStall: m => stalls.push(m) });
  transfer.start(blocks, 20);
  assert.deepEqual(sent, [200]);
  first.resolve(true);
  await until(() => complete === 1);
  await wait(35);
  assert.deepEqual(sent, [200, 200, 36]);
  assert.equal(transfer.progress.writtenBlocks, 3);
  assert.equal(transfer.progress.acknowledgedBlocks, 2); // final block is verified by version, not a fabricated ACK
  assert.equal(transfer.progress.bytesWritten, 436);
  assert.deepEqual(stalls, []);
});

test('cancel during a pending write ignores a late completion and ACK', async () => {
  const pending = deferred();
  let sends = 0, complete = 0;
  const transfer = new OtaTransfer({ sendRaw: () => { sends++; return pending.promise; } }, { onComplete: () => complete++ });
  transfer.start(blocks, 20);
  transfer.cancel();
  pending.resolve(true);
  transfer.ack();
  await wait(10);
  assert.equal(sends, 1);
  assert.equal(complete, 0);
  assert.equal(transfer.phase, 'stopped');
});

test('restart invalidates the prior transfer even when its write resolves later', async () => {
  const old = deferred();
  let sends = 0, complete = 0;
  const transfer = new OtaTransfer({ sendRaw: async () => ++sends === 1 ? old.promise : true }, { onComplete: () => complete++ });
  transfer.start(blocks, 20);
  transfer.start([new Uint8Array(36)], 20);
  await until(() => complete === 1);
  old.resolve(true);
  await wait(10);
  assert.equal(complete, 1);
  assert.equal(transfer.progress.bytesWritten, 36);
});

test('write failure never blindly retries a potentially partial block at a different size', async () => {
  let calls = 0;
  const errors = [];
  const transfer = new OtaTransfer({ sendRaw: async () => { calls++; return false; } }, { onStall: m => errors.push(m) });
  transfer.start(blocks, 0);
  await until(() => errors.length > 0);
  assert.equal(calls, 1);
  assert.equal(transfer.progress.writtenBlocks, 0);
  assert.match(errors[0], /block 1/);
});

test('a missing controller ACK stalls with the exact last completed block', async () => {
  const errors = [];
  const transfer = new OtaTransfer({ sendRaw: async () => true }, { ackTimeout: 15, onStall: m => errors.push(m) });
  transfer.start(blocks, 20);
  await until(() => errors.length > 0);
  assert.equal(transfer.progress.currentBlock, 1);
  assert.equal(transfer.progress.writtenBlocks, 1);
  assert.equal(transfer.progress.acknowledgedBlocks, 0);
  assert.equal(transfer.progress.bytesWritten, 200);
});

test('a hung GATT write times out and late resolution cannot mark success', async () => {
  const pending = deferred();
  const errors = [];
  let complete = 0;
  const transfer = new OtaTransfer({ sendRaw: () => pending.promise }, { writeTimeout: 15, onStall: m => errors.push(m), onComplete: () => complete++ });
  transfer.start([blocks[0]], 20);
  await until(() => errors.length > 0);
  pending.resolve(true);
  await wait(10);
  assert.match(errors[0], /write did not finish/);
  assert.equal(complete, 0);
});

function connectedLink(write) {
  const link = new Link();
  link.gapMs = 0;
  link.transport = { connected: true, write, disconnect: async () => {} };
  return link;
}

test('partial write errors record accepted bytes and block identity', async () => {
  let writes = 0;
  const events = [];
  const link = connectedLink(async () => { if (++writes === 4) throw new Error('GATT lost'); });
  link.addEventListener('tx-raw', e => events.push(e.detail));
  assert.equal(await link.sendRaw(blocks[0], { pieceSize: 20, meta: { block: 1007, total: 1164 } }), false);
  assert.equal(events[0].written, 60);
  assert.equal(events[0].block, 1007);
  assert.match(events[0].error, /GATT lost/);
});

test('cancelling a block stops all later pieces', async () => {
  const first = deferred();
  const abort = new AbortController();
  let writes = 0;
  const link = connectedLink(async () => { writes++; await first.promise; });
  const pending = link.sendRaw(blocks[0], { pieceSize: 20, signal: abort.signal });
  abort.abort(); first.resolve();
  assert.equal(await pending, false);
  assert.equal(writes, 1);
});

test('disconnect resolves active and queued raw writes, even if GATT never settles', async () => {
  const hanging = deferred();
  const link = connectedLink(() => hanging.promise);
  const first = link.sendRaw(blocks[0]);
  const queued = link.sendRaw(blocks[1]);
  await link.disconnect();
  assert.deepEqual(await Promise.all([first, queued]), [false, false]);
  hanging.resolve();
});

test('reconnection cannot send remaining old pieces or block a new command behind a hung old write', async () => {
  const old = deferred();
  let oldWrites = 0;
  const link = connectedLink(() => { oldWrites++; return old.promise; });
  const oldSend = link.sendRaw(blocks[0], { pieceSize: 20 });
  await link.disconnect();
  const received = [];
  const fresh = { connected: false, connect: async () => { fresh.connected = true; }, disconnect: async () => {}, write: async bytes => received.push(new TextDecoder().decode(bytes)) };
  await link.connect(fresh);
  link.send('0A01');
  await until(() => received.length === 1);
  old.resolve();
  assert.equal(await oldSend, false);
  await wait(10);
  assert.deepEqual(received, ['<0A01>']);
  assert.equal(oldWrites, 1);
});

test('normal commands queued before the OTA lock are also blocked at dequeue time', async () => {
  const first = deferred();
  const sent = [];
  const link = connectedLink(async bytes => { sent.push(new TextDecoder().decode(bytes)); if (sent.length === 1) await first.promise; });
  link.send('0A01');
  link.send('0700');
  link.otaLock = true;
  assert.equal(link.send('0DBB44'), false);
  assert.equal(link.send('0DBB44', { ota: true }), true);
  first.resolve();
  await until(() => sent.length === 2);
  assert.deepEqual(sent, ['<0A01>', '<0DBB44>']);
});

test('diagnostics survive reconstruction with timestamps, summary and a bounded log', () => {
  const values = new Map();
  const storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
  const log = new DiagnosticLog(storage, 3);
  for (let i = 0; i < 5; i++) log.add('rx', 'frame ' + i);
  log.update({ phase: 'stalled', progress: { currentBlock: 1007, acknowledgedBlocks: 1006 } });
  const restored = new DiagnosticLog(storage, 3);
  assert.deepEqual(restored.entries.map(e => e.text), ['frame 2', 'frame 3', 'frame 4']);
  assert.equal(restored.lastUpdate.progress.currentBlock, 1007);
  assert.match(restored.text(), /^\d{4}-\d\d-\d\dT/);
  assert.equal(JSON.parse(JSON.stringify(restored.report({ device: 'test' }))).lastUpdate.phase, 'stalled');
  restored.clear();
  assert.equal(new DiagnosticLog(storage).entries.length, 0);
  assert.equal(new DiagnosticLog(storage).lastUpdate, null);
});

test('unavailable or corrupt browser storage does not break live diagnostics', () => {
  const blocked = new DiagnosticLog({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
  blocked.add('err', 'test');
  assert.equal(blocked.entries.length, 1);
  assert.equal(blocked.persistent, false);
  const corrupt = new DiagnosticLog({ getItem: () => '{bad', setItem: () => {} });
  assert.equal(corrupt.entries.length, 0);
});

test('232704 bytes transfer through the actual Link as 1164 blocks in 20-byte pieces', { timeout: 10000 }, async () => {
  const file = Uint8Array.from({ length: 232704 }, (_, i) => i % 251);
  const received = [];
  let byteCount = 0, largestPiece = 0, transfer;
  const link = connectedLink(async piece => {
    received.push(piece.slice()); byteCount += piece.length; largestPiece = Math.max(largestPiece, piece.length);
    if (byteCount % 200 === 0 && byteCount < file.length) transfer.ack(); // deliberately before write promise resolution
  });
  const result = deferred();
  const failures = [];
  transfer = new OtaTransfer(link, { onComplete: () => result.resolve(), onStall: m => { failures.push(m); result.resolve(); } });
  transfer.start(otaBlocks(file), 20);
  await result.promise;
  assert.deepEqual(failures, []);
  assert.deepEqual(Buffer.concat(received), Buffer.from(file));
  assert.equal(largestPiece, 20);
  assert.equal(transfer.progress.writtenBlocks, 1164);
  assert.equal(transfer.progress.acknowledgedBlocks, 1163);
  assert.equal(transfer.progress.currentBlockWritten, 104);
  transfer.cancel(); await link.disconnect();
});

test('disconnect beyond block 1000 preserves the exact attempted block and accepted partial bytes', { timeout: 10000 }, async () => {
  const file = new Uint8Array(232704);
  let byteCount = 0, transfer;
  const link = connectedLink(async piece => {
    // 1006 full blocks and three pieces of block 1007 succeed; the fourth write fails.
    if (byteCount === 1006 * 200 + 60) throw new Error('simulated disconnect');
    byteCount += piece.length;
    if (byteCount % 200 === 0) transfer.ack();
  });
  const result = deferred();
  let complete = false;
  transfer = new OtaTransfer(link, { onComplete: () => { complete = true; result.resolve(); }, onStall: () => result.resolve() });
  transfer.start(otaBlocks(file), 20);
  await result.promise;
  assert.equal(complete, false);
  assert.equal(transfer.progress.currentBlock, 1007);
  assert.equal(transfer.progress.writtenBlocks, 1006);
  assert.equal(transfer.progress.acknowledgedBlocks, 1006);
  assert.equal(transfer.progress.currentBlockWritten, 60);
  assert.equal(transfer.phase, 'stalled');
  await link.disconnect();
});
