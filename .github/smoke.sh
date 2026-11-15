#!/usr/bin/env bash
# Runs inside the emulator job: installs the app, opens it, and collects evidence.
set -u
OUT="$GITHUB_WORKSPACE/smoke-out"; mkdir -p "$OUT"
APK=android/app/build/outputs/apk/debug/app-debug.apk
PKG=app.setu.remote
adb logcat -c
adb install -r "$APK" 2>&1 | tee "$OUT/install.txt"
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
adb shell am start -W -n $PKG/.MainActivity 2>&1 | tee "$OUT/start.txt"
sleep 12
adb exec-out screencap -p > "$OUT/01-main.png"
# Scroll down to the permission list and the version line (coordinates relative to the screen size).
read -r W H < <(adb shell wm size | tr -d '\r' | sed -E 's/.*: ([0-9]+)x([0-9]+)/\1 \2/')
swipe() { adb shell input swipe $((W/2)) $((H*4/5)) $((W/2)) $((H/5)) 400; sleep 2; }
swipe; adb exec-out screencap -p > "$OUT/02-permissions.png"
swipe; swipe; adb exec-out screencap -p > "$OUT/03-bottom.png"
pid=$(adb shell pidof $PKG | tr -d '\r')
svc=$(adb shell dumpsys activity services $PKG | grep -c "SetuService" || true)
adb logcat -d > "$OUT/logcat-full.txt"
grep -E "FATAL EXCEPTION|AndroidRuntime|SetuUpdate|Setu|app.setu.remote" "$OUT/logcat-full.txt" | tail -n 300 > "$OUT/logcat.txt"
fatal=$(grep -c "FATAL EXCEPTION" "$OUT/logcat-full.txt" || true)
rm -f "$OUT/logcat-full.txt"
adb shell dumpsys package $PKG | grep -E "versionName|versionCode|targetSdk" | head -3 > "$OUT/version.txt"
echo "RESULT: pid=${pid:-none} service_lines=$svc fatal_exceptions=$fatal" | tee "$OUT/result.txt"
[ -n "$pid" ] && [ "$fatal" = "0" ]
