package club.taptappers.lezepplean.helper;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

import org.junit.Test;

public class ListeningTest {
    private static Listening.Request read(String raw) throws IOException {
        return Listening.read(new ByteArrayInputStream(raw.getBytes(StandardCharsets.US_ASCII)));
    }

    // HMAC-SHA256("abc", "lezepplean-listen:1700000000000"), from Node's crypto: what the side service sends
    private static final String SIGNED = "LZL 1700000000000.ddc79a031bce6f8e9136005d54cd1b0cb7af180b43cc3138fd455a6824d6297d";

    @Test
    public void theWatchsRequestIsReadWithItsSignature() throws IOException {
        Listening.Request r = read("POST /listen HTTP/1.1\r\nHost: 127.0.0.1:47391\r\nauthorization: " + SIGNED + "\r\n"
                + "Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
        assertEquals("POST", r.method);
        assertEquals("/listen", r.path);
        assertEquals(1700000000000L, Listening.verify(r.authorization, "abc", 1700000005000L, 0));
    }

    @Test
    public void onlyAFreshSignatureMadeWithTheTokenCountsAndOnlyOnce() {
        long now = 1700000005000L;
        assertEquals("the token itself is never what is sent", -1, Listening.verify("Bearer abc", "abc", now, 0));
        assertEquals("another token's signature", -1, Listening.verify(SIGNED, "abd", now, 0));
        assertEquals("no token here", -1, Listening.verify(SIGNED, "", now, 0));
        assertEquals("a copy, used again", -1, Listening.verify(SIGNED, "abc", now, 1700000000000L));
        assertEquals("signed long ago", -1, Listening.verify(SIGNED, "abc", now + Listening.FRESH_MS, 0));
        assertEquals("tampered", -1, Listening.verify(SIGNED.replace("ddc7", "ddc8"), "abc", now, 0));
    }

    @Test
    public void javaSignsLikeTheSideService() {
        assertEquals(SIGNED.substring(SIGNED.indexOf('.') + 1), Listening.hmacHex("abc", "lezepplean-listen:1700000000000"));
    }

    @Test
    public void aHeadThatNeverEndsIsNotARequest() throws IOException {
        StringBuilder b = new StringBuilder("POST /listen HTTP/1.1\r\nX: ");
        for (int i = 0; i < 5000; i++) b.append('y');
        assertNull(read(b.toString()));
        assertNull("not HTTP", read(""));
    }

    @Test
    public void silenceIsQuieterThanTheGateAndMusicIsNot() {
        assertTrue(Listening.rmsDb(new short[800], 800) < Listening.QUIET_DB);
        short[] loud = new short[800];
        for (int i = 0; i < loud.length; i++) loud[i] = (short) (i % 2 == 0 ? 8000 : -8000);
        assertTrue(Listening.rmsDb(loud, loud.length) > Listening.QUIET_DB);
    }

    @Test
    public void theFirstSampleIsDatedFromWhenAFrameWasCaptured() {
        // frame 8000 (0.5 s in) was captured 20 ms before "now": sample 0 began 520 ms before now
        long t = Listening.sampleZeroWallMs(1_000_000L, 5_000_000_000L, 4_980_000_000L, 8000, 16_000);
        assertEquals(1_000_000L - 520, t);
    }

    @Test
    public void samplesGoOutAsSixteenBitLittleEndian() {
        assertArrayEquals(new byte[] {0x34, 0x12, (byte) 0xFF, (byte) 0xFF}, Listening.pcm(new short[] {0x1234, -1}, 2));
    }

    @Test
    public void aPieceSaysWhereItsFirstSampleSits() {
        String body = Listening.piece("p1", 1234L, 8000, new byte[] {1, 2}, 5678L);
        assertTrue(body.contains("\"offset\":8000"));
        assertTrue(body.contains("\"startedAt\":1234"));
        assertTrue(body.contains("\"pcm\":\"" + Base64.getEncoder().encodeToString(new byte[] {1, 2}) + "\""));
    }

    @Test
    public void theServerSayingDoneStopsTheListening() {
        assertTrue(Listening.done("{\"ok\": true, \"done\": true, \"reason\": \"found\"}"));
        assertFalse(Listening.done("{\"ok\": true, \"done\": false, \"reason\": null}"));
        assertFalse(Listening.done(null));
    }
}
