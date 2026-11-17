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

Exact behaviour, confirmed by decompiling the vendor app (`FactoryActivity`, `WLSAPI`, `BLEService`) and the controller firmware:

1. `<0DBB44>` → the box answers `<1501File122.bin>` in **plain ASCII** (not hex). `<1502>` means "update not supported".
2. `POST {"fileName":"<name after 15xx>"}` to `https://api.lmyiot.com/server/server/downloadFile` (or the non-CN `http://fnjy.lmyiot.com/server/downloadFile`) → JSON `{"status":200,"result":"<hex>"}`. The **whole decoded file** is what gets sent: plain-text header + XOR body, unchanged. The server returns the current build for that name, not necessarily the one installed. It rejects browser (CORS) requests.
3. `<0E%06d>` with the file length, e.g. `<0E231636>`. **File122's `0DBB44` path** stores the length in config key `0x184` and flag **`0x55AA22DD`** in key `0x183`, flushes config and resets. Its application path has no remembered-length equality check: both equal/different lengths reach reset in isolated execution of the exact firmware. The legacy File004 path instead uses `0x55AA44BB` and rejects equal lengths with `<1502>`; File122's alternative `0DAA55` mode also selects `0x55AA44BB`. These modes' bootloader behavior has not been inspected. The JDY BLE module is separate, allowing the connection to survive reset. See `firmware/header-analysis/REPORT.md` for instruction evidence and offline tests.
4. Bootloader `<14>` → block 0. Each `<16>` → next block. Blocks are 200 bytes (last one shorter), **one GATT write without response each** (the vendor app requests MTU 255).
5. No completion message. The vendor app closes its dialog 1 s after the last block. Our app waits 8 s, then polls `<0A01>` and checks the version reply.

Confirmed on a real JH11-2.9 box (2026-11-16): the full flow works with each 200-byte block split into ten 20-byte writes (Android 7.1.2, Chrome 112). The bootloader treats the data as a byte stream. Light settings were reset by the update.

A subsequent modified-image test succeeded on the same controller: the four-byte marker patch changed software `261115-007` to `261115-070`, confirmed by a fresh `<13...>` reply after `<0A01>`. The log shows 1,159 blocks with a final 36-byte block, consistent with the 231,636-byte image. Its complete header and encoded-body byte sum were preserved. This establishes acceptance and boot of that specific patch, not checksum enforcement or acceptance of arbitrary code changes. On 2026-11-17, an attempted 232,704-byte `071` transfer disconnected after the last visible sample at block 1001/1164; the exact last written/acknowledged block is unknown. A subsequent 231,636-byte `070` transfer completed and returned a fresh `261115-070` reply. This establishes recovery in that interruption sequence, not rejection of a complete `071`, rollback from a running `071`, or cold-power-loss recovery. Standalone filename-query intention messages during the stall lacked actual `tx` lines; the app's retained OTA lock can block those requests locally. The recovery upload's actual `<0DBB44>` query did receive `<1501File122.bin>`.

Our app implements this in Device → Firmware update (experimental). The file comes from a file picker (no network), it's checked (header, vector table at file offset 512, embedded name = the box's name, SHA-256 vs known vendor originals), and all other commands are locked out while it runs.

Later hardware success (2026-11-17): the exact `File122_door-rgb-071.bin` (232,704 bytes, SHA-256 `8e6a96bfd6426851117581a84677de5f5f122be6ffa8d660b2f0acb695fffc54`) completed all 1,164 blocks, final block 104 bytes, and answered `<0A01>` with fresh software `261115-071`. The added manual Status/Start/Stop handler executed; the user reports cyan/orange door strips with the dashboard apparently retaining its original purple. This establishes acceptance/boot of this larger executable image with a recomputed encoded-body checksum and unchanged field `0xC8`, without identifying that field or establishing general recovery guarantees. The user reports the whole upload occurred with the vehicle off. Its timestamped start-to-version span is 603.110 s; 20-byte pieces and writes without response are explicitly logged. `071` does not add automatic door warnings or a leaving effect. The observed physical sequence is strips staying lit after ignition-off, then immediately dark on opening a door; post-cutoff Bluetooth and LED relighting remain untested.

Uploader follow-up (2026-11-17): 20-byte pieces are now the default. The block sender waits for both write completion and the next-block acknowledgement; an acknowledgement received before the write promise resolves is held until that write finishes. Disconnect/cancellation invalidates the transfer and queued writes, including across reconnects. Failed writes are not blindly repeated at a different piece size. Version verification begins after the actual post-transfer `<0A01>` write attempt and compares the reply with the selected build when its date/build marker was detected. Diagnostics distinguish attempted block, fully written blocks, controller acknowledgements and accepted partial-block bytes; browser write completion does not prove controller flash programming. Timestamped logs and the latest update summary persist locally when storage is available and can be exported while disconnected. A refreshed page preserves a pending recovery lock but never resumes firmware writes automatically. These uploader changes have automated simulation/DOM-fixture coverage; their real-phone behavior still needs validation.

## 8. Experimental automatic door colors/effects (File122 072 only)

Hardware attempt (2026-11-17): the 234444-byte candidate's full hash matches the supplied file, but repeated `<0E234444>` attempts from running 071 time out without `<14>` and with zero block attempts. The user reports a restart/welcome animation. This is pre-transfer failure; 072 feature execution and acceptance are untested. The restart/wait flow was already present in the successful updater. Execution of exact 071 application instructions accepts this length and reaches reset with flag `55AA22DD`, with flash persistence/reset hardware intercepted. Bootloader length policy or another entry/notification failure remains unresolved. New app reports distinguish local request-write completion from controller readiness; `<14>` remains required before sending data. Private evidence: `firmware/header-analysis/hardware-tests/2026-11-17-072-entry-timeout/RESULT.md`.

The prepared `261115-072` build adds a separate ten-byte command format: `7E D7 72 OP A B C D E CHECK`, where CHECK is XOR of `A5` with the first nine bytes. Commands are hex-encoded within the ordinary `<...>` framing. This is new custom firmware behavior, not a vendor opcode; neither `071` nor vendor firmware implements it. `072` is offline-verified and has not been flashed. The current confirmed hardware build remains `071`.

| OP | A B C D E |
|---|---|
| `00` | All zeros: disable automatic effects and previews |
| `01` | Effect (0 solid, 1 blink, 2 pulse, 3 repeating wipe, 4 comet), R, G, B, brightness percent 0..100 |
| `02` | All zeros: read runtime status |
| `03` | Packed door mapping, reverse mask, enabled mask 1..15, cycle 5..100 units of 100ms, zero; disarms |
| `04` | `01 00 00 00 00`: arm automatic effects |
| `05` | Channel mask 1..15, duration 3..60 seconds, zero, zero, zero: timed preview |

Mapping is four distinct native raw-door indices 0..3 packed into consecutive two-bit fields for C0..C3. Default `78` is `[0,2,3,1]`; physical mapping is provisional. Reverse/enabled masks use bit n for Cn. Color/mapping/arm are separate commands; Apply queues all three. Preview uses the last applied settings. Settings live in RAM, disabled by restart, ordinary power-off, Door effect OFF, firmware-name query or OTA entry. Native welcome, A/C activity, disabled lighting and ignition-off pause custom rendering. There are no new persistent keys or CAN writes.

ASCII replies `<072 KIND HEXBYTES>` use S (armed, ignition, raw doors, active channels, reason), C (effect/R/G/B/brightness), M (mapping/reverse/enabled/period), W (native light-enable/ignition-follow/boot-welcome/welcome-state/A/C/encoder-state), N (four-byte big-endian custom queue count) and E (ignition/raw doors/reason on change). Reasons 0..7: idle, active, native lights disabled, ignition off, native welcome, A/C, disabled, preview ended. These are controller observations and queue counts, not RF reception acknowledgements.

The feature replaces individual native packet opportunities with bounded C0..C3 RGB/RLE frames, leaving alternating due opportunities native; it never queues an original followed immediately by a custom frame into the same single-slot buffer. Only controlled open-door warning bits are suppressed in even control footers, respecting existing swaps. Close/Disable schedules one flat RGB hand-back from the latest native normal-color footer. Arbitrary effect restoration, receiver acceptance/priority outside native welcome, and physical mapping remain hardware-test items. No leaving animation is added. The private package guide is `firmware/test-builds/File122-door-effects-072/README.md`; `js/door-effects.js` implements the app-side command/reply format.
