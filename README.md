<p align="center"><img src="brand/logo-512.png" width="160" alt="LeZeppLean: a zeppelin wearing headphones"></p>

# LeZeppLean

Time-synced lyrics, word by word, on an Amazfit T-Rex 3 (Zepp OS 6): for the music playing around you, or in your earphones.

Hold the watch near the music. It identifies the song and lights each word as it is sung. Stop the music and the lyrics stop on that word; start it again and they carry on. Skip ahead, or let the next song start, and the watch follows.

**Earphones.** The watch can't hear them, so a small Android app, the [helper](android), tells the server what the phone's player is playing and where it is: Spotify, YouTube Music, YouTube, any player. The watch then follows the player with its mic off, through pauses, seeks and the next track. Music playing on your phone always comes first.

**Two mics.** When your phone isn't playing anything, the room is listened to: by the watch, and, if you switch it on in the helper, by the phone as well. The phone's mic is far better than the watch's, and not on a moving wrist (a gym, say). Whichever names the song first wins. Pause the phone and both start listening at once, with your song still on screen until something else plays.

**No restarts.** Bluetooth or the network dropping out doesn't stop anything: the watch carries on with what it has, and picks up the moment the link is back.

**Any language.** A song in a script you read shows in it: pick yours (Hindi, Bengali, Tamil, Malayalam, Kannada, Urdu) in the Zepp app. Everything else shows in English letters, the way fans type them (*tujhe dekha toh*), so you can still sing along.

```
Watch (LeZeppLean app)                     Phone (Zepp app)            Server (CPU only)
 mic, in back-to-back takes                phone-side service           Shazam: which song, where
  ├ every 60 ms: still the music? ─┐        relays requests     ──HTTP─► the song's own audio: re-sync in ~30 ms
  │  stopped / back / skipped       │                                     LRCLIB lyrics + word timings it computes:
  │  (decided on the watch)         └─ short windows ─BLE─►                Spleeter vocals → wav2vec 2.0 → alignment
  └ lyrics, word by word, in time  ◄────────────── lyrics, word timings, the song's loudness track
                                           Phone (LeZeppLean helper)
                                            the player's state ───HTTP─► earphones: the player's clock
```

The watch knows when every 60 ms packet of its recording started, and the server says where in the song a window of them starts, so the seconds spent on Bluetooth and the network don't affect the timing. Between server answers the watch keeps its own song clock. The T-Rex 3 hands over a recording only when it stops, so the watch records in short takes, back to back (2 s while it follows a song), and reads the loudness straight out of the compressed audio. At the end of each take it knows whether the music stopped, and on which word, and the lyrics stay on that word. Sound coming back has to match the song's own loudness where it stopped before the lyrics move, so someone talking doesn't set them off.

The lyrics arrive with the song's name, or a moment after it. The first time a song is heard, the server also fetches the song's audio and works out when every word is sung: the lines about to be sung come first (about 18 s after the song is identified), the whole song within about a minute. Until then those lines show line by line. After that the song is instant.

| Folder | What it is |
|---|---|
| [`watch-app/`](watch-app) | Zepp OS app: watch UI and listening logic, the phone-side relay (`app-side/`) and the settings screen (`setting/`) |
| [`android/`](android) | The helper for earphones: an Android app that tells the server what the phone's player is playing |
| [`server/`](server) | Python service: recognition, lyrics (in English letters when needed), word timing, fast re-sync, the phone's player clock. See [server/README.md](server/README.md) |
| [`tests/`](tests) | Node tests for the watch logic, a session simulator, and a screen renderer |
| [`docs/research/`](docs/research/README.md) | Platform research: what the T-Rex 3 can and can't do |
| [`brand/`](brand) | The logo, and everything `tools/brand.py` makes from it |

## Running it

The server runs on the homelab at **https://lezepplean.taptappers.club** (image `ghcr.io/rounakdatta/le-zepp-lean`, chart `oci://ghcr.io/rounakdatta/charts/lezepplean`, deployed by `homelab.setup`). Its token is the Bitwarden item `lezepplean/token`, also in `pass` as `api-keys/lezepplean/token`.

1. **Watch app:** run `tools/install-watch.sh`. It does three things:
   - signs in to Zepp if needed (an email + password account);
   - builds the app with the server's URL and token built in: the homelab, unless a local server's tunnel is running (step 2);
   - shows an install QR code in the terminal and in the browser. The code is valid for 7 days.

   On the phone, once: Zepp app → Profile → Settings → About → tap the Zepp icon 7 times to turn on Developer Mode. Then Developer Mode → **Scan**.
2. **A server on this Mac instead** (for working on the server): run `tools/serve.sh` in its own terminal window and leave it open. It starts the server and a public HTTPS tunnel, prints the Mac's Wi-Fi address, and keeps the Mac awake; Ctrl-C stops everything. The first run downloads two models (~170 MB), and word timing needs Node or Deno installed (yt-dlp uses it to read YouTube). Re-run `tools/install-watch.sh` whenever the tunnel restarts, because its URL changes each time.
3. **Settings** are optional. A server URL or token entered in the Zepp app (your watch → LeZeppLean) overrides the built-in ones. **Test connection** checks whichever server is in use. Under **Lyrics in other languages**, turn on the scripts you read.
4. **Earphones** (optional): on the Android phone, install the APK from the [latest helper release](https://github.com/rounakdatta/le-zepp-lean/releases/latest). Tap **Allow** (Android shows what players play only to apps with notification access), paste the token, then **Save and test**. A newer release installs over the old one and keeps the settings.
5. **The phone listening too** (optional): in the helper, under **Listen with this phone too**, tap **Turn on** and allow the microphone. Android then shows a small notification while it's ready. For it to answer with the screen off, set Settings → Apps → LeZeppLean → Battery → **Unrestricted** (on vivo, also allow background activity). After a reboot, open the helper once.

**On the watch:**

| Input | Action |
|---|---|
| SELECT, or a tap on the screen | Re-sync now |
| UP / DOWN | Move lyrics 0.1 s earlier / later (remembered) |
| Hold SELECT | Diagnostics |
| BACK | Exit |
