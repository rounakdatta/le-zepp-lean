package club.taptappers.lezepplean.helper;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTimestamp;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * This phone listens too, when the watch looks for a song: the watch asks through the Zepp
 * app (a request to 127.0.0.1 here, signed with the server's token, see Listening.verify),
 * and up to 8 s of what the mic hears streams to the server in half-second pieces, until it
 * has named the song. At most once every 20 s; a silent room stops it after a second, with
 * nothing sent.
 *
 * Android lets an app use the mic in the background only from a foreground service started
 * while the app is on screen: so this runs, armed, from when the switch is turned on (its
 * notification says so). It records nothing until asked, and never while this phone's own
 * player plays: that music is followed exactly instead, and comes first.
 */
public class ListenService extends Service {
    static final int PORT = 47391;
    private static final String CHANNEL = "listening";
    private static final long EVERY_MS = 8_000; // one recording at most this often, whoever asks (one lasts up to 8 s)
    private static final long STALE_MS = 12_000; // a piece held up this long is no use: stop
    static volatile String status = "Off";

    private final ExecutorService uploads = Executors.newSingleThreadExecutor();
    // two requests read at a time, each within 2 s: a client that dawdles can't hold the trigger
    private final ThreadPoolExecutor triggers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new SynchronousQueue<>());
    private final AtomicBoolean recording = new AtomicBoolean();
    private final AtomicBoolean serving = new AtomicBoolean();
    private volatile ServerSocket server;
    private long lastTrigger; // the newest signed trigger taken (a copy can't be used twice)
    private volatile long lastRecordingAt;

    static void start(Context c) {
        c.startForegroundService(new Intent(c, ListenService.class));
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, ListenService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(1, notification());
        } catch (RuntimeException e) {
            // started from the background (Android restarting it): no mic for it now
            status = "Open LeZeppLean once to turn listening back on";
            stopSelf();
            return START_NOT_STICKY;
        }
        if (serving.compareAndSet(false, true)) new Thread(this::serve, "lezepplean-trigger").start();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        status = "Off";
        try {
            if (server != null) server.close();
        } catch (Exception e) {
            // closing anyway
        }
        server = null;
        uploads.shutdownNow();
        triggers.shutdownNow();
        super.onDestroy();
    }

    private Notification notification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Listening for the watch", NotificationManager.IMPORTANCE_MIN));
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_listen)
                .setContentTitle("Ready to listen for your watch")
                .setContentText("Only when LeZeppLean on the watch is looking for a song")
                .setOngoing(true)
                .build();
    }

    /** The trigger: one short request at a time, from this phone only. */
    private void serve() {
        try (ServerSocket s = new ServerSocket(PORT, 8, InetAddress.getByName("127.0.0.1"))) {
            server = s;
            status = "Ready: the watch can ask this phone to listen";
            while (!s.isClosed()) {
                Socket c = s.accept();
                try {
                    triggers.execute(() -> answer(c));
                } catch (RejectedExecutionException e) {
                    close(c); // both busy with slow clients: this one waits for nothing
                }
            }
        } catch (Exception e) {
            // the port is taken (another app holds it?) or closed: say so, and try again next time
            if (server == null) status = "Couldn't wait for the watch here: " + e.getClass().getSimpleName();
        } finally {
            server = null;
            serving.set(false);
        }
    }

    private void answer(Socket c) {
        try {
            c.setSoTimeout(2000);
            Listening.Request r = Listening.read(c.getInputStream(), System.nanoTime() + 2_000_000_000L);
            long t;
            synchronized (this) {
                t = r == null || !"/listen".equals(r.path) ? -1
                        : Listening.verify(r.authorization, Reporter.get(this).token(), System.currentTimeMillis(), lastTrigger);
                if (t > 0) lastTrigger = t;
            }
            c.getOutputStream().write(Listening.reply(r == null ? 400 : !"/listen".equals(r.path) ? 404 : t > 0 ? 202 : 403));
            if (t > 0) listen();
        } catch (Exception e) {
            // one bad request: carry on
        } finally {
            close(c);
        }
    }

    private static void close(Socket c) {
        try {
            c.close();
        } catch (Exception e) {
            // gone already
        }
    }

    private void listen() {
        if (NowPlayingService.playing) return; // this phone's own music is followed, not heard
        long now = System.currentTimeMillis();
        if (now - lastRecordingAt < EVERY_MS) return;
        if (!recording.compareAndSet(false, true)) return; // already listening
        lastRecordingAt = now;
        new Thread(() -> {
            try {
                record();
            } finally {
                recording.set(false);
            }
        }, "lezepplean-record").start();
    }

    private void record() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            status = "Allow the microphone in LeZeppLean to listen";
            return;
        }
        int source = unprocessed() ? MediaRecorder.AudioSource.UNPROCESSED : MediaRecorder.AudioSource.VOICE_RECOGNITION;
        int min = AudioRecord.getMinBufferSize(Listening.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord rec;
        try {
            rec = new AudioRecord(source, Listening.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(min, Listening.RATE * 2 * 2));
        } catch (RuntimeException e) {
            status = "The microphone is busy";
            return;
        }
        if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
            rec.release();
            status = "The microphone is busy";
            return;
        }
        String session = Listening.newId();
        AtomicBoolean done = new AtomicBoolean();
        short[] buf = new short[Listening.PIECE];
        long startedAt = 0;
        int offset = 0;
        java.util.List<byte[]> first = new java.util.ArrayList<>(); // the first second, held until it's known not to be silence
        boolean heard = false;
        try {
            rec.startRecording();
            status = "Listening for the watch…";
            while (!done.get() && offset < Listening.MAX_SAMPLES) {
                int n = 0;
                while (n < buf.length) {
                    int got = rec.read(buf, n, buf.length - n);
                    if (got <= 0) break;
                    n += got;
                }
                if (n <= 0) break;
                if (startedAt == 0) startedAt = firstSampleAt(rec, n);
                heard |= Listening.rmsDb(buf, n) >= Listening.QUIET_DB;
                final byte[] pcm = Listening.pcm(buf, n);
                final long readAt = System.currentTimeMillis();
                if (!heard && offset + n < Listening.RATE) {
                    first.add(pcm); // hold on: a silent room isn't worth sending
                    offset += n;
                    continue;
                }
                if (!heard) {
                    // a second of silence: no audio sent, only that it heard nothing (that stops a
                    // song only this phone's mic had heard, whose music has stopped)
                    final long t0 = startedAt;
                    uploads.execute(() -> post(Listening.quiet(session, t0, System.currentTimeMillis())));
                    break;
                }
                int at = offset - first.size() * Listening.PIECE;
                for (byte[] held : first) send(done, session, startedAt, at, held, readAt);
                at += first.size() * Listening.PIECE;
                first.clear();
                send(done, session, startedAt, at, pcm, readAt);
                offset += n;
            }
        } catch (RuntimeException e) {
            status = "The microphone stopped: " + e.getClass().getSimpleName();
        } finally {
            try {
                rec.stop();
            } catch (RuntimeException e) {
                // never started
            }
            rec.release();
            if (status.startsWith("Listening")) status = "Ready: the watch can ask this phone to listen";
        }
    }

    /** A piece to the server, in order; one held up more than STALE_MS stops the listening. */
    private void send(AtomicBoolean done, String session, long startedAt, int at, byte[] pcm, long readAt) {
        uploads.execute(() -> {
            if (done.get()) return;
            if (System.currentTimeMillis() - readAt > STALE_MS) {
                done.set(true); // the network is too slow for this to be about what plays now
                return;
            }
            if (upload(session, startedAt, at, pcm)) done.set(true);
        });
    }

    /** Music, not speech: no noise suppression or gain riding where the phone allows it. */
    private boolean unprocessed() {
        AudioManager am = getSystemService(AudioManager.class);
        return am != null && "true".equals(am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED));
    }

    private static long firstSampleAt(AudioRecord rec, int framesRead) {
        AudioTimestamp ts = new AudioTimestamp();
        long wall = System.currentTimeMillis();
        long nano = System.nanoTime();
        if (rec.getTimestamp(ts, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS) {
            return Listening.sampleZeroWallMs(wall, nano, ts.nanoTime, ts.framePosition, Listening.RATE);
        }
        return wall - framesRead * 1000L / Listening.RATE; // the samples just read ended about now
    }

    /** One piece to the server; true once it says it has what it needs. A failed piece is tried once more. */
    private boolean upload(String session, long startedAt, int offset, byte[] pcm) {
        return post(Listening.piece(session, startedAt, offset, pcm, System.currentTimeMillis()));
    }

    /** A body to POST /listen/audio; true once the server says it has what it needs. Tried twice. */
    private boolean post(String json) {
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection h = null;
            try {
                Reporter r = Reporter.get(this);
                h = (HttpURLConnection) new URL(r.server() + "/listen/audio").openConnection();
                h.setConnectTimeout(4000);
                h.setReadTimeout(6000);
                h.setRequestMethod("POST");
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", "application/json");
                h.setRequestProperty("Authorization", "Bearer " + r.token());
                byte[] body = json.getBytes(StandardCharsets.UTF_8);
                try (OutputStream out = h.getOutputStream()) {
                    out.write(body);
                }
                if (h.getResponseCode() != 200) continue;
                try (InputStream in = h.getInputStream()) {
                    ByteArrayOutputStream b = new ByteArrayOutputStream();
                    byte[] chunk = new byte[1024];
                    for (int k; (k = in.read(chunk)) > 0; ) b.write(chunk, 0, k);
                    return Listening.done(b.toString("UTF-8"));
                }
            } catch (Exception e) {
                // no signal for a moment: once more, then the next piece carries on
            } finally {
                if (h != null) h.disconnect();
            }
        }
        return false;
    }
}
