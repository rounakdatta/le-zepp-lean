package club.taptappers.lezepplean.helper;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** The plain-Java parts of listening (ListenService): tested on the JVM. */
final class Listening {
    static final int RATE = 16_000;
    static final int PIECE = RATE / 2; // samples: half a second
    static final int MAX_SAMPLES = RATE * 8; // the server has named it by then, or won't
    static final double QUIET_DB = -55; // quieter than this is no music: nothing to send (the server's gate too)
    static final long FRESH_MS = 60_000; // a trigger signed longer ago than this is refused
    private static final int HEAD_LIMIT = 4096; // a request head longer than this isn't the side service's

    private Listening() {}

    /** A request to the trigger on 127.0.0.1: its method, path and Authorization header. */
    static final class Request {
        final String method;
        final String path;
        final String authorization;

        Request(String method, String path, String authorization) {
            this.method = method;
            this.path = path;
            this.authorization = authorization;
        }
    }

    /** Reads an HTTP request's head, at most HEAD_LIMIT bytes (and skips its small body). Null if it isn't one. */
    static Request read(InputStream raw) throws IOException {
        InputStream in = new BufferedInputStream(raw, 512);
        byte[] head = new byte[HEAD_LIMIT];
        int n = 0;
        boolean ended = false;
        while (n < head.length) {
            int b = in.read();
            if (b < 0) break;
            head[n++] = (byte) b;
            if (n >= 4 && head[n - 4] == '\r' && head[n - 3] == '\n' && head[n - 2] == '\r' && head[n - 1] == '\n') {
                ended = true;
                break;
            }
        }
        if (!ended) return null;
        String[] lines = new String(head, 0, n, StandardCharsets.US_ASCII).split("\r\n");
        String[] parts = lines[0].trim().split(" ");
        if (parts.length < 2) return null;
        String auth = null;
        int length = 0;
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c <= 0) continue;
            String name = lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT);
            String value = lines[i].substring(c + 1).trim();
            if (name.equals("authorization")) auth = value;
            if (name.equals("content-length")) {
                try {
                    length = Math.min(HEAD_LIMIT, Math.max(0, Integer.parseInt(value)));
                } catch (NumberFormatException e) {
                    length = 0;
                }
            }
        }
        for (int i = 0; i < length && in.read() >= 0; i++) {
            // the body ({}) says nothing: read so the sender isn't cut off mid-write
        }
        return new Request(parts[0], parts[1], auth);
    }

    /**
     * A trigger from the Zepp app's side service: "LZL <ms>.<hex HMAC-SHA256(token, lezepplean-listen:<ms>)>".
     * The token itself never comes here (any app holding the port would have had it). Fresh
     * (within FRESH_MS of now) and newer than the last one taken: a copy can't be used again.
     * Returns its time, or -1.
     */
    static long verify(String header, String token, long now, long lastTaken) {
        if (token == null || token.isEmpty() || header == null || !header.startsWith("LZL ")) return -1;
        int dot = header.indexOf('.', 4);
        if (dot < 0) return -1;
        long t;
        try {
            t = Long.parseLong(header.substring(4, dot).trim());
        } catch (NumberFormatException e) {
            return -1;
        }
        if (t <= lastTaken || Math.abs(now - t) > FRESH_MS) return -1;
        String expected = hmacHex(token, "lezepplean-listen:" + t);
        boolean same = MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
                header.substring(dot + 1).trim().toLowerCase(Locale.ROOT).getBytes(StandardCharsets.US_ASCII));
        return same ? t : -1;
    }

    static String hmacHex(String key, String message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            StringBuilder out = new StringBuilder();
            for (byte b : mac.doFinal(message.getBytes(StandardCharsets.UTF_8))) out.append(String.format(Locale.ROOT, "%02x", b));
            return out.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** RMS level of n samples, in dBFS. */
    static double rmsDb(short[] samples, int n) {
        if (n <= 0) return -120;
        double sum = 0;
        for (int i = 0; i < n; i++) sum += (double) samples[i] * samples[i];
        double rms = Math.sqrt(sum / n);
        return rms <= 0 ? -120 : 20 * Math.log10(rms / 32768.0);
    }

    static byte[] reply(int code) {
        String reason = code == 202 ? "Accepted" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : "Bad Request";
        return ("HTTP/1.1 " + code + " " + reason + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
    }

    /**
     * The wall-clock time (ms) of a recording's first sample, from an AudioTimestamp: frame
     * `framePosition` was captured at `stampNano` (System.nanoTime), read at `nanoNow`/`wallNow`.
     */
    static long sampleZeroWallMs(long wallNow, long nanoNow, long stampNano, long framePosition, int rate) {
        return wallNow - (nanoNow - stampNano) / 1_000_000L - framePosition * 1000L / rate;
    }

    /** 16-bit little-endian, as the server wants it. */
    static byte[] pcm(short[] samples, int n) {
        byte[] out = new byte[n * 2];
        for (int i = 0; i < n; i++) {
            out[2 * i] = (byte) samples[i];
            out[2 * i + 1] = (byte) (samples[i] >> 8);
        }
        return out;
    }

    /** The body of one piece for POST /listen/audio. */
    static String piece(String session, long startedAt, int offset, byte[] pcm, long sentAt) {
        return "{\"session\":\"" + session + "\",\"startedAt\":" + startedAt + ",\"offset\":" + offset
                + ",\"rate\":" + RATE + ",\"pcm\":\"" + Base64.getEncoder().encodeToString(pcm) + "\",\"sentAt\":" + sentAt + "}";
    }

    private static final Pattern DONE = Pattern.compile("\"done\"\\s*:\\s*true");

    /** The server's answer says it has what it needs (named it, or never will). */
    static boolean done(String reply) {
        return reply != null && DONE.matcher(reply).find();
    }

    static String newId() {
        return "p" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    }
}
