# Ambient Lights

An independent controller for the LOMO / lmyiot car ambient-light box (sold with the "carLight" / "Car ambient light controller" app). It's a single web page that talks to the box over **Web Bluetooth**. There's no account, no server and no tracking. It makes no network requests at all. Scenes, connection preferences and recent Bluetooth diagnostics stay on the phone, in local storage when available.

The protocol was reconstructed from the vendor Android app (v1.81.3); see [carlight-protocol.md](carlight-protocol.md). The security review is in [carlight-findings.md](carlight-findings.md).

## Use it on iPhone

Safari doesn't support Bluetooth, so use the free **Bluefy – Web BLE Browser** from the App Store.

1. Host the folder somewhere with HTTPS (see below). Web Bluetooth only works on `https://` or `localhost`.
2. Fully close the official app. The box accepts only one Bluetooth connection.
3. Open the URL in Bluefy, then tap **Connect to controller** and pick `ATW-FWD-65E1`.
4. Optional: add the page to Bluefy's bookmarks.

On a computer or Android phone, Chrome and Edge work directly.

**Try it without the car:** tap **Try the demo**, or open `…/index.html?demo`. The demo box uses the values from your screenshots.

## Hosting (pick one)

| Option | Steps |
|---|---|
| **GitHub Pages** (free, permanent) | Push this folder to a GitHub repo, then go to Settings → Pages → *Deploy from branch* → `main` / root. The URL is `https://<user>.github.io/<repo>/`. |
| **Netlify Drop** | Drag this folder onto app.netlify.com/drop. |
| **Cloudflare Pages** | Upload the folder as a direct-upload project. |

No build step is needed: it's plain HTML, CSS and JS modules.

Local development:

```bash
npm run serve
```

Then open http://localhost:8080 in Chrome. Bluetooth works on localhost if your PC has it.

```bash
npm test
```

This runs the protocol unit tests (Node 18+).

## What's in it

| Tab | Controls |
|---|---|
| **RGB** | Door and footwell RGB lights: colour wheel per zone (All / Zone 1 / Zone 2), common colours, 21 RGB effects, custom 8-colour sequence + speed, **Scenes** (saved favourites) |
| **Light bars** | Addressable "magic" strips: all effects for your box generation (incl. Stack and ping-pong), speed, direction, effect variants 01–06, custom colours, length, interval, extra "common effects" the iOS app hides |
| **Light** | Power OFF / ON / AUTO, brightness (all, zone 1, zone 2), zone layout, night dimming, control mode |
| **Car** | Reactions to door / parking radar / speed / steering / A/C / blind spot, warning colours, welcome light, music mic and sound source, mirror welcome light (if fitted), **Explore hidden effects** (event watcher + safe probing of values the official app never sends, with restore and a results log) |
| **Device** | Version info, **installer settings** (read-only by default), Bluetooth log, raw command console |

Improvements over the official app:
- The colour wheel is throttled and coalesced, so dragging it can't flood the box.
- Scenes are saved on the phone.
- The installer menu shows a backup of your values before you change anything.
- Changes are written only after a confirmation that lists old → new values.
- Firmware update is opt-in and heavily guarded (Device → Firmware update). The app never downloads anything: you pick the file yourself. It checks the file and refuses unless the box reports the same file name, and nothing else is sent while it runs.

## Installer settings ("Factory Setting", PIN 1688 in the official app)

Reading them is safe. To change anything, tick **Allow changes**; each write then asks for confirmation.

- **Dial.** Two rows of virtual DIP switches stored in the box. The firmware decides their meaning, and neither the app nor the vendor documents it. The Model dial most likely selects the car profile: which car's CAN-bus signals to read (doors, turn signals, speed, radar, A/C) and the light-bar layout. The Function dial toggles options. Your box's values are Model = switches 1, 3, 4, 6, 7 ON and Function = switch 8 ON (`10110110 / 00000001`). **Leave these alone unless you have the installer manual.**
- **Light bar layout.** LED count per strip and the end where the cable enters. Your box: driver side 20 (right out), passenger side 114 (left out), front doors 60, rear doors 65, all doors "front out".
- **Test / door swap.** These are the vendor's wiring-check and door-colour reorder tools.

Deliberately **not** included: key learning, light-parameter import, customer-code import and "original car lights" flashing. The raw console blocks those commands and the firmware-update opcodes (`0D`/`0E`).

## Custom door colors and effects (072)

The local app adds **Device → Custom door colors and effects (072)**: an RGB picker, solid/blink/pulse/repeating wipe/comet, brightness, cycle, channel mapping/direction, timed previews, Disable and runtime status. These controls require a fresh `261115-072` reply on the current connection and are locked during OTA. Preferences stay on the phone; controller settings are held in RAM and start disabled after a restart. Apply explicitly to enable them again.

The new File122 `072` firmware is an opt-in hardware-test build following the successful `071` manual RGB test. It uses native door signals to select custom strip packets, pauses for native welcome/A/C activity, and sends a flat native-color hand-back on close/Disable. Receiver priority outside native welcome, physical mapping and exact restoration of dynamic effects still need car testing. `072` has **not** been flashed; the latest confirmed installed build is `071`. It does not add a leaving animation. The local private guide and binary are under `firmware/test-builds/File122-door-effects-072/`; vendor firmware remains excluded from Git. The guide includes commands usable through the existing app's console before publishing the new panel.

## Firmware update (experimental)

Device → **Firmware update** uses the same procedure as the vendor app (see `carlight-protocol.md` §7).

The updater defaults to 20-byte pieces. It records the selected file's full SHA-256, browser/write mode, block-write and controller-acknowledgement counters, partial-block write progress, and page visibility changes. A write error stops the transfer; it never retries a potentially partial block automatically at a different size. Fast acknowledgements wait for the pending write to finish, and cancelled or disconnected transfers cannot continue writing through a new connection. A fresh version reply must match the selected file's detected build when that build is available.

**Bluetooth log** and the update recovery card also appear on the disconnected connection screen. Copy includes timestamps; **Save report** downloads a JSON report with the latest 400 log entries and update summary. The report contains browser/device/version information but no firmware bytes. Browser storage preserves this evidence across refreshes when available. A refresh restores a pending recovery lock, never resumes an upload automatically, and requires re-selecting the file before an explicit retry. The standalone filename action reports when a query is blocked locally.

**Tested on the real box (2026-11-16):**
- File122.bin (V6.30, 2026-11-15) installed successfully from an Android 7.1.2 phone (Chrome 112), with **Block writes = 20-byte pieces**.
- The bootloader accepts the blocks split into small packets.
- The update **reset the light settings**, which had to be set up again. Back up first.
- A subsequent marker-only custom File122 update also succeeded: a fresh Bluetooth reply confirmed **`261115-007` → `261115-070`**. The user reported no breakage. This verifies that specific same-size, checksum-preserving modification. On 2026-11-17, a larger `071` attempt disconnected before visible completion; reinstalling `070` succeeded with a fresh version reply and normal operation reported. This demonstrates recovery from that interruption; rejected-image recovery and rollback from a running `071` remain untested.
- A later complete upload of the **232,704-byte executable `071` image succeeded**, with a full matching file hash and fresh **`261115-071`** reply. The added Status/Start/Stop commands responded, and the user reports cyan/orange door strips while the dashboard appeared to retain purple. The entire upload was reported to occur with the vehicle off; the timestamped log spans about 10 min 3 s from start to fresh version, using 20-byte pieces and writes without response. This establishes that specific custom executable image and manual RGB experiment. Automatic individual-door effects and a leaving animation are not implemented by `071`.
- On older Android phones, start with 20-byte pieces. On iPhone, the vendor says "change your phone".

The vendor's bootloader could not be inspected, so it still carries some risk:
- Use the vendor file for your box's exact name, or the explicitly prepared custom test build for that same controller. Device → Firmware file name shows the name; copy the selected file to the phone.
- Car parked, controller power maintained throughout the update, phone charged, page kept in the foreground. Ignition on is a precaution against power loss, not a protocol requirement: the user completed the `070` recovery with ignition off. Whether the controller stays powered depends on its installation and sleep behavior; switching on the radio alone does not establish this. iOS pauses background pages, which would stall the transfer.
- If it's interrupted, follow the vendor's recovery procedure: switch the car off, cut the control box's main power for about a minute (its power connector or fuse), reconnect, and tap "Retry from the start". The vendor's answer was "Update", meaning the box stays in update mode until a complete update has been installed. The app first asks for the file name. If there's no answer, it sends the update request directly and starts again from block 1.

## Not yet verified on the real box

Many individual controls still rely on decompiled code and simulator checks. Check these on the first run:
- Whether the box sends a fresh status after each command (the app doesn't rely on it).
- Night-level vs sound-source: the vendor app reads the same status byte for both.
- Whether Effect toggle (`29xx`) is reported back 0- or 1-based.
- Mirror light and the "extra effects" may simply be unsupported on your box.

If something misbehaves, open **Bluetooth log** under Device or on the disconnected connection screen, then use **Copy** or **Save report**.
