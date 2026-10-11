package club.taptappers.lezepplean.helper;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Sends snapshots to the server, one request at a time. A snapshot that arrives while one is
 * on its way replaces any other still waiting: only the newest state matters.
 *
 * One that can't be delivered (no signal, the server restarting) is tried again, 2 s later,
 * then 4, 8, 16, 30, until it arrives or a newer one replaces it, and at once when the
 * network comes back. Dropped, a pause sent from a dead zone never reached the watch.
 */
final class Reporter {
    static final String DEFAULT_SERVER = "https://lezepplean.taptappers.club";

    private static Reporter instance;

    static synchronized Reporter get(Context context) {
        if (instance == null) instance = new Reporter(context.getApplicationContext());
        return instance;
    }

    private final ScheduledExecutorService io = Executors.newSingleThreadScheduledExecutor();
    final SharedPreferences prefs;
    private Snapshot waiting;
    private boolean busy;
    private Snapshot failed; // not delivered yet, waiting for its retry
    private ScheduledFuture<?> retry;
    private int failures; // in a row
    volatile String lastResult = "Nothing sent yet";
    volatile long lastAt;

    private Reporter(Context context) {
        prefs = context.getSharedPreferences("lezepplean", Context.MODE_PRIVATE);
    }

    String server() {
        return prefs.getString("server", DEFAULT_SERVER).trim().replaceAll("/+$", "");
    }

    String token() {
        return prefs.getString("token", "").trim();
    }

    void send(Snapshot s) {
        synchronized (this) {
            waiting = s;
            failed = null; // a newer state replaces one waiting for its retry
            if (retry != null) {
                retry.cancel(false);
                retry = null;
            }
            if (busy) return;
            busy = true;
        }
        io.execute(this::drain);
    }

    /** The network is back: whatever couldn't be delivered goes now. */
    void networkBack() {
        Snapshot again;
        synchronized (this) {
            again = failed;
        }
        if (again != null) send(again);
    }

    private void drain() {
        while (true) {
            Snapshot s;
            synchronized (this) {
                s = waiting;
                waiting = null;
                if (s == null) {
                    busy = false;
                    return;
                }
            }
            boolean delivered = post(s);
            synchronized (this) {
                if (delivered) {
                    failures = 0;
                } else if (waiting == null) {
                    failures += 1;
                    failed = s;
                    retry = io.schedule(this::networkBack, retryDelayMs(failures), TimeUnit.MILLISECONDS);
                }
            }
        }
    }

    /** 2 s after the first failure in a row, then twice as long each time, at most 30 s. */
    static long retryDelayMs(int failures) {
        return Math.min(30_000L, 2_000L << Math.min(Math.max(failures, 1) - 1, 4));
    }

    /** Worth trying again later: no answer, or the server (or a proxy before it) not ready. */
    static boolean retryable(int code) {
        return code < 0 || code == 408 || code == 429 || code >= 500;
    }

    /** True once the server has it, or when trying again can't help (a refused token). */
    private boolean post(Snapshot s) {
        if (token().isEmpty()) {
            lastResult = "Add the token to start";
            return true;
        }
        HttpURLConnection h = null;
        int code = -1;
        try {
            h = (HttpURLConnection) new URL(server() + "/phone").openConnection();
            h.setConnectTimeout(8000);
            h.setReadTimeout(8000);
            h.setRequestMethod("POST");
            h.setDoOutput(true);
            h.setRequestProperty("Content-Type", "application/json");
            h.setRequestProperty("Authorization", "Bearer " + token());
            // as of now, not as of when it was queued (or first tried)
            byte[] body = s.json(System.currentTimeMillis(), SystemClock.elapsedRealtime()).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = h.getOutputStream()) {
                out.write(body);
            }
            code = h.getResponseCode();
            lastResult = code == 200 ? "Sent: " + s.describe()
                    : code == 401 ? "The server refused the token"
                    : "The server answered " + code + (retryable(code) ? " (trying again)" : "");
        } catch (Exception e) {
            lastResult = "Could not reach the server (trying again): " + e.getClass().getSimpleName();
        } finally {
            lastAt = System.currentTimeMillis();
            if (h != null) h.disconnect();
        }
        return !retryable(code);
    }
}
