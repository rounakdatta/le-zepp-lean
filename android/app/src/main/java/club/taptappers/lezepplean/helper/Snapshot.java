package club.taptappers.lezepplean.helper;

import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.PlaybackState;
import android.os.SystemClock;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Objects;

/** One player's state at one moment: the track, where in it, and whether it plays. */
final class Snapshot {
    final String app;
    final String title;
    final String artist;
    final String album;
    final long durationMs; // 0: unknown
    final String state; // playing | paused | buffering | stopped
    final boolean playing;
    final double positionMs; // at elapsedAt
    final double speed;
    final long elapsedAt; // SystemClock.elapsedRealtime(), which sleep doesn't stop

    private Snapshot(String app, String title, String artist, String album, long durationMs, String state,
                     double positionMs, double speed, long elapsedAt) {
        this.app = app;
        this.title = title;
        this.artist = artist;
        this.album = album;
        this.durationMs = durationMs;
        this.state = state;
        this.playing = "playing".equals(state);
        this.positionMs = positionMs;
        this.speed = speed;
        this.elapsedAt = elapsedAt;
    }

    static Snapshot of(MediaController c) {
        long now = SystemClock.elapsedRealtime();
        if (c == null) return new Snapshot("", "", "", "", 0, "stopped", 0, 1, now);
        MediaMetadata m = c.getMetadata();
        PlaybackState p = c.getPlaybackState();
        String title = text(m, MediaMetadata.METADATA_KEY_TITLE, MediaMetadata.METADATA_KEY_DISPLAY_TITLE);
        String artist = text(m, MediaMetadata.METADATA_KEY_ARTIST, MediaMetadata.METADATA_KEY_ALBUM_ARTIST,
                MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE);
        String album = text(m, MediaMetadata.METADATA_KEY_ALBUM);
        long duration = m != null ? Math.max(0, m.getLong(MediaMetadata.METADATA_KEY_DURATION)) : 0;
        String state = "stopped";
        double position = 0;
        double speed = 1;
        if (p != null) {
            switch (p.getState()) {
                case PlaybackState.STATE_PLAYING:
                    state = "playing";
                    break;
                case PlaybackState.STATE_PAUSED:
                    state = "paused";
                    break;
                case PlaybackState.STATE_BUFFERING:
                case PlaybackState.STATE_CONNECTING:
                case PlaybackState.STATE_FAST_FORWARDING:
                case PlaybackState.STATE_REWINDING:
                case PlaybackState.STATE_SKIPPING_TO_NEXT:
                case PlaybackState.STATE_SKIPPING_TO_PREVIOUS:
                case PlaybackState.STATE_SKIPPING_TO_QUEUE_ITEM:
                    state = "buffering"; // no sound comes out: the lyrics wait
                    break;
                default:
                    state = "stopped";
            }
            position = p.getPosition();
            if (p.getPlaybackSpeed() > 0) speed = p.getPlaybackSpeed();
            if (state.equals("playing") && p.getLastPositionUpdateTime() > 0) {
                // the player said where it was then; it has played on since
                position += (now - p.getLastPositionUpdateTime()) * speed;
            }
        }
        return new Snapshot(c.getPackageName(), title, artist, album, duration, state, Math.max(0, position), speed, now);
    }

    private static String text(MediaMetadata m, String... keys) {
        if (m == null) return "";
        for (String k : keys) {
            CharSequence v = m.getText(k);
            if (v != null && v.length() > 0) return v.toString();
        }
        return "";
    }

    /** Where the track is at `elapsed` (SystemClock.elapsedRealtime). */
    double positionAt(long elapsed) {
        return positionMs + (playing ? (elapsed - elapsedAt) * speed : 0);
    }

    boolean sameTrack(Snapshot o) {
        return o != null && app.equals(o.app) && title.equals(o.title) && artist.equals(o.artist) && durationMs == o.durationMs;
    }

    /** Anything the watch would show differently, or a heartbeat due. */
    boolean worthSending(Snapshot last) {
        if (last == null || !sameTrack(last) || !Objects.equals(state, last.state)) return true;
        if (Math.abs(positionMs - last.positionAt(elapsedAt)) > 250) return true; // dragged, or the player corrected itself
        return playing && elapsedAt - last.elapsedAt >= NowPlayingService.HEARTBEAT_MS - 500;
    }

    /** The body for POST /phone, with the position as of this very moment. */
    JSONObject json(long wallNow, long elapsedNow) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("app", app);
        o.put("title", title);
        o.put("artist", artist);
        o.put("album", album);
        if (durationMs > 0) o.put("durationMs", durationMs);
        o.put("state", state);
        o.put("positionMs", Math.round(positionAt(elapsedNow)));
        o.put("speed", speed);
        o.put("sentAt", wallNow);
        return o;
    }

    String describe() {
        if (title.isEmpty()) return "nothing playing";
        long s = Math.round(positionAt(SystemClock.elapsedRealtime()) / 1000);
        return title + (artist.isEmpty() ? "" : " · " + artist) + " — " + state + " at " + (s / 60) + ":" + String.format("%02d", s % 60);
    }
}
