// Protocol for the opt-in File122 072 firmware. No writes occur in this module.
/** Custom firmware versions that implement this door-effects protocol (072 compact, 074-077 stream mode). */
export const DOOR_FIRMWARE = ['261115-072', '261115-074', '261115-075', '261115-076', '261115-077'];
export const isDoorFirmware = software => DOOR_FIRMWARE.includes(software);
/** Versions with the ignition-off goodbye (op 5). */
export const GOODBYE_FIRMWARE = ['261115-076', '261115-077'];
export const hasGoodbye = software => GOODBYE_FIRMWARE.includes(software);
/** 077: settings saved in the box, car-signal snapshot (op 6) and a goodbye trigger signal. */
export const SAVING_FIRMWARE = ['261115-077'];
export const savesInBox = software => SAVING_FIRMWARE.includes(software);
/**
 * op 5: goodbye on/off, time per stage (rear strips, then front) in 100 ms steps, and the engine-off
 * signal [byte offset 0..63 in the box's car state, bit mask, invert]. Mask 0 = ignition rule
 * (076 ignores the signal bytes).
 */
export function goodbyeCommand(on, time, signal = [0, 0, 0]) {
  if (!Number.isInteger(time) || time < 3 || time > 50) throw new Error('Invalid goodbye time');
  if (!Array.isArray(signal) || signal.length !== 3) throw new Error('Invalid goodbye signal');
  const [offset, mask, invert] = signal;
  return doorCommand(5, [on ? 1 : 0, time, byte(offset, 63), byte(mask), byte(invert, 1)]);
}
/** op 6: snapshot of 16 bytes of the box's car state (chunk 0..3 covers 64 bytes). */
export const snapshotCommand = chunk => doorCommand(6, [byte(chunk, 3)]);
export const DOOR_EFFECTS = ['Solid', 'Blink', 'Pulse', 'Repeating wipe', 'Comet'];
const byte = (n, max = 255) => {
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error('Door-effect value out of range');
  return n;
};
export function doorCommand(op, values = []) {
  if (values.length > 5) throw new Error('Door command is too long');
  const bytes = [0x7e, 0xd7, 0x72, byte(op, 6), ...values.map(n => byte(n))];
  while (bytes.length < 9) bytes.push(0);
  bytes.push(bytes.reduce((sum, n) => sum ^ n, 0xa5));
  return bytes.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function doorConfiguration({ effect, color, brightness, period, mapping, reverse, enabled }) {
  byte(effect, 4); byte(brightness, 100); byte(reverse, 15); byte(enabled, 15);
  if (!enabled || !/^#[0-9a-f]{6}$/i.test(color) || !Number.isInteger(period) || period < 5 || period > 100) throw new Error('Invalid door-effect settings');
  if (!Array.isArray(mapping) || mapping.length !== 4 || new Set(mapping).size !== 4) throw new Error('Assign each door bit once');
  const packed = mapping.reduce((n, bit, i) => n | (byte(bit, 3) << (2 * i)), 0);
  const rgb = color.slice(1).match(/../g).map(n => parseInt(n, 16));
  return [doorCommand(1, [effect, ...rgb, brightness]), doorCommand(3, [packed, reverse, enabled, period]), doorCommand(4, [1])];
}
export function parseDoorReply(raw) {
  const text = String(raw).replace(/^<|>$/g, '');
  // S/X come from the compact 072 build; C/M/W/E/N only from the first 072 build.
  const match = /^072 ([SCMWENXD]) ([0-9A-F]+)$/.exec(text);
  if (!match) return null;
  const lengths = { S: 5, C: 5, M: 4, W: 6, E: 3, N: 4, X: 1, D: 17 };
  if (match[2].length !== lengths[match[1]] * 2) return null;
  return { kind: match[1], values: match[2].match(/../g).map(n => parseInt(n, 16)) };
}
export const DOOR_REASONS = ['Idle', 'Door effect active', 'Native lights disabled', 'Ignition is off', 'Lights are off or fading', 'A/C overlay has priority', 'Disabled', 'Preview ended'];
/** Refusal codes in <072 X code> replies (compact 072 build). */
export const DOOR_REFUSALS = { 1: 'wrong command length', 2: 'bad header or checksum', 3: 'unknown command' };
