package dev.assistant.qingyu.readaloud

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.media.AudioAttributes
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale

class LocalReadAloudModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var speech: TextToSpeech? = null
  private var ready = false
  private var foreground = true
  private var generation = 0
  private var requestId: String? = null
  private val languages = setOf("zh", "en")

  override fun definition() = ModuleDefinition {
    Name("QingyuLocalReadAloud")
    Events("onAvailability", "onPlayback")

    AsyncFunction("getAvailability") {
      ensureEngine()
      availability()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("speak") { id: String, message: String, language: String ->
      speak(id, message, language)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") { id: String ->
      if (requestId == id) stopPlayback()
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground { foreground = true }
    OnActivityEntersBackground {
      foreground = false
      stopPlayback()
    }
    OnActivityDestroys { disposeEngine() }
    OnDestroy { main.post { disposeEngine() } }
  }

  @Suppress("DEPRECATION")
  private fun onlySystemEngines(context: Context): Boolean {
    val services = context.packageManager.queryIntentServices(
      Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE),
      0
    )
    val systemFlags = ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP
    // Android's public TTS client can reconnect to another registered engine.
    return services.isNotEmpty() && services.all { it.serviceInfo.applicationInfo.flags and systemFlags != 0 }
  }

  private fun ensureEngine() {
    val context = appContext.reactContext?.applicationContext ?: return
    if (!onlySystemEngines(context)) {
      disposeEngine()
      return
    }
    if (speech != null) return

    val token = ++generation
    speech = try {
      TextToSpeech(context) { status -> main.post { initialized(token, status) } }
    } catch (_: RuntimeException) {
      return
    }
    // A stalled engine should be retried on the next foreground availability check.
    main.postDelayed({
      if (token == generation && !ready) disposeEngine()
    }, 5000)
  }

  private fun initialized(token: Int, status: Int) {
    if (token != generation) return
    val engine = speech ?: return
    if (status != TextToSpeech.SUCCESS || engine.setOnUtteranceProgressListener(listener) != TextToSpeech.SUCCESS) {
      disposeEngine()
      return
    }
    engine.setAudioAttributes(AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build())
    ready = true
    sendEvent("onAvailability", availability())
  }

  private fun localVoice(voice: Voice): Boolean =
    !voice.isNetworkConnectionRequired &&
      TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in voice.features.orEmpty() &&
      voice.locale.language in languages

  private fun availability(): Bundle = Bundle().apply {
    val installed = if (ready) speech?.voices.orEmpty().filter(::localVoice) else emptyList()
    putStringArrayList("languages", ArrayList(installed.map { it.locale.language }.distinct()))
    putInt("maxInputLength", TextToSpeech.getMaxSpeechInputLength())
  }

  private fun speak(id: String, message: String, language: String): Boolean {
    val context = appContext.reactContext?.applicationContext ?: return false
    if (!foreground || !ready || id.isBlank() || message.isBlank() ||
      message.length > TextToSpeech.getMaxSpeechInputLength() || !onlySystemEngines(context)
    ) return false
    val engine = speech ?: return false
    val voice = engine.voices.orEmpty().filter { localVoice(it) && it.locale.language == language }
      .minWithOrNull(compareBy<Voice> { it.locale != Locale.getDefault() }
        .thenByDescending { it.quality }.thenBy { it.latency }.thenBy { it.name }) ?: return false

    stopPlayback()
    if (engine.setVoice(voice) != TextToSpeech.SUCCESS) return false
    val selected = engine.voice ?: return false
    if (selected.name != voice.name || !localVoice(selected) || selected.locale.language != language) return false

    requestId = id
    if (engine.speak(message, TextToSpeech.QUEUE_FLUSH, Bundle(), id) == TextToSpeech.SUCCESS) return true
    requestId = null
    return false
  }

  private fun notify(id: String, phase: String) {
    sendEvent("onPlayback", Bundle().apply {
      putString("id", id)
      putString("phase", phase)
    })
  }

  private fun stopPlayback() {
    val id = requestId ?: return
    requestId = null
    speech?.stop()
    notify(id, "stopped")
  }

  private fun disposeEngine() {
    generation++
    stopPlayback()
    ready = false
    speech?.shutdown()
    speech = null
  }

  private val listener = object : UtteranceProgressListener() {
    override fun onStart(id: String) = report(id, "started")
    override fun onDone(id: String) = report(id, "finished")
    override fun onStop(id: String, interrupted: Boolean) = report(id, "stopped")
    @Deprecated("Android uses the overload with an error code")
    override fun onError(id: String) = report(id, "failed")
    override fun onError(id: String, errorCode: Int) = report(id, "failed")

    private fun report(id: String, phase: String) {
      main.post {
        if (requestId != id) return@post
        if (phase != "started") requestId = null
        notify(id, phase)
      }
    }
  }
}
