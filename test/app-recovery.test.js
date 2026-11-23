import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as protocol from '../js/protocol.js';
import * as transport from '../js/transport.js';
import { OtaTransfer } from '../js/ota-transfer.js';
import { DiagnosticLog } from '../js/diagnostics.js';
import * as doorEffects from '../js/door-effects.js';

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
  const context = vm.createContext({ ...protocol, ...transport, ...doorEffects, OtaTransfer, DiagnosticLog,
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
  vm.runInContext(source + '\nglobalThis.api = { state, link, diagnostics, init, buildConnect, buildDevice, buildCar, renderShell, readFirmwareName, otaBegin, otaRetry, otaOnFrame, otaFail, otaStopAndUnlock, otaLoadFile, otaTransfer, otaSet };', context);
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

test('072 entry timeout records the completed request write and sends zero firmware bytes', async t => {
  const app=appHarness(), sent=[];
  app.state.ota={...app.state.ota,file:new Uint8Array(234444),fileName:'072.bin',check:{ok:true,info:{embeddedName:'File122.bin'}}};
  app.link.gapMs=0;
  app.link.transport={connected:true,write:async bytes=>{
    const payload=new TextDecoder().decode(bytes); sent.push(payload);
    if(payload==='<0DBB44>') queueMicrotask(()=>app.otaOnFrame({type:'firmwareName',name:'File122.bin'}));
  },disconnect:async()=>{}};
  t.after(()=>app.link.disconnect());
  app.otaBegin();
  for(let i=0;i<100 && !app.state.ota.entry.writtenAt;i++) await new Promise(r=>setTimeout(r,5));
  assert.ok(app.state.ota.entry.writtenAt);
  assert.equal(app.state.ota.phase,'entering');
  assert.deepEqual(sent,['<0DBB44>','<0E234444>']);
  assert.equal(app.state.ota.progress.currentBlock,undefined);
  const timeout=[...app.timers.values()].find(timer=>timer.ms===20000);
  assert.ok(timeout); timeout.fn();
  assert.equal(app.state.ota.phase,'stalled');
  assert.match(app.state.ota.message,/No firmware blocks were attempted/);
  assert.match(app.state.ota.message,/write completed locally/);
  assert.deepEqual(sent,['<0DBB44>','<0E234444>']);
  assert.equal(app.diagnostics.lastUpdate.entry.payload,'0E234444');
  assert.equal(app.link.otaLock,true);
  const reloaded=appHarness(app.storage); reloaded.init();
  assert.equal(reloaded.state.ota.entry.payload,'0E234444');
  assert.equal(reloaded.state.ota.total,1173);
  assert.equal(reloaded.state.ota.selectedBytes,234444);
  assert.equal(reloaded.state.ota.file,null);
  assert.equal(reloaded.link.queue.length,0);
});

test('an update-request write failure is reported before a bootloader timeout and cannot start data', async t => {
  const app=appHarness(), sent=[];
  app.state.ota={...app.state.ota,file:new Uint8Array(436),check:{ok:true,info:{embeddedName:'File122.bin'}}};
  app.link.gapMs=0;
  app.link.transport={connected:true,write:async bytes=>{
    const payload=new TextDecoder().decode(bytes); sent.push(payload);
    if(payload==='<0DBB44>') queueMicrotask(()=>app.otaOnFrame({type:'firmwareName',name:'File122.bin'}));
    else throw new Error('test GATT failure');
  },disconnect:async()=>{}};
  t.after(()=>app.link.disconnect());
  app.otaBegin();
  for(let i=0;i<100 && app.state.ota.phase!=='stalled';i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(app.state.ota.phase,'stalled');
  assert.equal(app.state.ota.entry.writeCompleted,false);
  assert.match(app.state.ota.message,/Update-request Bluetooth write failed/);
  app.otaOnFrame({type:'otaStart'});
  assert.deepEqual(sent,['<0DBB44>','<0E000436>']);
});

test('door effects require a fresh 072 version on this connection, and disconnect invalidates it', () => {
  const app=appHarness(); app.buildConnect(); app.buildDevice();
  const apply=app.body.all().find(e=>e.tag==='button' && e.textContent==='Apply and enable door effects');
  const writes=[];
  app.link.transport={connected:true,write:async bytes=>writes.push(bytes),disconnect:async()=>{}};
  app.state.connected=true; app.state.version.software='261115-072';
  app.otaSet({phase:'idle'}); // refresh all actual bindings
  assert.equal(apply.disabled,true); // cached version is insufficient
  apply.dispatchEvent(new Event('click'));
  assert.equal(writes.length,0);
  const version='13'+Buffer.from('V6.303229-B60261115-072').toString('hex').toUpperCase();
  app.link.emit('frame',{payload:version});
  assert.equal(apply.disabled,false);
  app.link.emit('state',{connected:false});
  assert.equal(apply.disabled,true);
  assert.equal(app.state.doorFx.verifiedConnection,false);
});

test('door panel applies settings in order, retains runtime status, and blocks actions under OTA', {timeout:2000}, async t => {
  const app=appHarness(); app.buildConnect(); app.buildDevice();
  const writes=[]; let finish;
  const complete=new Promise(resolve=>{finish=resolve;});
  app.link.gapMs=0;
  app.link.transport={connected:true,write:async bytes=>{
    writes.push(String.fromCharCode(...bytes)); if(writes.length===3) finish();
  },disconnect:async()=>{}};
  t.after(()=>app.link.disconnect());
  app.state.connected=true;
  app.link.emit('frame',{payload:'13'+Buffer.from('V6.303229-B60261115-072').toString('hex').toUpperCase()});
  const button=label=>app.body.all().find(e=>e.tag==='button' && e.textContent===label);
  button('Apply and enable door effects').dispatchEvent(new Event('click'));
  await complete;
  const expected=doorEffects.doorConfiguration({effect:0,color:'#00ff80',brightness:60,period:15,mapping:[2,0,1,3],reverse:0,enabled:15});
  assert.deepEqual(writes,expected.map(payload=>`<${payload}>`));
  assert.equal(JSON.parse(app.storage.get('al.doorEffects072')).color,'#00ff80');
  app.link.emit('frame',{payload:'072 S 0103010101'});
  assert.deepEqual(Array.from(app.state.doorFx.replies.S),[1,3,1,1,1]);
  assert.match(app.body.querySelector('#view-device').textContent,/Door effect active/);
  app.link.otaLock=true; app.otaSet({phase:'sending'});
  app.link.emit('frame',{payload:'072 X 02'});
  assert.match(app.body.querySelector('#view-device').textContent,/Last refusal: bad header or checksum/);
  app.link.emit('frame',{payload:'072 S 0103010101'});
  assert.doesNotMatch(app.body.querySelector('#view-device').textContent,/Last refusal/);
  assert.equal(button('Preview C0'),undefined);
  for(const label of ['Read door effect status','Disable custom door effects']) {
    assert.equal(button(label).disabled,true);
    button(label).dispatchEvent(new Event('click'));
  }
  assert.equal(writes.length,3);
  assert.equal(app.link.queue.length,0);
});

test('Car page door card re-sends saved settings on connect and switches off with Disable', {timeout:2000}, async t => {
  const saved={on:true,effect:2,color:'#ff0000',brightness:80,period:15,mapping:[0,2,3,1],reverse:0,enabled:15};
  const app=appHarness(new Map([['al.doorEffects072',JSON.stringify(saved)]])); app.buildConnect(); app.buildCar();
  // the old provisional mapping saved on the phone is replaced once by the order measured on the car
  const fixed={...saved,mapping:[2,0,1,3]};
  assert.deepEqual(JSON.parse(app.storage.get('al.doorEffects072')).mapping,[2,0,1,3]);
  assert.equal(app.storage.get('al.doorMappingFixed'),'true');
  const light=app.body.querySelector('#view-car').all().find(e=>e.tag==='div' && e.children[0]?.tag==='h2' && e.children[0].textContent.startsWith('Doors'));
  assert.ok(light,'Doors card is on the Car page');
  assert.match(light.textContent,/Needs the custom door firmware 261115-080/);
  const writes=[]; let waiting=null;
  const until=n=>new Promise(resolve=>{ waiting={n,resolve}; if(writes.length>=n) resolve(); });
  app.link.gapMs=0;
  app.link.transport={connected:true,write:async bytes=>{
    writes.push(String.fromCharCode(...bytes)); if(waiting && writes.length>=waiting.n) waiting.resolve();
  },disconnect:async()=>{}};
  t.after(()=>app.link.disconnect());
  app.state.connected=true;
  app.link.emit('frame',{payload:'13'+Buffer.from('V6.303229-B60261115-075').toString('hex').toUpperCase()});
  assert.doesNotMatch(light.textContent,/Needs the custom door firmware/);
  const resend=[...app.timers.values()].find(x=>x.ms===500);
  assert.ok(resend,'saved door settings are scheduled for re-sending');
  resend.fn();
  await until(3);
  assert.deepEqual(writes,doorEffects.doorConfiguration(fixed).map(p=>`<${p}>`));
  // Picking a colour while ON sends the new configuration straight away.
  const swatch=light.all().find(e=>e.tag==='button' && e['aria-label']==='Colour 4');
  swatch.dispatchEvent(new Event('click'));
  await until(6);
  assert.deepEqual(writes.slice(3),doorEffects.doorConfiguration({...fixed,color:'#00ff00'}).map(p=>`<${p}>`));
  // OFF sends Disable once and remembers it; colour changes while OFF are only saved.
  // first OFF is the door light; the second belongs to the goodbye (hidden on 075, which never gets op 5)
  const off=light.all().filter(e=>e.tag==='button' && e.textContent==='OFF')[0];
  off.dispatchEvent(new Event('click'));
  await until(7);
  assert.equal(writes[6],`<${doorEffects.doorCommand(0)}>`);
  assert.equal(JSON.parse(app.storage.get('al.doorEffects072')).on,false);
  light.all().find(e=>e.tag==='button' && e['aria-label']==='Colour 1').dispatchEvent(new Event('click'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes.length,7);
  assert.equal(JSON.parse(app.storage.get('al.doorEffects072')).color,'#ff0000');
  app.link.emit('frame',{payload:'072 S 0003000000'});
  assert.match(light.textContent,/Off: doors show the normal warning/);
});

test('Car page goodbye is sent to 076 on connect and when changed, even with the door light off', {timeout:2000}, async t => {
  const saved={on:false,effect:0,color:'#ff0000',brightness:80,period:15,mapping:[2,0,1,3],reverse:0,enabled:15,goodbye:true,goodbyeTime:10};
  const app=appHarness(new Map([['al.doorEffects072',JSON.stringify(saved)],['al.doorMappingFixed','true']])); app.buildConnect(); app.buildCar();
  const card=app.body.querySelector('#view-car').all().find(e=>e.tag==='div' && e.children[0]?.tag==='h2' && e.children[0].textContent.startsWith('Doors'));
  const writes=[]; let waiting=null;
  const until=n=>new Promise(resolve=>{ waiting={n,resolve}; if(writes.length>=n) resolve(); });
  app.link.gapMs=0;
  app.link.transport={connected:true,write:async bytes=>{
    writes.push(String.fromCharCode(...bytes)); if(waiting && writes.length>=waiting.n) waiting.resolve();
  },disconnect:async()=>{}};
  t.after(()=>app.link.disconnect());
  app.state.connected=true;
  app.link.emit('frame',{payload:'13'+Buffer.from('V6.303229-B60261115-076').toString('hex').toUpperCase()});
  assert.equal(card.all().find(e=>e.textContent==='Goodbye animation: needs firmware 261115-080.').hidden,true);
  const resend=[...app.timers.values()].find(x=>x.ms===500);
  assert.ok(resend,'goodbye alone is enough to re-send on connect');
  resend.fn();
  await until(2);
  assert.deepEqual(writes,[`<${doorEffects.doorCommand(0)}>`,`<${doorEffects.goodbyeCommand(true,10)}>`]);
  const buttons=label=>card.all().filter(e=>e.tag==='button' && e.textContent===label);
  buttons('Fast').at(-1).dispatchEvent(new Event('click'));
  await until(4);
  assert.equal(writes[3],`<${doorEffects.goodbyeCommand(true,5)}>`);
  buttons('OFF').at(-1).dispatchEvent(new Event('click'));
  await until(6);
  assert.equal(writes[5],`<${doorEffects.goodbyeCommand(false,5)}>`);
  assert.equal(JSON.parse(app.storage.get('al.doorEffects072')).goodbye,false);
  // both off: changes are only saved
  buttons('Slow').at(-1).dispatchEvent(new Event('click'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes.length,6);
  assert.equal(JSON.parse(app.storage.get('al.doorEffects072')).goodbyeTime,20);
});


test('demo shows the Doors controls with the 076 note but sends and saves nothing', () => {
  const saved={on:true,effect:2,color:'#ff0000',brightness:80,period:15,mapping:[2,0,1,3],reverse:0,enabled:15,goodbye:false,goodbyeTime:10};
  const app=appHarness(new Map([['al.doorEffects072',JSON.stringify(saved)],['al.doorMappingFixed','true']]));
  app.state.demo=true; app.buildConnect(); app.buildCar();
  const card=app.body.querySelector('#view-car').all().find(e=>e.tag==='div' && e.children[0]?.tag==='h2' && e.children[0].textContent.startsWith('Doors'));
  assert.match(card.textContent,/Demo: these controls need the custom door firmware 261115-080/);
  const hiddenUp=e=>{ for(let x=e;x&&x!==card;x=x.parentNode) if(x.hidden) return true; return false; };
  const goodbyeOn=card.all().filter(e=>e.tag==='button' && e.textContent==='ON').at(-1);
  assert.equal(hiddenUp(goodbyeOn),false,'goodbye controls are visible in the demo');
  assert.equal(hiddenUp(card.all().find(e=>e['aria-label']==='Colour 4')),false,'door colours are visible in the demo');
  assert.equal(hiddenUp(card.all().find(e=>e.textContent==='Goodbye animation: needs firmware 261115-080.')),false);
  card.all().find(e=>e['aria-label']==='Colour 4').dispatchEvent(new Event('click'));
  goodbyeOn.dispatchEvent(new Event('click'));
  assert.equal(app.state.doorFx.preferences.goodbye,true);
  assert.deepEqual(JSON.parse(app.storage.get('al.doorEffects072')),saved,'demo changes are not saved');
  assert.equal(app.link.queue.length,0);
});

test('077 advanced card takes car-signal snapshots and sends the saved goodbye trigger', {timeout:2000}, async t => {
  const saved={on:false,effect:0,color:'#ff0000',brightness:80,period:15,mapping:[2,0,1,3],reverse:0,enabled:15,goodbye:true,goodbyeTime:10};
  const app=appHarness(new Map([['al.doorEffects072',JSON.stringify(saved)],['al.doorMappingFixed','true']])); app.buildConnect(); app.buildDevice();
  const writes=[]; let waiting=null;
  const until=n=>new Promise(resolve=>{ waiting={n,resolve}; if(writes.length>=n) resolve(); });
  app.link.gapMs=0;
  app.link.transport={connected:true,write:async bytes=>{
    writes.push(String.fromCharCode(...bytes)); if(waiting && writes.length>=waiting.n) waiting.resolve();
  },disconnect:async()=>{}};
  t.after(()=>app.link.disconnect());
  app.state.connected=true;
  app.link.emit('frame',{payload:'13'+Buffer.from('V6.303229-B60261115-077').toString('hex').toUpperCase()});
  const resend=[...app.timers.values()].find(x=>x.ms===500); resend.fn();
  await until(2);
  assert.deepEqual(writes,[`<${doorEffects.doorCommand(0)}>`,`<${doorEffects.goodbyeCommand(true,10,[0,0,0])}>`]);
  const device=app.body.querySelector('#view-device');
  const button=label=>device.all().find(e=>e.tag==='button' && e.textContent===label);
  button('Car signal snapshot').dispatchEvent(new Event('click'));
  await until(6);
  assert.deepEqual(writes.slice(2),[0,1,2,3].map(n=>`<${doorEffects.snapshotCommand(n)}>`));
  device.all().find(e=>e['aria-label']==='Signal byte').value='16';
  device.all().find(e=>e['aria-label']==='Signal bit mask (hex)').value='04';
  button('Save goodbye trigger').dispatchEvent(new Event('click'));
  await until(8);
  assert.equal(writes[7],`<${doorEffects.goodbyeCommand(true,10,[16,4,0])}>`);
  assert.deepEqual(JSON.parse(app.storage.get('al.doorEffects072')).goodbyeSignal,[16,4,0]);
  app.link.emit('frame',{payload:'072 D 00'+'00'.repeat(16)});
  assert.deepEqual(app.state.doorFx.replies.D,[0,...Array(16).fill(0)]);
});

test('078: saved Comet falls back to Solid, goodbye is sent, no engine-signal setup is asked for', {timeout:2000}, async t => {
  const saved={on:true,effect:4,color:'#ff0000',brightness:80,period:15,mapping:[2,0,1,3],reverse:0,enabled:15,goodbye:true,goodbyeTime:10};
  const app=appHarness(new Map([['al.doorEffects072',JSON.stringify(saved)],['al.doorMappingFixed','true']])); app.buildConnect(); app.buildCar();
  const card=app.body.querySelector('#view-car').all().find(e=>e.tag==='div' && e.children[0]?.tag==='h2' && e.children[0].textContent.startsWith('Doors'));
  const writes=[]; let waiting=null;
  const until=n=>new Promise(resolve=>{ waiting={n,resolve}; if(writes.length>=n) resolve(); });
  app.link.gapMs=0;
  app.link.transport={connected:true,write:async bytes=>{
    writes.push(String.fromCharCode(...bytes)); if(waiting && writes.length>=waiting.n) waiting.resolve();
  },disconnect:async()=>{}};
  t.after(()=>app.link.disconnect());
  app.state.connected=true;
  app.link.emit('frame',{payload:'13'+Buffer.from('V6.303229-B60261115-078').toString('hex').toUpperCase()});
  [...app.timers.values()].find(x=>x.ms===500).fn();
  await until(4);
  assert.deepEqual(writes,[...doorEffects.doorConfiguration({...saved,effect:0}),doorEffects.goodbyeCommand(true,10,[0,0,0])].map(p=>`<${p}>`));
  const hint=card.all().find(e=>e.textContent?.startsWith('The car reports the ignition as on'));
  assert.equal(hint.hidden,true);
  const effectButtons=card.all().filter(e=>e.tag==='button' && ['Repeating wipe','Comet'].includes(e.textContent));
  assert.ok(effectButtons.length===2 && effectButtons.every(b=>b.hidden));
});
