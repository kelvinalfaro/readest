package com.readest.native_tts

import org.junit.Test

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before

/**
 * Example local unit test, which will execute on the development machine (host).
 *
 * See [testing documentation](http://d.android.com/tools/testing).
 */
class ExampleUnitTest {
    @Before
    fun resetActivationState() {
        MediaSessionActivationState.resetForTest()
    }

    @Test
    fun latestDesiredMediaSessionStateWinsBeforeServiceCreation() {
        MediaSessionActivationState.requestActivation()
        MediaSessionActivationState.requestDeactivation()
        assertFalse(MediaSessionActivationState.isActivationDesired())

        MediaSessionActivationState.requestActivation()
        assertTrue(MediaSessionActivationState.isActivationDesired())
    }
}
