// Protocol for the opt-in File122 072 firmware. No writes occur in this module.
export const DOOR_EFFECTS = ['Solid', 'Blink', 'Pulse', 'Repeating wipe', 'Comet'];
const byte = (n, max = 255) => {
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error('Door-effect value out of range');
  return n;
};
export function doorCommand(op, values = []) {
  if (values.length > 5) throw new Error('Door command is too long');
  const bytes = [0x7e, 0xd7, 0x72, byte(op, 5), ...values.map(n => byte(n))];
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
  const match = /^072 ([SCMWEN]) ([0-9A-F]+)$/.exec(text);
  if (!match) return null;
  const lengths = { S: 5, C: 5, M: 4, W: 6, E: 3, N: 4 };
  if (match[2].length !== lengths[match[1]] * 2) return null;
  return { kind: match[1], values: match[2].match(/../g).map(n => parseInt(n, 16)) };
}
export const DOOR_REASONS = ['Idle', 'Door effect active', 'Native lights disabled', 'Ignition is off', 'Native welcome has priority', 'A/C overlay has priority', 'Disabled', 'Preview ended'];
