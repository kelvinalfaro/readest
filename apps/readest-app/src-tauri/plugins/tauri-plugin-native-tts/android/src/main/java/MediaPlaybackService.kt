package com.readest.native_tts

import com.readest.native_tts.R
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.graphics.Bitmap
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media.MediaBrowserServiceCompat
import androidx.media.session.MediaButtonReceiver
import androidx.core.content.FileProvider
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import app.tauri.plugin.JSObject
import org.json.JSONArray
import java.io.File
import java.io.FileOutputStream

internal data class AndroidAutoBook(
    val hash: String,
    val title: String,
    val author: String,
    val isAudiobook: Boolean,
    val coverHash: String?,
    val artworkReady: Boolean,
)

internal object MediaSessionActivationState {
    @Volatile
    private var desiredActive = false
    @Volatile
    private var desiredSessionId: String? = null

    @Synchronized
    fun requestActivation(sessionId: String? = null): Boolean {
        val changed = !desiredActive || desiredSessionId != sessionId
        desiredActive = true
        desiredSessionId = sessionId
        return changed
    }

    @Synchronized
    fun requestDeactivation(sessionId: String? = null): Boolean {
        // A replaced controller can finish its asynchronous teardown after the
        // new book has activated. Never let that stale stop win.
        if (sessionId != null && desiredSessionId != null && sessionId != desiredSessionId) {
            return false
        }
        desiredActive = false
        desiredSessionId = null
        return true
    }

    fun isActivationDesired(): Boolean = desiredActive

    @Synchronized
    fun acceptsUpdate(sessionId: String?): Boolean =
        sessionId == null || (desiredActive && sessionId == desiredSessionId)

    @Synchronized
    fun resetForTest() {
        desiredActive = false
        desiredSessionId = null
    }
}

class MediaPlaybackService : MediaBrowserServiceCompat() {
    private var mediaSession: MediaSessionCompat? = null
    private lateinit var player: ExoPlayer
    private lateinit var stateBuilder: PlaybackStateCompat.Builder
    private lateinit var audioManager: AudioManager

    // True only between session activation (TTS playback started) and
    // deactivation. Android Auto can bind this service at any time to browse,
    // so every playback side effect (audio focus, the silent keep-alive
    // player, the foreground notification) must be gated on this flag.
    private var sessionActive = false

    // Resume after a TRANSIENT focus loss only if the loss is what paused us
    // (nav prompt, call); a user pause before the loss must stay a pause.
    private var resumeOnFocusGain = false

    // The real TTS audio renders in the WebView (or TextToSpeech), so pausing
    // the local keep-alive player alone would keep speech talking over the
    // interrupting audio. Focus changes route through the SAME plugin events
    // as lock-screen buttons; the JS TTSController pause/resume pushes state
    // back down and the keep-alive player follows (applyPlaybackState). The
    // local player is also flipped immediately so the lock-screen card does
    // not lag the round trip.
    private val afChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        Log.i("MediaPlaybackService", "Audio focus changed: $focusChange, playing=${player.isPlaying}")
        when (focusChange) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                if (resumeOnFocusGain) {
                    resumeOnFocusGain = false
                    player.play()
                    pluginEventTrigger?.invoke("media-session-play", JSObject())
                    updatePlaybackState()
                }
            }
            // Spoken audio pauses for transient loss instead of ducking or
            // talking over it (speech ducked under speech is unintelligible);
            // setWillPauseWhenDucked routes CAN_DUCK here rather than letting
            // the system auto-duck.
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                resumeOnFocusGain = player.isPlaying
                if (player.isPlaying) {
                    player.pause()
                    pluginEventTrigger?.invoke("media-session-pause", JSObject())
                    updatePlaybackState()
                }
            }
            // Permanent loss (another media app took over): pause and stay
            // paused; the system never sends a GAIN after this.
            AudioManager.AUDIOFOCUS_LOSS -> {
                resumeOnFocusGain = false
                if (player.isPlaying) {
                    player.pause()
                    pluginEventTrigger?.invoke("media-session-pause", JSObject())
                    updatePlaybackState()
                }
            }
        }
    }

    // Headphones unplugged / Bluetooth dropped: pause, never auto-resume —
    // otherwise spoken audio blasts from the phone speaker.
    private var noisyReceiverRegistered = false
    private val becomingNoisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
            resumeOnFocusGain = false
            if (player.isPlaying) {
                player.pause()
                pluginEventTrigger?.invoke("media-session-pause", JSObject())
                updatePlaybackState()
            }
        }
    }

    // Android O+ default is system auto-duck; declaring speech content and
    // willPauseWhenDucked opts into the audiobook contract (the counterpart of
    // iOS .spokenAudio): nav prompts pause us and GAIN resumes us.
    private var focusRequest: AudioFocusRequest? = null

    private fun requestFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(SPOKEN_MEDIA_ATTRIBUTES)
                .setWillPauseWhenDucked(true)
                .setOnAudioFocusChangeListener(afChangeListener)
                .build()
                .also { focusRequest = it }
            if (audioManager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                Log.w("MediaPlaybackService", "Failed to gain audio focus")
            }
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                afChangeListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            )
        }
    }

    private fun abandonFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            focusRequest = null
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(afChangeListener)
        }
    }

    companion object {
        val SPOKEN_MEDIA_ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        private const val CHANNEL_ID = "media2_playback_channel"
        private const val NOTIFICATION_ID = 1002
        private const val MEDIA_ROOT_ID = "media_root_id"
        private const val LIBRARY_ROOT_ID = "readest_library"
        private const val BOOK_MEDIA_ID_PREFIX = "readest_book:"
        private const val CURRENT_READING_MEDIA_ID = "readest_current_reading"
        private const val RESUME_MEDIA_ID = "readest_resume_last_book"
        const val ACTION_ACTIVATE_SESSION = "ACTIVATE_SESSION"

        private const val PREFS_LAST_BOOK = "media_last_book"
        private const val KEY_HASH = "hash"
        private const val KEY_TITLE = "title"
        private const val KEY_AUTHOR = "author"
        private const val PREFS_MEDIA_LIBRARY = "media_library"
        private const val KEY_LIBRARY_JSON = "books_json"
        private const val COVER_THUMBNAIL_CACHE_DIR = "cover-thumbnails/v1"
        private val MD5_PATTERN = Regex("^[0-9a-fA-F]{32}$")

        @Volatile
        private var pluginEventTrigger: ((String, JSObject) -> Unit)? = null
        @Volatile
        private var pendingBookHash: String? = null

        fun setPluginEventTrigger(trigger: ((String, JSObject) -> Unit)?) {
            val pending = synchronized(this) {
                pluginEventTrigger = trigger
                if (trigger == null) {
                    null
                } else {
                    pendingBookHash.also { pendingBookHash = null }
                }
            }
            if (pending != null && trigger != null) {
                trigger("media-session-play-book", JSObject().apply { put("bookHash", pending) })
            }
        }

        private fun dispatchOrQueueBookPlayback(hash: String): Boolean {
            val trigger = synchronized(this) {
                pendingBookHash = hash
                pluginEventTrigger?.also { pendingBookHash = null }
            }
            trigger?.invoke("media-session-play-book", JSObject().apply { put("bookHash", hash) })
            return trigger != null
        }

        private fun cancelPendingBookPlayback(): Boolean = synchronized(this) {
            val hadPendingSelection = pendingBookHash != null
            pendingBookHash = null
            hadPendingSelection
        }

        // Whether this service should hold the app's audio focus for the
        // current session. True for audio the app renders itself (the
        // TextToSpeech engine, WebAudio, the narration ExoPlayer above).
        //
        // FALSE for audiobook playback, whose audio comes from a WebView
        // <audio> element: Chromium requests AUDIOFOCUS_GAIN for that element
        // under this same uid, which preempts this service's request and
        // delivers AUDIOFOCUS_LOSS here ~15ms later. The listener below then
        // relayed media-session-pause to the WebView, pausing the audiobook a
        // fraction of a second after it started. Chromium keeps the
        // interruption contract for its own element (it pauses on loss and
        // resumes after a transient one), so the service stays out of the way
        // — the ACTION_AUDIO_BECOMING_NOISY receiver and the lock-screen
        // transport controls below are unaffected either way.
        @Volatile
        var ownsAudioFocus: Boolean = true

        var currentTitle: String = "Read Aloud"
        var currentArtist: String = "Reading your content"
        var currentArtwork: Bitmap? = null

        // Stable content:// URI for the current cover (served via FileProvider).
        // Android Auto/the lock screen cache artwork by URI, so per-sentence
        // metadata updates no longer force a bitmap reload — which flashed the
        // cover. The bitmap is still kept for the notification's large icon.
        @Volatile
        var currentArtworkUri: Uri? = null

        // Media browser clients that render the cover and therefore need read
        // access granted to the FileProvider artwork URI.
        private val ARTWORK_URI_CLIENTS = listOf(
            "com.google.android.projection.gearhead",
            "com.google.android.gms",
            "com.android.systemui",
        )

        // Estimated section timeline (Edge/WebAudio engine only) in milliseconds.
        // Drives the lock-screen scrubber: position is the thumb, duration is
        // the track length. Native TextToSpeech has no timeline and leaves
        // duration at 0, so the scrubber simply does not appear there.
        @Volatile
        var currentPositionMs: Long = 0L
        @Volatile
        var currentDurationMs: Long = 0L

        // Last book read aloud, persisted across process death so the Android
        // Auto browse tree can offer a "Resume last book" entry when opened cold
        // (no active session). Hash addresses a readest://book/{hash} resume.
        @Volatile
        var lastBookHash: String? = null
        @Volatile
        var lastBookTitle: String? = null
        @Volatile
        var lastBookAuthor: String? = null

        @Volatile
        private var libraryBooks: List<AndroidAutoBook> = emptyList()
        @Volatile
        private var currentBookHash: String? = null

        fun saveLastBook(context: Context, hash: String, title: String?, author: String?) {
            lastBookHash = hash
            lastBookTitle = title
            lastBookAuthor = author
            context.getSharedPreferences(PREFS_LAST_BOOK, Context.MODE_PRIVATE).edit()
                .putString(KEY_HASH, hash)
                .putString(KEY_TITLE, title)
                .putString(KEY_AUTHOR, author)
                .apply()
        }

        private fun loadLastBook(context: Context) {
            val prefs = context.getSharedPreferences(PREFS_LAST_BOOK, Context.MODE_PRIVATE)
            lastBookHash = prefs.getString(KEY_HASH, null)
            lastBookTitle = prefs.getString(KEY_TITLE, null)
            lastBookAuthor = prefs.getString(KEY_AUTHOR, null)
        }

        internal fun parseLibrary(booksJson: String): List<AndroidAutoBook> {
            val array = JSONArray(booksJson)
            return buildList {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: continue
                    val hash = item.optString("hash").trim()
                    val title = item.optString("title").trim()
                    if (hash.isEmpty() || title.isEmpty()) continue
                    add(
                        AndroidAutoBook(
                            hash = hash,
                            title = title,
                            author = item.optString("author").trim(),
                            isAudiobook = item.optBoolean("isAudiobook", false),
                            coverHash = item.optString("coverHash")
                                .trim()
                                .takeIf { MD5_PATTERN.matches(it) },
                            artworkReady = item.optBoolean("artworkReady", false),
                        )
                    )
                }
            }
        }

        fun saveLibrary(context: Context, booksJson: String) {
            val parsed = parseLibrary(booksJson)
            context.getSharedPreferences(PREFS_MEDIA_LIBRARY, Context.MODE_PRIVATE).edit()
                .putString(KEY_LIBRARY_JSON, booksJson)
                .apply()
            libraryBooks = parsed
            val service = instance ?: return
            Handler(Looper.getMainLooper()).post {
                service.notifyChildrenChanged(MEDIA_ROOT_ID)
                service.notifyChildrenChanged(LIBRARY_ROOT_ID)
            }
        }

        private fun loadLibrary(context: Context) {
            val json = context.getSharedPreferences(PREFS_MEDIA_LIBRARY, Context.MODE_PRIVATE)
                .getString(KEY_LIBRARY_JSON, "[]") ?: "[]"
            libraryBooks = try {
                parseLibrary(json)
            } catch (e: Exception) {
                Log.w("MediaPlaybackService", "Ignoring invalid Android Auto library", e)
                emptyList()
            }
        }

        @Volatile
        private var instance: MediaPlaybackService? = null

        // Deactivate via an in-process call instead of stopService: while a
        // media browser client (Android Auto) keeps the service bound,
        // stopService neither runs onDestroy nor clears the foreground
        // notification, so playback teardown has to happen on the live
        // instance.
        fun requestActivation(sessionId: String?, bookHash: String?) {
            val changed = MediaSessionActivationState.requestActivation(sessionId)
            if (bookHash != null) currentBookHash = bookHash
            if (!changed) return

            // Never carry the previous book's decoded bitmap into the new
            // session. The live service seeds the matching cached library
            // thumbnail immediately; the full artwork can replace it later.
            currentArtwork = null
            currentArtworkUri = null
            currentPositionMs = 0L
            currentDurationMs = 0L
            val service = instance ?: return
            Handler(Looper.getMainLooper()).post {
                service.resetArtworkForBook(bookHash)
            }
        }

        fun requestDeactivation(sessionId: String? = null) {
            if (!MediaSessionActivationState.requestDeactivation(sessionId)) return
            val service = instance ?: return
            Handler(Looper.getMainLooper()).post {
                // A newer start may have arrived while this main-thread task
                // was queued; never let an old stop tear down the new session.
                if (!MediaSessionActivationState.isActivationDesired()) {
                    service.deactivateSession()
                }
            }
        }

        // Deliver metadata/state updates to the live service in-process rather
        // than via startService(): once the app is backgrounded, startService()
        // is rejected with "app is in background" (the Android 8+ background
        // service-start restriction), which silently dropped every playback
        // update — killing the lock-screen control and the notification refresh
        // that keeps the foreground service alive. A direct call on the running
        // instance is not a service *start*, so it is exempt. The statics are
        // refreshed regardless so a not-yet-created service picks them up when
        // it activates.
        fun pushMetadata(sessionId: String?, title: String, artist: String, artwork: Bitmap?) {
            if (!MediaSessionActivationState.acceptsUpdate(sessionId)) return
            currentTitle = title
            currentArtist = artist
            if (artwork != null) currentArtwork = artwork
            val service = instance ?: return
            Handler(Looper.getMainLooper()).post { service.applyMetadata() }
        }

        // position/duration are null when the update only reports a play/pause
        // flip (that payload omits them); keep the last known values so the
        // scrubber does not snap back to 0 on pause.
        fun pushPlaybackState(
            sessionId: String?,
            playing: Boolean,
            position: Long?,
            duration: Long?,
        ) {
            if (!MediaSessionActivationState.acceptsUpdate(sessionId)) return
            if (position != null) currentPositionMs = position
            if (duration != null) currentDurationMs = duration
            val service = instance ?: return
            Handler(Looper.getMainLooper()).post { service.applyPlaybackState(playing) }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        // Android Auto binds this service cold (no session); restore the
        // persisted library and last-book fallback before it requests a root.
        loadLastBook(this)
        loadLibrary(this)

        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        player = ExoPlayer.Builder(this).build()

        mediaSession = MediaSessionCompat(baseContext, "ReadestMediaSession").apply {
            stateBuilder = PlaybackStateCompat.Builder().setActions(
                PlaybackStateCompat.ACTION_PLAY or
                PlaybackStateCompat.ACTION_PLAY_PAUSE or
                PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_STOP or
                PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                PlaybackStateCompat.ACTION_SEEK_TO or
                PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID or
                PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH
            )
            setPlaybackState(
                stateBuilder.setState(PlaybackStateCompat.STATE_STOPPED, 0L, 1f).build()
            )
            setCallback(SessionCallback())
            // A browser client can select a book while no TTS session is
            // already playing. Keep the media session command-ready for the
            // lifetime of the bound service; sessionActive separately gates
            // audio focus, foreground state, and the silent route keeper.
            isActive = true
            setSessionToken(sessionToken)
        }
        currentBookHash?.let { resetArtworkForBook(it) }

        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                updatePlaybackState()
            }
            override fun onPlaybackStateChanged(playbackState: Int) {
                updatePlaybackState()
            }
        })
    }

    private fun activateSession() {
        Log.d("MediaPlaybackService", "activateSession (wasActive=$sessionActive, focus=$ownsAudioFocus)")
        if (!sessionActive) {
            sessionActive = true

            if (ownsAudioFocus) requestFocus()
            if (!noisyReceiverRegistered) {
                noisyReceiverRegistered = true
                ContextCompat.registerReceiver(
                    this,
                    becomingNoisyReceiver,
                    IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                    ContextCompat.RECEIVER_NOT_EXPORTED
                )
            }

            // Silent keep-alive track: holds the audio route while the actual
            // TTS audio comes from the WebView or TextToSpeech engine. Prepare
            // it paused. The JS controller publishes PLAYING only after real
            // audio starts, so Android Auto never shows a premature pause
            // button that cannot control anything yet.
            val mediaItem = MediaItem.fromUri("asset:///silence.mp3")
            player.setMediaItem(mediaItem)
            player.repeatMode = Player.REPEAT_MODE_ONE
            player.prepare()
            player.playWhenReady = false

            mediaSession?.isActive = true
            mediaSession?.setPlaybackState(
                stateBuilder.setState(PlaybackStateCompat.STATE_PAUSED, currentPositionMs, 1f).build()
            )
            notifyChildrenChanged(MEDIA_ROOT_ID)
        }
        // Always post the notification: activation arrives through
        // startForegroundService, which requires startForeground promptly.
        showNotification(PlaybackStateCompat.STATE_PAUSED)
    }

    private fun deactivateSession() {
        if (!sessionActive) return
        sessionActive = false

        player.playWhenReady = false
        player.stop()
        resumeOnFocusGain = false
        abandonFocus()
        if (noisyReceiverRegistered) {
            noisyReceiverRegistered = false
            unregisterReceiver(becomingNoisyReceiver)
        }

        mediaSession?.setPlaybackState(
            stateBuilder.setState(PlaybackStateCompat.STATE_STOPPED, 0L, 1f).build()
        )
        notifyChildrenChanged(MEDIA_ROOT_ID)

        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private inner class SessionCallback : MediaSessionCompat.Callback() {
        override fun onPlay() {
            if (!sessionActive) {
                val hash = currentBookHash ?: lastBookHash
                if (hash != null) {
                    onPlayFromMediaId("$BOOK_MEDIA_ID_PREFIX$hash", null)
                    return
                }
            }
            // A route may have changed while paused (Bluetooth headphones to
            // Android Auto, or the reverse). Re-requesting focus immediately
            // before playback makes Android bind this session to the current
            // media route instead of retaining the previous device.
            if (ownsAudioFocus) requestFocus()
            player.play()
            pluginEventTrigger?.invoke("media-session-play", JSObject())
            updatePlaybackState()
        }

        override fun onPause() {
            // An explicit user pause must stick: cancel any pending
            // resume-after-interruption.
            resumeOnFocusGain = false
            player.pause()
            if (!sessionActive) {
                cancelPendingBookPlayback()
                // The selection may already have crossed into the WebView's
                // readiness queue. Relay Pause there as well so it cannot
                // auto-start after the driver has cancelled it.
                pluginEventTrigger?.invoke("media-session-pause", JSObject())
                mediaSession?.setPlaybackState(
                    stateBuilder.setState(PlaybackStateCompat.STATE_PAUSED, currentPositionMs, 1f).build()
                )
                return
            }
            pluginEventTrigger?.invoke("media-session-pause", JSObject())
            updatePlaybackState()
        }

        // Next/previous just relay the intent to the WebView, which owns the
        // real paragraph navigation and pushes the new metadata/state back.
        // Seeking the silent keep-alive player here does nothing useful and
        // muddied the transition, so the JS side (ttsMediaBridge) holds an
        // optimistic playing state until the skipped-to segment speaks.
        override fun onSkipToNext() {
            pluginEventTrigger?.invoke("media-session-next", JSObject())
        }

        override fun onSkipToPrevious() {
            pluginEventTrigger?.invoke("media-session-previous", JSObject())
        }

        // Scrubber drag: hand the target back to the JS controller, which owns
        // the real audio timeline (seekToTime), and optimistically move the
        // thumb so the lock screen feels responsive before the seek lands.
        override fun onSeekTo(pos: Long) {
            currentPositionMs = pos
            pluginEventTrigger?.invoke("media-session-seek", JSObject().apply { put("position", pos) })
            val state = if (player.isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
            mediaSession?.setPlaybackState(
                stateBuilder.setState(state, pos, 1f).build()
            )
        }

        override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
            if (sessionActive && mediaId == CURRENT_READING_MEDIA_ID) {
                onPlay()
                return
            }
            val hash = when {
                mediaId?.startsWith(BOOK_MEDIA_ID_PREFIX) == true ->
                    mediaId.removePrefix(BOOK_MEDIA_ID_PREFIX).takeIf { it.isNotEmpty() }
                mediaId?.startsWith("$RESUME_MEDIA_ID:") == true ->
                    mediaId.removePrefix("$RESUME_MEDIA_ID:").takeIf { it.isNotEmpty() }
                else -> lastBookHash
            } ?: return

            val selectedBook = libraryBooks.firstOrNull { it.hash == hash }
            if (selectedBook != null) {
                currentTitle = selectedBook.title
                currentArtist = selectedBook.author
                currentPositionMs = 0L
                currentBookHash = hash
                resetArtworkForBook(hash)
            }
            // A playable-item request is asynchronous: the WebView still has
            // to open the book and initialize its saved reader/player state.
            // Report that work immediately so Android Auto keeps the selection
            // alive instead of timing out with "Could not load your selection."
            mediaSession?.setPlaybackState(
                stateBuilder.setState(PlaybackStateCompat.STATE_BUFFERING, 0L, 1f).build()
            )

            // Normal case: the app process is alive in the background. Let the
            // global bridge select the book and start the existing ebook TTS or
            // audiobook player without trying to display phone UI in the car.
            if (dispatchOrQueueBookPlayback(hash)) return

            // Cold process fallback: wake the existing app through an explicit
            // PendingIntent. Direct startActivity() calls from a bound media
            // service are silently blocked by Android's background-activity
            // launch rules on current releases. The queued book selection is
            // delivered when the WebView republishes its media bridge.
            val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            } ?: Intent(Intent.ACTION_VIEW, Uri.parse(
                if (selectedBook?.isAudiobook == true) "readest://book/$hash"
                else "readest://book/$hash?autoplay=tts"
            )).setPackage(packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                val creatorOptions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                    ActivityOptions.makeBasic().apply {
                        pendingIntentCreatorBackgroundActivityStartMode =
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
                                // Android 16 split the old ALLOWED mode. Android
                                // Auto is a connected-device initiated action,
                                // so the cold launch needs the companion-style
                                // privilege that can start while the phone UI is
                                // not visible.
                                ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_ALWAYS
                            } else {
                                ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                            }
                    }.toBundle()
                } else {
                    null
                }
                val pendingIntent = PendingIntent.getActivity(
                    this@MediaPlaybackService,
                    hash.hashCode(),
                    launchIntent,
                    PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    creatorOptions,
                )
                Log.i("MediaPlaybackService", "Sending cold Android Auto launch for $hash")
                val senderOptions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    ActivityOptions.makeBasic().apply {
                        pendingIntentBackgroundActivityStartMode =
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
                                ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_ALWAYS
                            } else {
                                ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                            }
                    }.toBundle()
                } else {
                    null
                }
                pendingIntent.send(
                    this@MediaPlaybackService,
                    0,
                    null,
                    null,
                    null,
                    null,
                    senderOptions,
                )
                Log.i("MediaPlaybackService", "Cold Android Auto launch sent for $hash")
            } catch (e: Exception) {
                Log.e("MediaPlaybackService", "Failed to launch reader for resume", e)
            }
        }

        override fun onPlayFromSearch(query: String?, extras: Bundle?) {
            onPlay()
        }
    }

    private fun updatePlaybackState() {
        if (!sessionActive) return
        val state = if (player.isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        // Report the WebView playback position (currentPositionMs), NOT the
        // silent keep-alive player's position. silence.mp3 is a 10s loop, so
        // player.currentPosition saturates at ~10s and would freeze the car /
        // lock-screen scrubber there while the book plays on.
        mediaSession?.setPlaybackState(
            stateBuilder.setState(state, currentPositionMs, 1f).build()
        )
        showNotification(state)
    }

    // Last section duration written to the session metadata; the scrubber only
    // needs a metadata refresh when it actually changes (per section), not on
    // every position tick.
    private var appliedDurationMs: Long = -1L

    // Guards against rewriting the cache file on every (per-sentence) metadata
    // build: the URI is only re-published when the cover bitmap itself changes.
    private var artworkUriSource: Bitmap? = null
    private var artworkUriFile: File? = null

    private fun resetArtworkForBook(bookHash: String?) {
        artworkUriSource = null
        artworkUriFile?.delete()
        artworkUriFile = null
        currentArtwork = null
        currentArtworkUri = bookHash
            ?.let { hash -> libraryBooks.firstOrNull { it.hash == hash } }
            ?.let(::libraryArtworkUri)
        appliedDurationMs = -1L
        applyMetadata()
    }

    // Packages that have opened the browse tree (Android Auto's projection, the
    // media system components). The cover URI is cross-UID, so each must be
    // granted read access or its art loader hits a SecurityException and the
    // cover shows blank.
    private val browserClients =
        java.util.Collections.synchronizedSet(mutableSetOf<String>())

    private fun grantArtworkTo(pkg: String, artworkUri: Uri? = currentArtworkUri) {
        val uri = artworkUri ?: return
        try {
            grantUriPermission(pkg, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: Exception) {
            Log.w("MediaPlaybackService", "grant artwork to $pkg failed", e)
        }
    }

    // Materialize currentArtwork as a stable content:// URI (once per cover) so
    // clients cache it instead of reloading the bitmap on every metadata update.
    // A fresh filename per cover keeps the URI stable within a book but changed
    // across books, so a new cover still refreshes. Cheap no-op while unchanged.
    private fun refreshArtworkUri() {
        val art = currentArtwork ?: return
        if (art !== artworkUriSource || currentArtworkUri == null) {
            try {
                // Android Auto caches artwork by URI. A counter restarted at
                // zero after process death and reused tts_cover_0.png, so the
                // car kept an older book's pixels. createTempFile preserves a
                // fresh URI across both book switches and process restarts.
                val bookPrefix = currentBookHash?.take(12) ?: "session"
                val file = File.createTempFile("tts_cover_${bookPrefix}_", ".png", cacheDir)
                FileOutputStream(file).use { out -> art.compress(Bitmap.CompressFormat.PNG, 100, out) }
                artworkUriFile?.delete()
                artworkUriFile = file
                currentArtworkUri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
                artworkUriSource = art
            } catch (e: Exception) {
                Log.w("MediaPlaybackService", "Failed to publish artwork uri", e)
                return
            }
        }
        // Re-grant every build: a client may connect before or after the cover
        // is set, and the grant is cheap + idempotent.
        for (pkg in ARTWORK_URI_CLIENTS) grantArtworkTo(pkg)
        for (pkg in browserClients.toList()) grantArtworkTo(pkg)
    }

    private fun libraryArtworkUri(book: AndroidAutoBook): Uri? {
        if (!book.artworkReady || !MD5_PATTERN.matches(book.hash)) return null
        val cacheKey = book.coverHash ?: "legacy"
        val file = File(cacheDir, "$COVER_THUMBNAIL_CACHE_DIR/${book.hash}-$cacheKey.jpg")
        if (!file.isFile) return null
        return try {
            FileProvider.getUriForFile(this, "$packageName.fileprovider", file).also { uri ->
                for (pkg in ARTWORK_URI_CLIENTS) grantArtworkTo(pkg, uri)
                for (pkg in browserClients.toList()) grantArtworkTo(pkg, uri)
            }
        } catch (e: Exception) {
            Log.w("MediaPlaybackService", "Failed to publish library artwork for ${book.hash}", e)
            null
        }
    }

    private fun buildLibraryBookMetadata(book: AndroidAutoBook): MediaMetadataCompat {
        val builder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, book.title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, book.author)
        libraryArtworkUri(book)?.let { uri ->
            builder.putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ART_URI, uri.toString())
            builder.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON_URI, uri.toString())
        }
        return builder.build()
    }

    private fun buildMediaMetadata(): MediaMetadataCompat {
        refreshArtworkUri()
        val builder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
            .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, currentArtwork)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, currentDurationMs)
        currentArtworkUri?.let {
            builder.putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ART_URI, it.toString())
            builder.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON_URI, it.toString())
        }
        return builder.build()
    }

    // Push the current statics into the live session + notification. Invoked
    // in-process from Companion.pushMetadata on the main thread.
    private fun applyMetadata() {
        appliedDurationMs = currentDurationMs
        mediaSession?.setMetadata(buildMediaMetadata())
        notifyChildrenChanged(MEDIA_ROOT_ID)
        if (sessionActive) {
            showNotification(
                if (player.isPlaying) PlaybackStateCompat.STATE_PLAYING
                else PlaybackStateCompat.STATE_PAUSED
            )
        }
    }

    // Reflect the WebView/TextToSpeech playback state onto the silent
    // keep-alive player, the media session, and the notification. Invoked
    // in-process from Companion.pushPlaybackState on the main thread; reads the
    // preserved position/duration statics.
    private fun applyPlaybackState(playing: Boolean) {
        if (!sessionActive) return
        if (playing && !player.isPlaying) {
            if (ownsAudioFocus) requestFocus()
            player.play()
        } else if (!playing && player.isPlaying) {
            player.pause()
        }
        // Do NOT seek the silent keep-alive player to currentPositionMs: it is a
        // 10s loop, so seeking past its end clamps (and can trip STATE_ENDED).
        // Its position is never read for the scrubber; only play/pause matters.
        val state = if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        mediaSession?.setPlaybackState(
            stateBuilder.setState(state, currentPositionMs, 1f).build()
        )
        // Refresh the scrubber length when the section duration changes.
        if (currentDurationMs != appliedDurationMs) {
            appliedDurationMs = currentDurationMs
            mediaSession?.setMetadata(buildMediaMetadata())
        }
        showNotification(state)
    }

    private fun showNotification(playbackState: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Media Controls", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        // Promote with an explicit mediaPlayback type (required/robust on
        // targetSdk 34+); ServiceCompat handles the pre-Q signature. A throw
        // here means the service never becomes foreground and the OS reclaims
        // it on idle, so surface it loudly instead of swallowing.
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(playbackState),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
            Log.d("MediaPlaybackService", "startForeground ok (state=$playbackState)")
        } catch (e: Exception) {
            Log.e("MediaPlaybackService", "startForeground failed", e)
        }
    }

    private fun buildNotification(playbackState: Int): Notification {
        val builder = NotificationCompat.Builder(this, CHANNEL_ID).apply {
            setContentTitle(currentTitle)
            setContentText(currentArtist)
            setLargeIcon(currentArtwork)
            setContentIntent(mediaSession!!.controller.sessionActivity)
            setDeleteIntent(MediaButtonReceiver.buildMediaButtonPendingIntent(this@MediaPlaybackService, PlaybackStateCompat.ACTION_STOP))
            setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            setSmallIcon(R.drawable.notification_icon)

            addAction(
                android.R.drawable.ic_media_previous,
                "Previous",
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this@MediaPlaybackService,
                    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                )
            )
            if (playbackState == PlaybackStateCompat.STATE_PLAYING) {
                addAction(
                    android.R.drawable.ic_media_pause,
                    "Pause",
                    MediaButtonReceiver.buildMediaButtonPendingIntent(
                        this@MediaPlaybackService,
                        PlaybackStateCompat.ACTION_PAUSE
                    )
                )
            } else {
                addAction(
                    android.R.drawable.ic_media_play,
                    "Play",
                    MediaButtonReceiver.buildMediaButtonPendingIntent(
                        this@MediaPlaybackService,
                        PlaybackStateCompat.ACTION_PLAY
                    )
                )
            }

            addAction(
                android.R.drawable.ic_media_next,
                "Next",
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this@MediaPlaybackService,
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                )
            )

            setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(mediaSession?.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
        }
        return builder.build()
    }

    override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot? {
        // Grant the cover URI to the connecting browser client (Android Auto,
        // the media system UI) so its art loader can read it across UIDs.
        browserClients.add(clientPackageName)
        grantArtworkTo(clientPackageName)
        return BrowserRoot(MEDIA_ROOT_ID, null)
    }

    override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaBrowserCompat.MediaItem>>) {
        val items = mutableListOf<MediaBrowserCompat.MediaItem>()
        if (parentId == MEDIA_ROOT_ID && sessionActive) {
            refreshArtworkUri()
            val description = MediaDescriptionCompat.Builder()
                .setMediaId(CURRENT_READING_MEDIA_ID)
                .setTitle(currentTitle)
                .setSubtitle(currentArtist)
                .setIconUri(currentArtworkUri)
                .build()
            items.add(MediaBrowserCompat.MediaItem(description, MediaBrowserCompat.MediaItem.FLAG_PLAYABLE))
        }
        if (parentId == MEDIA_ROOT_ID && libraryBooks.isNotEmpty()) {
            val description = MediaDescriptionCompat.Builder()
                .setMediaId(LIBRARY_ROOT_ID)
                .setTitle("Library")
                .setSubtitle("${libraryBooks.size} books")
                .build()
            items.add(
                MediaBrowserCompat.MediaItem(
                    description,
                    MediaBrowserCompat.MediaItem.FLAG_BROWSABLE,
                )
            )
        }
        if (parentId == LIBRARY_ROOT_ID) {
            for (book in libraryBooks) {
                val description = MediaDescriptionCompat.Builder()
                    .setMediaId("$BOOK_MEDIA_ID_PREFIX${book.hash}")
                    .setTitle(book.title)
                    .setSubtitle(book.author)
                    .setIconUri(libraryArtworkUri(book))
                    .build()
                items.add(
                    MediaBrowserCompat.MediaItem(
                        description,
                        MediaBrowserCompat.MediaItem.FLAG_PLAYABLE,
                    )
                )
            }
        }
        result.sendResult(items)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_ACTIVATE_SESSION -> {
                if (MediaSessionActivationState.isActivationDesired()) {
                    activateSession()
                } else {
                    // startForegroundService was already issued before the
                    // stop arrived. Satisfy its foreground contract, then
                    // discard the stale activation without reviving playback.
                    showNotification(PlaybackStateCompat.STATE_PAUSED)
                    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    stopSelf(startId)
                }
            }
            Intent.ACTION_MEDIA_BUTTON -> {
                if (sessionActive) {
                    MediaButtonReceiver.handleIntent(mediaSession, intent)
                } else {
                    // MediaButtonReceiver cold-starts this service with
                    // startForegroundService; honor the foreground contract,
                    // then back out — there is no TTS session to control.
                    showNotification(PlaybackStateCompat.STATE_PAUSED)
                    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    stopSelf(startId)
                }
            }
        }

        return super.onStartCommand(intent, flags, startId)
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
        if (noisyReceiverRegistered) {
            noisyReceiverRegistered = false
            unregisterReceiver(becomingNoisyReceiver)
        }
        abandonFocus()
        player.release()
        mediaSession?.release()
    }
}
