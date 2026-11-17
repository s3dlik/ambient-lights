const KEY = 'al.bluetoothDiagnostics.v1';

export class DiagnosticLog {
  constructor(storage, limit = 400) {
    this.storage = storage;
    this.limit = limit;
    this.entries = [];
    this.lastUpdate = null;
    try {
      const saved = JSON.parse(storage.getItem(KEY) || 'null');
      if (Array.isArray(saved?.entries)) this.entries = saved.entries
        .filter(e => typeof e.text === 'string' && typeof e.kind === 'string' && Number.isFinite(Date.parse(e.t)))
        .slice(-limit).map(e => ({ ...e, t: new Date(e.t) }));
      this.lastUpdate = saved?.lastUpdate || null;
    } catch { /* unavailable, corrupt or private storage */ }
  }

  save() {
    try {
      this.storage.setItem(KEY, JSON.stringify({ entries: this.entries, lastUpdate: this.lastUpdate }));
      this.persistent = true;
    } catch { this.persistent = false; }
  }

  add(kind, text, note = '') {
    this.entries.push({ kind, text, note, t: new Date() });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.save();
  }

  update(snapshot) { this.lastUpdate = { ...snapshot, savedAt: new Date().toISOString() }; this.save(); }
  clear() { this.entries.splice(0); this.lastUpdate = null; this.save(); }
  text() { return this.entries.map(e => `${e.t.toISOString()} ${e.kind} ${e.text}${e.note ? ' ' + e.note : ''}`).join('\n'); }
  report(context) { return { schema: 1, exportedAt: new Date().toISOString(), ...context, lastUpdate: this.lastUpdate, log: this.entries }; }
}
