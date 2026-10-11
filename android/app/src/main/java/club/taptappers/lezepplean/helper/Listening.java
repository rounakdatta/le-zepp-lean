package club.taptappers.lezepplean.helper;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/** The plain-Java parts of listening (ListenService): tested on the JVM. */
final class Listening {
    static final int RATE = 16_000;
    static final int PIECE = RATE / 2; // samples: half a second
    static final int MAX_SAMPLES = RATE * 8; // the server has named it by then, or won't

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

    /** Reads an HTTP request's head (and skips its small body). Null if it isn't one. */
    static Request read(InputStream in) throws IOException {
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.US_ASCII), 4096);
        String line = r.readLine();
        if (line == null) return null;
        String[] parts = line.trim().split(" ");
        if (parts.length < 2) return null;
        String auth = null;
        int length = 0;
        for (int i = 0; i < 64; i++) {
            String h = r.readLine();
            if (h == null || h.isEmpty()) break;
            int c = h.indexOf(':');
            if (c <= 0) continue;
            String name = h.substring(0, c).trim().toLowerCase(Locale.ROOT);
            String value = h.substring(c + 1).trim();
            if (name.equals("authorization")) auth = value;
            if (name.equals("content-length")) {
                try {
                    length = Math.min(4096, Math.max(0, Integer.parseInt(value)));
                } catch (NumberFormatException e) {
                    length = 0;
                }
            }
        }
        for (int i = 0; i < length && r.read() >= 0; i++) {
            // the body ({}) says nothing: read so the sender isn't cut off mid-write
        }
        return new Request(parts[0], parts[1], auth);
    }

    /** Only the Zepp app's side service knows the token: other apps on this phone can't make it listen. */
    static boolean authorized(String header, String token) {
        if (token == null || token.isEmpty() || header == null) return false;
        return MessageDigest.isEqual(header.getBytes(StandardCharsets.UTF_8), ("Bearer " + token).getBytes(StandardCharsets.UTF_8));
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
