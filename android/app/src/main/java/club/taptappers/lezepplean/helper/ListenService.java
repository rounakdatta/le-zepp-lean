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
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * This phone listens too, when the watch looks for a song: the watch asks through the Zepp
 * app (a request to 127.0.0.1 here, with the server's token), and up to 8 s of what the mic
 * hears streams to the server in half-second pieces, until it has named the song.
 *
 * Android lets an app use the mic in the background only from a foreground service started
 * while the app is on screen: so this runs, armed, from when the switch is turned on (its
 * notification says so). It records nothing until asked, and never while this phone's own
 * player plays: that music is followed exactly instead, and comes first.
 */
public class ListenService extends Service {
    static final int PORT = 47391;
    private static final String CHANNEL = "listening";
    static volatile String status = "Off";

    private final ExecutorService uploads = Executors.newSingleThreadExecutor();
    private final AtomicBoolean recording = new AtomicBoolean();
    private final AtomicBoolean serving = new AtomicBoolean();
    private volatile ServerSocket server;

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
        status = "Ready: the watch can ask this phone to listen";
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
            while (!s.isClosed()) {
                try (Socket c = s.accept()) {
                    c.setSoTimeout(2000);
                    Listening.Request r = Listening.read(c.getInputStream());
                    boolean listen = r != null && "/listen".equals(r.path)
                            && Listening.authorized(r.authorization, Reporter.get(this).token());
                    c.getOutputStream().write(Listening.reply(r == null ? 400 : !"/listen".equals(r.path) ? 404 : listen ? 202 : 403));
                    if (listen) listen();
                } catch (Exception e) {
                    // one bad request: carry on
                }
            }
        } catch (Exception e) {
            if (server != null) status = "Couldn't wait for the watch: " + e.getClass().getSimpleName();
        }
    }

    private void listen() {
        if (NowPlayingService.playing) return; // this phone's own music is followed, not heard
        if (!recording.compareAndSet(false, true)) return; // already listening
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
                final byte[] pcm = Listening.pcm(buf, n);
                final int at = offset;
                final long t0 = startedAt;
                uploads.execute(() -> {
                    if (!done.get() && upload(session, t0, at, pcm)) done.set(true);
                });
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
                byte[] body = Listening.piece(session, startedAt, offset, pcm, System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8);
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
