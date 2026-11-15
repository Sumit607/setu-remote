# Setu Remote

Personal remote control between one Windows laptop and one Android phone: see and control either screen from the other, move files and photos both ways, read and send texts, reply to chat notifications, share the clipboard. Works on the same Wi-Fi and over the internet.

| Folder | What it is |
|---|---|
| `desktop/` | Windows app (Electron). Also contains the phone-side "control laptop" web screen and the test suite. |
| `android/` | Android app (Kotlin). |
| `protocol/PROTOCOL.md` | The wire protocol both sides implement. |
| `.github/workflows/` | Builds the APK and the Windows installer on GitHub and publishes them. |
| `site/` | The small download page (`/apk`, `/pc`). |

## Status

- **Windows app + phone web controller:** 25-step automated end-to-end suite passes on Linux (`npm test` in `desktop/`). Not yet run on a real Windows machine; the `test-on-windows` CI job runs the same suite there.
- **Android app:** type-checks against the Android 15 SDK and the real WebRTC library sources. Not yet built into an APK or run on a phone.
- **Internet path:** the relay protocol is verified against the live Supabase project; an end-to-end session over mobile data has not been tried yet. Some mobile networks will need a TURN server (Settings → Cloudflare TURN).

## Get the apps

- Phone: https://github.com/Sumit607/setu-remote/releases/download/android/SetuRemote.apk
- Windows: https://github.com/Sumit607/setu-remote/releases/download/windows/SetuRemote-Setup.exe

Both links always serve the newest build, and both apps update themselves from the same place: the phone app checks `android.json`, the Windows app checks `latest.yml`.

## Build

Every push to `main` runs `.github/workflows/build.yml`, which builds both apps and replaces the files in the `android` and `windows` releases. The build number is the workflow run number, so each build is newer than the last (`0.1.<run>`).

The APK is only published when the repository secret `SETU_SIGNING` is set (`<keystore password>:<base64 of the keystore>`). Every build must be signed with the same key, or Android refuses the update. The key is deliberately not in this repository.

Locally on Windows: `cd desktop && npm ci && npm start` (run) or `npm run dist` (installer).

## Install on the phone (vivo V60, from the laptop, no cable)

Android blocks browser/chat installs of apps that ask for Accessibility, SMS and notification access, so install with adb:

1. Phone: Settings → About phone → Software information → tap **Build number** 7 times.
2. Phone: Settings → System → Developer options → turn on **Wireless debugging** and **Install via USB**.
3. Laptop and phone on the same Wi-Fi. In Wireless debugging tap **Pair device with pairing code**.
4. Laptop (PowerShell, with [platform-tools](https://developer.android.com/tools/releases/platform-tools) unzipped):

       .\adb pair <ip>:<pair-port>      # type the 6-digit code
       .\adb connect <ip>:<port>        # the port shown on the main Wireless debugging screen
       .\adb install -r SetuRemote.apk

After this first install the app updates itself; turn on **App updates** in its permission list.

## First run

1. Open Setu Remote on the laptop → **Pair a phone** → a QR code appears.
2. Open Setu Remote on the phone → **Pair by QR**.
3. On the phone, work down the permission list (all files, SMS, notification access, accessibility for control, battery: no restrictions, and on vivo: Autostart).
4. Android asks "Start recording or casting?" each time the laptop starts viewing the phone. That prompt cannot be removed.
