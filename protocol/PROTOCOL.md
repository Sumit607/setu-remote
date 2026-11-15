# Setu Remote wire protocol (v1)

Both apps implement exactly this. The reference implementations are `desktop/src/core/core.js` (PC and web controller) and `android/app/src/main/java/app/setu/remote/Engine.kt` (phone).

## Pairing

The PC creates a 256-bit random secret and shows a pairing code:

    setu1.<base64url( JSON {v:1, id, s, lan:[ "ip:port", … ], relay? } )>

- `id` — the PC's device id, `s` — the secret (base64url), `lan` — up to two LAN addresses of the PC's built-in relay.
- `relay` missing = use the default cloud relay; `null` = same Wi-Fi only; `{u, k}` = a custom Supabase project URL and publishable key.
- The QR code holds `http://<lan-ip>:<port>/#<code>`, so the phone app's scanner and a plain phone browser can both use it.

Everything else is derived from the secret:

    room = hex( SHA-256( "setu-room-v1" ‖ secret ) )[0..32]
    key  =      SHA-256( "setu-key-v1"  ‖ secret )

## Relays

A relay only forwards opaque messages between devices in the same room. Two are used at once:

| Relay | URL | Used when |
|---|---|---|
| LAN (inside the PC app) | `ws://<pc-ip>:47800/relay?vsn=1.0.0` | phone and laptop on the same Wi-Fi |
| Cloud (Supabase Realtime) | `wss://<project>.supabase.co/realtime/v1/websocket?apikey=<key>&vsn=1.0.0` | anywhere else |

Both speak Phoenix Channels v1 JSON: join topic `realtime:setu-<room>` with
`config: { broadcast: { self: false, ack: false }, presence: { key: "" }, private: false }`,
send a `heartbeat` on topic `phoenix` every 25 s, and exchange `broadcast` messages with event `sig`.

## Envelope

Every broadcast payload is `{ e: { n, c } }` — AES-256-GCM, 12-byte random nonce `n`, `c` = ciphertext‖tag, AAD = the room name, all base64. The relay never sees plaintext.

Plaintext is JSON `{ t, from, to?, mid, … }`. Receivers drop duplicates by `mid` (the same message may arrive over both relays).

| `t` | Meaning |
|---|---|
| `hello`, `ping` | presence: `name`, `role` (`pc`, `phone`, `web`), `caps`, `boot`, `x.lan`. LAN ping every 10 s (offline after 25 s), cloud every 45 s (offline after 110 s). A changed `boot` id means the peer restarted: drop the link. |
| `bye` | going offline |
| `rpc` | small requests when no direct link is open: `d: { k: "req"/"res"/"evt", id, m, p, ok, r, e }` |
| `link-req`, `offer`, `answer`, `ice`, `link-close` | WebRTC signalling, each with a session id `sid` |

## Direct link (WebRTC)

Opened on demand, closed after 120 s idle. The PC is always the offerer.

- Data channel `ctl` — the same RPC objects as above.
- Data channel `bulk` — file bytes: `[u32 xid, big-endian][u8 flag: 0 data, 1 end, 2 error][payload]`, 48 KB chunks, sender waits while `bufferedAmount` > 4 MB.
- Data channel `input` — input events (JSON).
- One video transceiver, `sendrecv`, negotiated up front; the screen track is swapped in with `replaceTrack` / `setTrack`.

## RPC methods

Phone implements: `sys.info`, `fs.list`, `fs.read`, `fs.write`, `fs.thumb`, `media.recent`, `sms.threads`, `sms.list`, `sms.send`, `notif.list`, `notif.reply`, `text.push`, `clip.set`, `screen.start`, `screen.stop`.
Phone events: `notif.posted`, `notif.removed`, `sms.received`, `screen.ended`, `xfer.done`.

PC implements: `sys.info`, `fs.list`, `fs.read`, `fs.write`, `clip.get`, `clip.set`, `text.push`, `screen.start`, `screen.stop`.

`fs.read`, `fs.write`, `fs.thumb`, `media.*` and `screen.*` need the direct link; the rest fall back to the relay.

## Input events (coordinates are 0..1 of the screen)

To the phone: `{k:"tap",x,y}`, `{k:"gesture",pts:[[x,y,t]…],ms}`, `{k:"scroll",x,y,dy}`, `{k:"key",a:"back|home|recents|notifications|lock|volup|voldown|enter|backspace"}`, `{k:"text",s}`.

To the PC: `{k:"move",dx,dy}`, `{k:"abs",x,y}`, `{k:"btn",b,down}`, `{k:"click",b,n}`, `{k:"wheel",dx,dy}`, `{k:"key",code,down}`, `{k:"tapkey",code,mods}`, `{k:"text",s}`.
