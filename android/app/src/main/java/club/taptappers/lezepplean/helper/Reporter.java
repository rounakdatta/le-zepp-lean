package club.taptappers.lezepplean.helper;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sends snapshots to the server, one request at a time. A snapshot that arrives while one is
 * on its way replaces any other still waiting: only the newest state matters.
 */
final class Reporter {
    static final String DEFAULT_SERVER = "https://lezepplean.taptappers.club";

    private static Reporter instance;

    static synchronized Reporter get(Context context) {
        if (instance == null) instance = new Reporter(context.getApplicationContext());
        return instance;
    }

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    final SharedPreferences prefs;
    private Snapshot waiting;
    private boolean busy;
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
            if (busy) return;
            busy = true;
        }
        io.execute(this::drain);
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
            post(s);
        }
    }

    private void post(Snapshot s) {
        if (token().isEmpty()) {
            lastResult = "Add the token to start";
            return;
        }
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(server() + "/phone").openConnection();
            h.setConnectTimeout(8000);
            h.setReadTimeout(8000);
            h.setRequestMethod("POST");
            h.setDoOutput(true);
            h.setRequestProperty("Content-Type", "application/json");
            h.setRequestProperty("Authorization", "Bearer " + token());
            // as of now, not as of when it was queued
            byte[] body = s.json(System.currentTimeMillis(), SystemClock.elapsedRealtime()).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = h.getOutputStream()) {
                out.write(body);
            }
            int code = h.getResponseCode();
            lastResult = code == 200 ? "Sent: " + s.describe()
                    : code == 401 ? "The server refused the token"
                    : "The server answered " + code;
        } catch (Exception e) {
            lastResult = "Could not reach the server: " + e.getClass().getSimpleName();
        } finally {
            lastAt = System.currentTimeMillis();
            if (h != null) h.disconnect();
        }
    }
}
