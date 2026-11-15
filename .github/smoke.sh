#!/usr/bin/env bash
# Runs inside the emulator job: installs an old build of the app, opens it, collects evidence,
# then waits to see whether it updates itself to the build that was just published.
set -u
OUT="$GITHUB_WORKSPACE/smoke-out"; mkdir -p "$OUT"
APK=android/app/build/outputs/apk/release/app-release.apk
PKG=app.setu.remote
WANT="0.1.${BUILD:-0}"
ver() { adb shell dumpsys package $PKG | grep -m1 versionName | tr -d '\r' | sed 's/.*versionName=//'; }
adb shell getprop ro.product.cpu.abilist | tee "$OUT/abis.txt"
adb logcat -c
adb install -r "$APK" 2>&1 | tee "$OUT/install.txt"
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
# What you switch on with "App updates" in the app.
adb shell appops set $PKG REQUEST_INSTALL_PACKAGES allow || true
adb shell am start -W -n $PKG/.MainActivity 2>&1 | tee "$OUT/start.txt"
sleep 10
adb exec-out screencap -p > "$OUT/01-main.png"
pid=$(adb shell pidof $PKG | tr -d '\r')
svc=$(adb shell dumpsys activity services $PKG | grep -c "SetuService" || true)
first=$(ver)
read -r W H < <(adb shell wm size | tr -d '\r' | sed -E 's/.*: ([0-9]+)x([0-9]+)/\1 \2/')
swipe() { adb shell input swipe $((W/2)) $((H*4/5)) $((W/2)) $((H/5)) 400; sleep 2; }

# Self-update: opening the app already started a check. Watch for up to 3 minutes.
updated=no
for i in $(seq 1 36); do
  v=$(ver); echo "t=$((i*5))s version=$v"
  if [ "$v" = "$WANT" ]; then updated=yes; break; fi
  if [ "$i" = 8 ]; then adb exec-out screencap -p > "$OUT/02-during-update.png"; fi
  sleep 5
done
adb exec-out screencap -p > "$OUT/03-after-wait.png"
adb shell am start -W -n $PKG/.MainActivity >/dev/null 2>&1; sleep 6
swipe; swipe; swipe; adb exec-out screencap -p > "$OUT/04-bottom.png"
adb logcat -d > "$OUT/logcat-full.txt"
grep -E "FATAL EXCEPTION|AndroidRuntime|SetuUpdate|PackageInstaller|app.setu.remote" "$OUT/logcat-full.txt" | grep -vE "AppsFilter|WindowManager|CoreBackPreview" | tail -n 250 > "$OUT/logcat.txt"
fatal=$(grep -c "FATAL EXCEPTION" "$OUT/logcat-full.txt" || true)
rm -f "$OUT/logcat-full.txt"
adb shell dumpsys package $PKG | grep -E "versionName|versionCode|targetSdk" | head -3 > "$OUT/version.txt"
echo "RESULT: pid=${pid:-none} service_lines=$svc fatal_exceptions=$fatal first_version=$first self_update=$updated want=$WANT now=$(ver)" | tee "$OUT/result.txt"
[ -n "$pid" ] && [ "$fatal" = "0" ]
