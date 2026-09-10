// witmotion.js  (Capacitor / native BLE version)
//
// Drop-in replacement for the original browser-only witmotion.js. Same public API — connect(),
// disconnect(), the 'connected' / 'disconnected' / 'reading' events, and the same
// { ax, ay, az, gx, gy, gz, roll, pitch, yaw, t } reading shape — so ergmate.html and
// stroke-detector.js don't need to change at all.
//
// Internally this now talks to the sensor through @capacitor-community/bluetooth-le instead of
// the browser's navigator.bluetooth, since Web Bluetooth does not exist inside Capacitor's native
// WebView on iOS or Android. Packet parsing (WitMotion's 0x55-prefixed checksummed frames) is
// unchanged from the original implementation.
//
// Protocol references:
//   https://wit-motion.gitbook.io/witmotion-sdk/wit-standard-protocol/wit-standard-communication-protocol
//   https://wit-motion.gitbook.io/witmotion-sdk/ble-5.0-protocol
//
// Requires: @capacitor-community/bluetooth-le (already added to this project's package.json).

import { BleClient } from '@capacitor-community/bluetooth-le';

const DEFAULT_SERVICE_UUID = '0000ffe5-0000-1000-8000-00805f9a34fb';
const DEFAULT_NOTIFY_CHAR_UUID = '0000ffe4-0000-1000-8000-00805f9a34fb';
// Write characteristic — only needed if you later want to send config commands (e.g. change the
// output rate). Not required just to read data, so it's optional and unused by default.
const DEFAULT_WRITE_CHAR_UUID = '0000ffe9-0000-1000-8000-00805f9a34fb';

function toSignedInt16LE(lo, hi) {
  const v = (hi << 8) | lo;
  return v & 0x8000 ? v - 0x10000 : v;
}

let bleInitPromise = null;
// BleClient.initialize() should only be called once per app lifetime (it triggers the OS
// permission prompt). Every WitMotionSensor instance shares this single init.
function ensureBleInitialized() {
  if (!bleInitPromise) {
    bleInitPromise = BleClient.initialize({ androidNeverForLocation: true });
  }
  return bleInitPromise;
}

export class WitMotionSensor extends EventTarget {
  constructor(options = {}) {
    super();
    this.serviceUuid = options.serviceUuid || DEFAULT_SERVICE_UUID;
    this.notifyCharUuid = options.notifyCharUuid || DEFAULT_NOTIFY_CHAR_UUID;
    this.writeCharUuid = options.writeCharUuid || DEFAULT_WRITE_CHAR_UUID;

    this.deviceId = null;
    this.deviceName = null;
    this._connected = false;
    this._byteBuffer = [];
  }

  get connected() {
    return this._connected;
  }

  // Prompts the native device picker, connects, and starts streaming readings as 'reading'
  // events. Must be called from a user gesture (e.g. a button click), same as the original.
  async connect() {
    await ensureBleInitialized();

    const device = await BleClient.requestDevice({
      services: [this.serviceUuid],
    });

    this.deviceId = device.deviceId;
    this.deviceName = device.name || null;

    await BleClient.connect(this.deviceId, (deviceId) => {
      // onDisconnect callback — fired if the OS/peripheral drops the connection unexpectedly.
      this._connected = false;
      this.dispatchEvent(new CustomEvent('disconnected'));
    });

    await BleClient.startNotifications(
      this.deviceId,
      this.serviceUuid,
      this.notifyCharUuid,
      (value) => this._handleNotification(value)
    );

    this._connected = true;
    this.dispatchEvent(new CustomEvent('connected', { detail: { name: this.deviceName } }));
    return device;
  }

  async disconnect() {
    if (!this.deviceId) return;
    try {
      await BleClient.stopNotifications(this.deviceId, this.serviceUuid, this.notifyCharUuid);
    } catch (err) {
      // ignore — device may already be gone
    }
    try {
      await BleClient.disconnect(this.deviceId);
    } finally {
      this._connected = false;
      this.dispatchEvent(new CustomEvent('disconnected'));
    }
  }

  // value is a DataView, same as what the browser's characteristicvaluechanged event carried.
  _handleNotification(value) {
    for (let i = 0; i < value.byteLength; i++) {
      this._byteBuffer.push(value.getUint8(i));
    }
    this._drainBuffer();
  }

  // WitMotion packets are 0x55-prefixed, self-checksummed frames. BLE notifications don't always
  // line up one-to-one with packets, so bytes are buffered and scanned for valid frames; anything
  // that doesn't check out (misaligned start, torn packet) is resynced byte-by-byte.
  _drainBuffer() {
    const buf = this._byteBuffer;
    while (buf.length > 0) {
      if (buf[0] !== 0x55) {
        buf.shift();
        continue;
      }
      if (buf.length < 2) return; // wait for more data

      const type = buf[1];
      const packetLen = type === 0x61 ? 20 : 11; // 0x61 = combined accel+gyro+angle packet
      if (buf.length < packetLen) return; // wait for the rest of the packet

      const packet = buf.slice(0, packetLen);
      const sum = packet.slice(0, packetLen - 1).reduce((a, b) => (a + b) & 0xff, 0);
      if (sum !== packet[packetLen - 1]) {
        // Bad checksum — we were misaligned. Drop just the header byte and try to resync.
        buf.shift();
        continue;
      }

      buf.splice(0, packetLen);
      this._parsePacket(packet);
    }
  }

  _parsePacket(bytes) {
    const type = bytes[1];
    const body = bytes.slice(2, bytes.length - 1); // strip header/type byte and trailing checksum
    const shorts = [];
    for (let i = 0; i + 1 < body.length; i += 2) {
      shorts.push(toSignedInt16LE(body[i], body[i + 1]));
    }

    const reading = { t: performance.now() };

    if (type === 0x61 && shorts.length >= 9) {
      // Combined packet used by most current WitMotion BLE modules (BLE 5.0 / *BLECL): accel,
      // gyro, and angle in one 20-byte frame.
      const [ax, ay, az, gx, gy, gz, roll, pitch, yaw] = shorts;
      reading.ax = (ax / 32768) * 16;
      reading.ay = (ay / 32768) * 16;
      reading.az = (az / 32768) * 16;
      reading.gx = (gx / 32768) * 2000;
      reading.gy = (gy / 32768) * 2000;
      reading.gz = (gz / 32768) * 2000;
      reading.roll = (roll / 32768) * 180;
      reading.pitch = (pitch / 32768) * 180;
      reading.yaw = (yaw / 32768) * 180;
      this.dispatchEvent(new CustomEvent('reading', { detail: reading }));
    } else if (type === 0x51 && shorts.length >= 3) {
      // Older/standard-protocol modules send acceleration as its own 11-byte packet instead.
      const [ax, ay, az] = shorts;
      reading.ax = (ax / 32768) * 16;
      reading.ay = (ay / 32768) * 16;
      reading.az = (az / 32768) * 16;
      this.dispatchEvent(new CustomEvent('reading', { detail: reading }));
    }
    // Other packet types (time 0x50, gyro-only 0x52, angle-only 0x53, magnetometer 0x54, ...) are
    // ignored here since stroke detection only needs acceleration.
  }
}
