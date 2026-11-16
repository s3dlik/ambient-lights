# LOMO car ambient light – BLE protocol

Reconstructed from carLight.apk v1.81.3. Items marked (?) are uncertain from code alone and should be confirmed on the real device.

## 1. Transport

| | |
|---|---|
| Discovery | Device advertises service **0xAF30, 0xFFF0 or 0xFEE7** |
| GATT service | `0000FFE0-0000-1000-8000-00805F9B34FB` |
| Write (phone → box) | `FFE2`, write **without response** |
| Notify (box → phone) | `FFE1` (enable via CCCD 0x2902) |
| MTU | app requests 255 (only needed for OTA's 200-byte chunks) |
| Auth / encryption | **none** |

## 2. Framing

Commands are an **ASCII hex string wrapped in `<` `>`**:

```
command "0701"  →  bytes  3C 30 37 30 31 3E   ("<0701>")
```

Replies come the same way on FFE1: `<HEX…>`. Decode the ASCII hex to bytes; byte `[0]` is the reply opcode. Several frames may arrive in one notification (`…><…`). The app doesn't reassemble frames across notifications; a robust client should buffer until `>`.

Parameter encoding varies per command, so watch out:
- `%02x` → hex byte (lowercase in the app; firmware probably case-insensitive (?))
- `%02d` / `%04d` / `%06d` → **decimal digits written into the hex string = BCD** (60 s → `5A60`, 150 lamps → `1C0150`)

## 3. Session

1. Connect, discover FFE0, enable notify on FFE1.
2. Wait ~1 s, send `<0A01>` → box replies with status (`12`/`1F`/`4E`/`5A`), settings (`26`), colours (`27`), version (`13`) etc.
3. The status opcode tells you the device generation: `12` → mode 0 (legacy), `1F` → 1, `4E` → 2, `5A` → 3. Feature lists differ per generation.

## 4. Everyday commands

### Power & brightness
| Command | Meaning |
|---|---|
| `0700` / `0701` / `0702` | Lights OFF / ON / AUTO (follow car) |
| `0200` + `%02x` (0–9) | Global brightness |
| `0101` + `%02x` (0–9) | Zone 1 brightness (doors) |
| `0102` + `%02x` (0–9) | Zone 2 brightness (footwell) |
| `1400` / `1401` | Zone layout: up/down vs front/back |
| `1A` + `00`/`01` + `%02d` level 1–5 | Night brightness reduction off/on + level |
| `5100` / `5101` | Control: car + phone / phone only |

### Static colour
| Command | Meaning |
|---|---|
| `06` + RR GG BB | Colour, all zones (e.g. `06ff4000`) |
| `10` + RR GG BB | Colour, zone 1 |
| `09` + RR GG BB | Colour, zone 2 |

The app sends a frame on every finger move of the colour bar, with no throttling. Your app should throttle to ~20–30 Hz.

### Effect modes – "RGB" tab, gen ≥1 (`04xx`)
| Code | Effect | Code | Effect |
|---|---|---|---|
| 0400 | Single – single | 040B | Gradient – random |
| 0401 | Single – colourful | 040C | Strobe – colourful |
| 0402 | Single – random | 040D | Strobe – R&G&B |
| 0403 | Breathe – single | 040E | Strobe – C&Y&P |
| 0404 | Breathe – colourful | 040F | Rhythm (music) – colourful |
| 0405 | Breathe – random | 0410 | Rhythm – R&Y&P |
| 0406 | Gradient – colourful | 0411 | Rhythm – C&Y&P |
| 0407 | Gradient – C&Y&P | 0412 | Motion – B&R |
| 0408 | Gradient – R&Y&P | 0413 | Motion – R&G |
| 0409 | Gradient – R&B | 0414 | Motion – R&C |
| 040A | Gradient – G&B | | |

Legacy (gen 0): `0800` single, `0802` breathe, `0803` gradient, `0806` strobe, `0804` auto, `0801` rhythm.

### Custom colour sequence (RGB tab)
| Command | Meaning |
|---|---|
| `2B01` / `2B00` | Custom sequence on/off |
| `2A` + 8 nibbles | 8 slots, each a palette index 0–e, `f` = empty |
| `2AFFFFFFFF` | Clear |
| `3E` + `%02x` (1–10) | Custom speed |

**Palette:** 0 ff0000, 1 ff4000, 2 ffff00, 3 00ff00, 4 46ffff, 5 0000ff, 6 8b00ff, 7 ff0020, 8 ff00ff, 9 ffffff, a 00ff80, b 51ffae, c ff2c40, d c1ff98, e 596eff, f empty.

### "Symphony" (addressable / flowing light bars)
| Command | Meaning |
|---|---|
| `1E` + mode | Flow effect (table below) |
| `0B` + `%02x` (1–5) | Speed |
| `0C00` / `0C01` | Direction forward / reverse |
| `28` + `%02x` (0–7) | Common effects: Ambilight, R&B Ambilight, R&P Ambilight, Colourful Tail, Colour Water, Sport Bar, Colourful Music, Sport Music |
| `29` + `01`–`06` | Effect toggle |
| `3B01` / `3B00` | Custom palette on/off |
| `3A` + 8 nibbles / `3AFFFFFFFF` | Custom palette / clear |
| `3C` + `%02x` (1–10) | Custom length |
| `3D` + `%02x` (0–9) | Custom interval |
| `1100`–`1105` | Legacy gen 0: Sync RGB, Illusion, Rhythm, Colourful, Dazzle, Light |

`1E` modes: 00 Illusion, 01 Light, 02 Breathe · 03 Streamer, 04 Closing, 05 Optical, 06 Pull Curtain, 07 Closing, 08 Piled Up, 09 CTL, 0A Magic, 0B Meteor · 0C/0D Tail colourful, 0E Tail single · 0F Spectrum, 10 Stretch, 11 Optical, 12 Snap-in, 13 Beam, 14 Single (music) · 15 Stretch, 16 Snap-in, 17 R&B (motion) · 18 Sync RGB · gen 2+: 19 table tennis, 1A stack, 1B group · gen 3: 1C Follow, 1D Phantom, 1E Colourful (water ripple).

### Settings / car integration
| Command | Meaning |
|---|---|
| `0300` + `%02x` (0–9) | Mic sensitivity |
| `1B00` / `1B01` | Music source: box mic / car horn |
| `3001`/`3000` | Welcome light on/off |
| `3900`–`3905` | Welcome mode: centre, door, door+return, 4-door sync 1/2/3 |
| `38` + `%02x` (00–0e) / `380F` | Welcome colour (palette) / follow RGB |
| `3101`/`3100` | Door-open effect |
| `3201`/`3200` | Parking-radar effect |
| `3301`/`3300` | Speed effect |
| `3401`/`3400` | Turn-signal effect |
| `3501`/`3500` | A/C-linked colour |
| `4401`/`4400` | Blind-spot lighting |
| `46` + `00`–`03` | Door warning colour: red, yellow, purple, blue |
| `45` + `00`–`03` | Turn colour: same |
| `47` + `00`/`01` | Blind-spot colour: red, yellow |
| `59` + `00`/`01`/`02` | Mirror welcome light off/on/auto |
| `5A`/`5B`/`5C`/`5D` + `%02d` (0–60 s, BCD) | Mirror light delay on unlock / door / turn / reverse |
| `4200` | Reset |

## 5. Replies

| Opcode | Content |
|---|---|
| `12`/`1F`/`4E`/`5A` status | [1] RGB mode, [2] symphony mode, [3] power 0/1/2, [4–6] colour zone 1, [7–9] colour zone 2, [10] bri zone 1, [11] bri zone 2, [12] mic sens, [13] symphony speed, [14] direction, [15] global bri (gen ≥1), [16] custom speed, [17] control method (gen 2) |
| `13` version | [1–5] HW version, [6–13] car/customer name, [14–23] SW version (ASCII) |
| `26` settings | [1] welcome, [2] door, [3] radar, [4] speed, [5] turn, [6] A/C (1 = on), [7] night halving, [8] zone layout, [9] welcome mode, [10] welcome colour (high nibble 1 = sync-RGB supported; low nibble palette, F = sync), [11] sound source / night level (?), [12] app type, [13] blind spot |
| `27` colours | [1–4] RGB custom slots, [5] RGB custom on, [6–9] symphony palette, [10] symphony custom on, [11] length, [12] interval, [13] common effect, [14] custom speed (?), [15] effect toggle |
| `56` mirror light | [1] mode, [2–5] delays (BCD) |
| `19` | Feature not supported |
| `2E` | Result: 0 unsupported, 1 OK, 2 fail, 3 needs light wire/sensor, 4 needs CAN/sensor |

## 6. Installer / factory commands (avoid unless you know your wiring)

`2101`/`2100` enter/exit factory mode · `20`+16 bit chars DIP switches · `1C`/`0F`/`13`/`1D`/`52` + `%04d` lamp counts (driver, passenger, front doors, rear doors, 3rd row) · `2C`/`2F`/`23`/`2D`/`48`–`4B`/`53`/`54` + `00`/`01` wiring directions · `4C01`/`4C00` test display · `4D0055xx` door swap · `40%04d` light parameter preset · `43…` customer code · `4100` original-car-light flash · `22xx` key learning · `5000AA`/`5000BB` debug output on/off.

## 7. Firmware update (OTA) – do NOT implement casually

`<0DBB44>` → box replies `15xx<filename>` → app downloads hex from lmyiot.com → `<0E%06d(len)>` → box `<14>` → app sends **raw 200-byte binary chunks** (no framing/CRC), one per `<16>` ack. A bad image or interrupted transfer could brick the controller.
