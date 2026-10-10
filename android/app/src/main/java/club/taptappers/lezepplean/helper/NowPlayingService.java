package club.taptappers.lezepplean.helper;

import android.content.ComponentName;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import android.service.notification.NotificationListenerService;

import java.util.ArrayList;
import java.util.List;

/**
 * What the phone's players are playing, from their media sessions. Every player (YouTube,
 * YouTube Music, Spotify, ...) publishes one, and Android shows them only to an app with
 * notification access: that is the only reason this is a notification listener. Every change
 * goes to the server at once; while something plays, also every 10 s, so the server knows
 * the helper is still there.
 */
public class NowPlayingService extends NotificationListenerService {
    static final long HEARTBEAT_MS = 10_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<MediaController> controllers = new ArrayList<>();
    private final Runnable heartbeat = this::report;
    private MediaSessionManager sessions;
    private ComponentName me;
    private Snapshot last;

    private final MediaController.Callback callback = new MediaController.Callback() {
        @Override
        public void onPlaybackStateChanged(PlaybackState state) {
            report();
        }

        @Override
        public void onMetadataChanged(MediaMetadata metadata) {
            report();
        }

        @Override
        public void onSessionDestroyed() {
            follow(sessions.getActiveSessions(me));
        }
    };

    private final MediaSessionManager.OnActiveSessionsChangedListener onSessions = this::follow;

    @Override
    public void onListenerConnected() {
        sessions = getSystemService(MediaSessionManager.class);
        me = new ComponentName(this, NowPlayingService.class);
        sessions.addOnActiveSessionsChangedListener(onSessions, me, main);
        follow(sessions.getActiveSessions(me));
    }

    @Override
    public void onListenerDisconnected() {
        if (sessions != null) sessions.removeOnActiveSessionsChangedListener(onSessions);
        for (MediaController c : controllers) c.unregisterCallback(callback);
        controllers.clear();
        main.removeCallbacks(heartbeat);
    }

    private void follow(List<MediaController> active) {
        for (MediaController c : controllers) c.unregisterCallback(callback);
        controllers.clear();
        if (active != null) {
            for (MediaController c : active) {
                c.registerCallback(callback, main);
                controllers.add(c);
            }
        }
        report();
    }

    /** The one that plays (Android lists the most important first), else the first there is. */
    private MediaController current() {
        for (MediaController c : controllers) {
            PlaybackState s = c.getPlaybackState();
            if (s != null && s.getState() == PlaybackState.STATE_PLAYING) return c;
        }
        return controllers.isEmpty() ? null : controllers.get(0);
    }

    private void report() {
        main.removeCallbacks(heartbeat);
        Snapshot now = Snapshot.of(current());
        if (now.worthSending(last)) {
            Reporter.get(this).send(now);
            last = now;
        }
        if (now.playing) main.postDelayed(heartbeat, HEARTBEAT_MS);
    }
}
