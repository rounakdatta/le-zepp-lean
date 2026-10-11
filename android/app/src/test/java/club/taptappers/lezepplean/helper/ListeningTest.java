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

    @Test
    public void theWatchsRequestIsReadWithItsToken() throws IOException {
        Listening.Request r = read("POST /listen HTTP/1.1\r\nHost: 127.0.0.1:47391\r\nauthorization: Bearer abc\r\n"
                + "Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
        assertEquals("POST", r.method);
        assertEquals("/listen", r.path);
        assertTrue(Listening.authorized(r.authorization, "abc"));
    }

    @Test
    public void onlyTheTokenMakesItListen() throws IOException {
        assertFalse("no token", Listening.authorized(read("POST /listen HTTP/1.1\r\n\r\n").authorization, "abc"));
        assertFalse("the wrong one", Listening.authorized("Bearer abd", "abc"));
        assertFalse("none set here", Listening.authorized("Bearer ", ""));
        assertNull("not HTTP", read(""));
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
