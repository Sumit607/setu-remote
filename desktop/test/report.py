#!/usr/bin/env python3
"""Builds one self-contained HTML page from test-report/ (results.json + screenshots)."""
import base64, html, json, pathlib, sys
root = pathlib.Path(__file__).resolve().parents[2]
rep = root / 'test-report'
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'Setu-Remote-test-report.html'
r = json.loads((rep / 'results.json').read_text())
img = lambda n: 'data:image/png;base64,' + base64.b64encode((rep / n).read_bytes()).decode()
e = html.escape

status = [
 ('Windows app', 'All 25 checks below, driving the real app on a Linux virtual display. The packaged Windows bundle also starts and serves the phone screen.',
  'It has not run on Windows yet. Mouse and keyboard control and screen capture use Windows-only code paths that only your laptop (or the Windows job on GitHub) can exercise.'),
 ('Phone screen for controlling the laptop', 'Tested in Chrome set up as a vivo V60, both as a web page and in the mode the Android app embeds.',
  'Not yet opened inside the Android app itself.'),
 ('Android app', 'The code passes the Kotlin compiler against the Android 15 SDK and the WebRTC library (three smaller libraries were stood in for). Its encryption matches the PC side byte for byte.',
  'It has never been built into an APK or run on a phone. In checks 2 to 14 the "phone" is a simulator that speaks the same protocol, not this app.'),
 ('Internet connection', 'Joining, sending and receiving verified against the live relay (Supabase, Mumbai).',
  'A full session over mobile data has not been tried. Some mobile networks will need a TURN server added in Settings.'),
]
shots = [
 ('pc', '02-pair-dialog.png', 'Pairing. The laptop shows a QR code; the phone scans it once.'),
 ('pc', '03-devices.png', 'Devices. Phone status, battery, storage and unread counts.'),
 ('pc', '04-phone-files.png', 'Phone files. Browse the phone, preview photos, copy either way.'),
 ('pc', '05-transfer-progress.png', 'A 40 MB file coming from the phone. The copy matched the original exactly.'),
 ('pc', '06-messages.png', 'Messages. Text threads, plus chat notifications you can reply to.'),
 ('pc', '07-photos.png', 'Photos. Import new photos into dated folders; already imported ones are skipped.'),
 ('pc', '08-phone-screen.png', 'Phone screen on the laptop (simulated phone). Click to tap, drag to swipe, type to type.'),
 ('ph', '09-web-home.png', 'On the phone: home screen of the laptop controller.'),
 ('ph', '10-web-remote.png', 'On the phone: the laptop screen, with touchpad and touch modes and a key row.'),
 ('ph', '16-app-embedded-control.png', "On the phone: the same screen in the mode the Android app opens directly."),
 ('ph', '13-web-files.png', 'On the phone: browsing laptop files.'),
 ('pc', '12-desktop-during-control.png', 'The laptop while the phone controls it. The yellow bar stays on top with a Stop button.'),
 ('pc', '14-history.png', 'History of sessions and transfers.'),
 ('pc', '15-settings.png', 'Settings.'),
]
rows = ''.join(f'<tr><td class="n">{i}</td><td>{e(x["name"])}{"<span>" + e(x["note"]) + "</span>" if x["note"] else ""}</td><td class="{"ok" if x["ok"] else "bad"}">{"Passed" if x["ok"] else "Failed"}</td></tr>' for i, x in enumerate(r['results'], 1))
st = ''.join(f'<tr><th>{e(a)}</th><td>{e(b)}</td><td>{e(c)}</td></tr>' for a, b, c in status)
gal = ''.join(f'<figure class="{k}"><img alt="{e(c)}" src="{img(n)}"><figcaption>{e(c)}</figcaption></figure>' for k, n, c in shots)
page = f'''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setu Remote test report</title><style>
:root{{--ink:#14262b;--mute:#566a70;--paper:#f4f6f7;--card:#fff;--line:#dfe5e7;--peacock:#0e6b74;--ok:#1b7f52;--bad:#b3261e;--gold:#f2a20c}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Mukta,"Segoe UI",system-ui,-apple-system,Roboto,sans-serif}}
main{{max-width:1060px;margin:0 auto;padding:48px 24px 80px}}
h1{{font-size:34px;line-height:1.15;margin:0 0 10px;letter-spacing:-.01em}}h2{{font-size:21px;margin:52px 0 14px}}
.lead{{font-size:18px;color:var(--mute);max-width:66ch;margin:0}}
.sum{{display:flex;gap:28px;align-items:baseline;margin:28px 0 0;padding:18px 22px;background:var(--card);border:1px solid var(--line);border-left:5px solid var(--ok);border-radius:10px}}
.sum b{{font-size:30px;color:var(--ok);white-space:nowrap}}.sum span{{color:var(--mute)}}
table{{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}}
th,td{{text-align:left;vertical-align:top;padding:11px 16px;border-top:1px solid var(--line)}}tr:first-child>*{{border-top:0}}
thead th{{background:#e9eef0;font-weight:600;font-size:14px;color:var(--mute)}}tbody th{{font-weight:600;width:19%}}
.checks td.n{{width:44px;color:var(--mute);font-variant-numeric:tabular-nums}}.checks td span{{display:block;color:var(--mute);font-size:14px}}
.ok{{color:var(--ok);font-weight:600;white-space:nowrap}}.bad{{color:var(--bad);font-weight:600}}
.gal{{display:grid;grid-template-columns:1fr 1fr;gap:22px}}figure{{margin:0}}figure.pc{{grid-column:1/-1}}
img{{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:#fff}}figcaption{{font-size:14.5px;color:var(--mute);margin-top:8px}}
.note{{background:#fff8e6;border:1px solid #f1dca6;border-radius:10px;padding:14px 18px;margin-top:16px}}
@media(max-width:720px){{.gal{{grid-template-columns:1fr}}h1{{font-size:27px}}thead{{display:none}}.status tr,.status th,.status td{{display:block;width:auto}}.status td{{border-top:0;padding-top:0}}}}
</style></head><body><main>
<h1>Setu Remote test report</h1>
<p class="lead">What was built, what was actually run, and what still needs your laptop and your phone.</p>
<div class="sum"><b>{r["passed"]} of {r["passed"] + r["failed"]} checks passed</b><span>Run on {e(r["when"][:10])}, real PC app with a simulated phone and the phone web screen</span></div>

<h2>What is proven and what is not</h2>
<table class="status"><thead><tr><th>Part</th><th>Tested here</th><th>Not tested yet</th></tr></thead><tbody>{st}</tbody></table>

<h2>The {len(r["results"])} checks</h2>
<table class="checks"><tbody>{rows}</tbody></table>

<h2>Screens from the test run</h2>
<div class="gal">{gal}</div>
</main></body></html>'''
out.write_text(page)
print(out, round(out.stat().st_size / 1024), 'KB')
