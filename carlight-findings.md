# carLight.apk – security & privacy review

App `com.lomo.ambientlight` v1.81.3 (vendor LOMO / lmyiot.com). Native Android (Java/Kotlin), no native libraries.
Method: full decompilation with jadx 1.5.1 + reading the app's own code (~10k lines). Third-party libraries were identified, not audited line by line.

## Verdict
**Not spyware.** The app does not collect, store or upload personal data. It is low-quality vendor code with a few real weaknesses, mostly around firmware updates.

## What leaves your phone
Only the hidden **factory screen** (About → password `1688`) touches the internet. The normal screens make no network calls at all.

| When | Request | Data sent |
|---|---|---|
| Opening factory screen | `GET https://api.ip.sb/geoip` | Your IP (→ approximate location visible to ip.sb, a third party) |
| Starting a firmware update | `POST {"fileName": "<name reported by the controller>"}` to lmyiot.com | Only the firmware file name |

Server choice: if geo-IP says `CN` → `https://api.lmyiot.com/...`; **anywhere else (incl. Europe) → `http://fnjy.lmyiot.com/...` – plain unencrypted HTTP.**

## Permissions
BLE + location (Android requires location for BLE scanning) + internet. No camera, phone microphone, contacts, SMS, phone state, storage, accessibility. The "music" feature uses a microphone *inside the controller box* (or the car's horn signal), not the phone.

## Third-party SDKs
None for tracking/ads/analytics/crash reporting/push. Only AndroidX, Material, RxJava, OkHttp/Retrofit, Gson, fastjson, Glide, XPopup.

## Dead code (present but never called)
- A Retrofit API for a **visitor check-in system** (`/tenant/core/qlfk/...`: phone lookup, ID text recognition, login). Copied from the vendor's shared library; `getApi()` is never called and has no base URL set.
- AES / HMAC-MD5 "token" code from a **smart-lock SDK** (broadcast names `com.nokelock.y.*`). Unused – the "token" in the app is just a local *connected = true* flag.

## Real weaknesses
1. **Firmware over plain HTTP, no signature check.** Outside China the firmware image is fetched over HTTP and flashed as-is (no hash/signature in the app; the controller may or may not verify). Someone on the same network (e.g. public Wi-Fi) could in theory swap the firmware. Risk is low in practice (you must start an OTA from the hidden factory menu), but **don't run OTA updates on untrusted Wi-Fi**.
2. **No Bluetooth authentication or pairing.** Anyone in BLE range with a generic BLE app can connect to the controller and change lights, light-bar config, or start a firmware update. This is a property of the controller, not the app – your custom app can't fix it, but it's good to know.
3. Factory/debug passwords are hard-coded in the app: `1688` (factory) and `6666` (raw BLE console).
4. `BLEService` is exported without permission (Android-only, minor; it ignores binds anyway).
5. Trust-all TLS + allow-all hostname verifier in the (dead) Retrofit client.

## Also worth knowing
- The scan screen hides devices named `ZYCL-…`, `CAL-TK4…`, `BLE-LIGHT…` (other vendors' boxes) and only scans for devices advertising service `AF30`, `FFF0` or `FEE7`.
- The app auto-connects to the strongest device on first search – in a parking lot that might be someone else's car.

See `carlight-protocol.md` for the full Bluetooth protocol.
