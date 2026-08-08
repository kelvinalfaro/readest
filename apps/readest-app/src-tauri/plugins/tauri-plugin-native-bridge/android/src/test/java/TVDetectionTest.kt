package com.readest.native_bridge

import android.content.res.Configuration
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TVDetectionTest {
    @Test
    fun detectsTelevisionUiMode() {
        assertTrue(isTelevisionDevice(Configuration.UI_MODE_TYPE_TELEVISION, false))
    }

    @Test
    fun detectsLeanbackFeatureFallback() {
        assertTrue(isTelevisionDevice(Configuration.UI_MODE_TYPE_NORMAL, true))
    }

    @Test
    fun leavesPhonesAndTabletsInMobileMode() {
        assertFalse(isTelevisionDevice(Configuration.UI_MODE_TYPE_NORMAL, false))
    }
}
