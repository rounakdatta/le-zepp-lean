package club.taptappers.lezepplean.helper;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ReporterTest {
    @Test
    public void anUndeliveredStateIsTriedAgainSoonThenLessOftenButNeverGivenUp() {
        assertEquals(2_000, Reporter.retryDelayMs(1));
        assertEquals(4_000, Reporter.retryDelayMs(2));
        assertEquals(8_000, Reporter.retryDelayMs(3));
        assertEquals(16_000, Reporter.retryDelayMs(4));
        assertEquals(30_000, Reporter.retryDelayMs(5));
        assertEquals(30_000, Reporter.retryDelayMs(500));
    }

    @Test
    public void onlyWhatTryingAgainCanFixIsTriedAgain() {
        assertTrue("no answer at all", Reporter.retryable(-1));
        assertTrue("the server restarting", Reporter.retryable(502));
        assertTrue(Reporter.retryable(503));
        assertTrue(Reporter.retryable(429));
        assertFalse("delivered", Reporter.retryable(200));
        assertFalse("a refused token needs the person, not a retry", Reporter.retryable(401));
        assertFalse(Reporter.retryable(422));
    }
}
