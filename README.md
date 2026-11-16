# Ambient Lights

An independent controller for the LOMO / lmyiot car ambient-light box (sold with the "carLight" / "Car ambient light controller" app). It's a single web page that talks to the box over **Web Bluetooth**. There's no account, no server and no tracking. It makes no network requests at all, and only your saved scenes and the name prefix stay on the phone, in local storage.

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

## Firmware update (experimental)

Device → **Firmware update** uses the same procedure as the vendor app (see `carlight-protocol.md` §7). The vendor's bootloader could not be inspected, so treat it as risky:
- Use only the vendor file for your box's exact name. Device → Firmware file name shows the name; the file has to be downloaded on a computer and copied to the phone.
- Car parked, ignition on (engine running is best), phone charged, page kept in the foreground. iOS pauses background pages, which would stall the transfer.
- If it's interrupted, follow the vendor's recovery procedure: switch the car off, cut the control box's main power for about a minute (its power connector or fuse), reconnect, and tap "Retry from the start". The vendor's answer was "Update", meaning the box stays in update mode until a complete update has been installed. The app first asks for the file name. If there's no answer, it sends the update request directly and starts again from block 1.

## Not yet verified on the real box

The protocol comes from decompiled code and has only been tested against the built-in simulator. Check these on the first run:
- Whether the box sends a fresh status after each command (the app doesn't rely on it).
- Night-level vs sound-source: the vendor app reads the same status byte for both.
- Whether Effect toggle (`29xx`) is reported back 0- or 1-based.
- Mirror light and the "extra effects" may simply be unsupported on your box.

If something misbehaves, open **Device → Bluetooth log**, tap **Copy** and share it.
