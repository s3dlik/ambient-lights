// Block transfer only. The application owns filename checks, update entry and version verification.
export class OtaTransfer {
  constructor(link, { onProgress = () => {}, onStall = () => {}, onComplete = () => {}, ackTimeout = 8000, writeTimeout = 15000 } = {}) {
    Object.assign(this, { link, onProgress, onStall, onComplete, ackTimeout, writeTimeout });
    this.run = 0;
    this.progress = {};
    link.addEventListener?.('raw-progress', e => {
      if (e.detail.transferRun === this.run && this.phase === 'writing' && e.detail.block === this.progress.currentBlock) {
        this.progress.currentBlockWritten = e.detail.written;
      }
    });
  }

  cancel() {
    this.run++;
    clearTimeout(this.timer);
    this.abort?.abort();
    this.phase = 'stopped';
  }

  start(blocks, pieceSize) {
    this.cancel();
    this.blocks = blocks;
    this.pieceSize = pieceSize;
    this.abort = new AbortController();
    this.started = Date.now();
    this.progress = { currentBlock: 0, writtenBlocks: 0, acknowledgedBlocks: 0, bytesWritten: 0, totalBlocks: blocks.length, pieceSize, startedAt: new Date(this.started).toISOString() };
    if (!blocks.length) { this.stall('No firmware blocks loaded.'); return; }
    this.sendBlock(0, this.run);
  }

  publish() {
    this.progress.elapsedMs = Date.now() - this.started;
    this.onProgress({ ...this.progress, transferPhase: this.phase });
  }

  arm(ms, reason) {
    clearTimeout(this.timer);
    const run = this.run;
    this.timer = setTimeout(() => { if (run === this.run) this.stall(reason); }, ms);
  }

  stall(reason) {
    this.cancel();
    this.phase = 'stalled';
    this.publish();
    this.onStall(reason, { ...this.progress });
  }

  async sendBlock(index, run) {
    if (run !== this.run) return;
    this.phase = 'writing';
    this.earlyAck = false;
    this.progress.currentBlock = index + 1;
    this.progress.currentBlockWritten = 0;
    this.publish();
    this.arm(this.writeTimeout, `Bluetooth write did not finish within ${this.writeTimeout / 1000} s at block ${index + 1}.`);
    let ok;
    try {
      ok = await this.link.sendRaw(this.blocks[index], {
        pieceSize: this.pieceSize, signal: this.abort.signal,
        meta: { block: index + 1, total: this.blocks.length, transferRun: run },
      });
    } catch (e) {
      if (run === this.run) this.stall(`Write failed at block ${index + 1}: ${e.message || e}`);
      return;
    }
    if (run !== this.run) return;
    clearTimeout(this.timer);
    if (!ok) { this.stall(`Write failed at block ${index + 1}. Controller state is unknown; reconnect and retry from the start.`); return; }
    this.progress.writtenBlocks = index + 1;
    this.progress.bytesWritten += this.blocks[index].length;
    if (index === this.blocks.length - 1) {
      this.phase = 'complete';
      this.publish();
      this.onComplete();
      return;
    }
    this.phase = 'waiting-ack';
    this.publish();
    if (this.earlyAck) this.ack();
    else this.arm(this.ackTimeout, `No <16> acknowledgement after block ${index + 1} of ${this.blocks.length}.`);
  }

  ack() {
    // Notifications can arrive before the GATT write promise resolves. Remember one ACK,
    // then advance only after all pieces of this block have finished writing.
    if (this.phase === 'writing') { this.earlyAck = true; return; }
    if (this.phase !== 'waiting-ack') return;
    clearTimeout(this.timer);
    this.progress.acknowledgedBlocks = this.progress.currentBlock;
    this.sendBlock(this.progress.currentBlock, this.run);
  }
}
