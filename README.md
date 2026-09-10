# ErgMate — Capacitor project

Native iOS + Android wrapper for the ErgMate web app, built with [Capacitor](https://capacitorjs.com).

## What changed from the original web app

The original `witmotion.js` used the browser's **Web Bluetooth API**
(`navigator.bluetooth`), which does not exist in Capacitor's native WebView on either
iOS or Android — it only works in desktop Chrome/Edge.

To get real sensor support natively, `witmotion.js` was rewritten to use
[`@capacitor-community/bluetooth-le`](https://github.com/capacitor-community/bluetooth-le)
instead. The public API is unchanged — same `connect()` / `disconnect()` methods, same
`'connected'` / `'disconnected'` / `'reading'` events, same reading shape
(`{ ax, ay, az, gx, gy, gz, roll, pitch, yaw, t }`) — so **`index.html` and
`stroke-detector.js` did not need any changes.**

Everything else (the PCA-based stroke detector, the UI, the timer/pace logic) is
identical to your original files.

## Project layout

```
ergmate-capacitor/
├── src/witmotion.js       ← BLE source (imports @capacitor-community/bluetooth-le)
├── www/                   ← final web assets Capacitor packages into the app
│   ├── index.html          (was ergmate.html)
│   ├── stroke-detector.js  (unchanged)
│   └── witmotion.js        (BUILT from src/witmotion.js — do not hand-edit this file)
├── android/                ← native Android project (open in Android Studio)
├── ios/                    ← native iOS project (open in Xcode)
├── capacitor.config.ts
└── package.json
```

**Important:** `www/witmotion.js` is a generated bundle (it inlines the
`@capacitor-community/bluetooth-le` package so the browser/WebView can load it directly).
If you ever need to modify the BLE logic, edit `src/witmotion.js`, then rebuild with:

```bash
npm run build:sensor
```

## Permissions already configured

- **iOS** (`ios/App/App/Info.plist`): `NSBluetoothAlwaysUsageDescription` and
  `NSBluetoothPeripheralUsageDescription` added — required or the app will crash when it
  requests Bluetooth access.
- **Android** (`android/app/src/main/AndroidManifest.xml`): the plugin's own manifest
  (`BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, legacy `BLUETOOTH`/`BLUETOOTH_ADMIN`, and
  location permissions for older Android versions) is auto-merged by Gradle — no manual
  edits needed.

## First-time setup

```bash
npm install
```

(Already run — `node_modules` isn't included in what you download, so run this first.)

## Making changes and re-syncing

Whenever you edit anything in `www/` (except `witmotion.js`, see above) or change npm
packages/plugins, re-sync the native projects:

```bash
npm run sync
```

This rebuilds the sensor bundle and runs `npx cap sync`, which copies `www/` into both
native projects and updates their native plugin dependencies.

## Running on Android

Requires [Android Studio](https://developer.android.com/studio) with an SDK installed.

```bash
npx cap open android
```

This opens the project in Android Studio. Pick a device/emulator and hit Run. (BLE
scanning requires a real device or an emulator with Bluetooth support — most emulators
don't support BLE, so a physical Android phone is recommended for testing the sensor.)

## Running on iOS

Requires a Mac with [Xcode](https://developer.apple.com/xcode/) installed, plus CocoaPods
(`sudo gem install cocoapods` if you don't have it).

```bash
cd ios/App
pod install
cd ../..
npx cap open ios
```

This opens the project in Xcode. Pick your connected iPhone (BLE doesn't work in the iOS
Simulator — a physical device is required for testing the sensor) and hit Run. You'll
need an Apple Developer account signed into Xcode to deploy to your own device.

## Notes / things worth double-checking

- The WitMotion GATT service/characteristic UUIDs are the WT901BLE/BWT901BLE defaults.
  If your specific module uses different UUIDs, pass overrides when constructing the
  sensor in `index.html`'s bottom `<script type="module">` block (same as the original):
  `new WitMotionSensor({ serviceUuid: '...', notifyCharUuid: '...' })`.
- `androidNeverForLocation: true` is passed to `BleClient.initialize()` since this app
  only scans by service UUID and never uses BLE scan results to infer location — this
  avoids Android asking for location permission on newer Android versions. If you add
  scanning by device name/RSSI in the future, revisit this.
- The app ID is currently `com.ergmate.app` and the display name is `ErgMate`
  (set in `capacitor.config.ts`, and mirrored into the native projects). Change these
  before publishing if you want something else.
