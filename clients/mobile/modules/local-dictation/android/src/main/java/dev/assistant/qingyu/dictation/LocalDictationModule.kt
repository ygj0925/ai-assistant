package dev.assistant.qingyu.dictation

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.annotation.RequiresApi
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale
import java.util.concurrent.Executor

class LocalDictationModule : Module() {
  private class Session(val id: String, val recognizer: SpeechRecognizer) {
    var listening = false
    var finishing = false
    var deadline: Runnable? = null
  }

  private val main = Handler(Looper.getMainLooper())
  private val mandarin = BundledMandarin()
  private var current: Session? = null
  private var bundledLocale: Locale? = null
  @Volatile private var foreground = true

  override fun definition() = ModuleDefinition {
    Name("QingyuLocalDictation")
    Events("onDictation")

    AsyncFunction("getLanguage") { promise: Promise -> availability(promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("start") { id: String, language: String -> begin(id, language) }.runOnQueue(Queues.MAIN)
    AsyncFunction("finish") { id: String ->
      current?.takeIf { it.id == id }?.let(::finish)
      mandarin.finish(id)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancel") { id: String ->
      current?.takeIf { it.id == id }?.let { end(it, "cancelled") }
      mandarin.cancel(id)
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground { foreground = true }
    OnActivityEntersBackground { stopInBackground() }
    OnActivityDestroys { stopInBackground() }
    OnDestroy { main.post { stopInBackground() } }
  }

  private fun stopInBackground() {
    foreground = false
    current?.let { end(it, "cancelled") }
    mandarin.cancel()
  }

  private fun createRecognizer(context: Context): SpeechRecognizer? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
    return runCatching {
      if (SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
        SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
      } else null
    }.getOrNull()
  }

  private fun intent(language: String) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    .putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)

  private fun simplifiedMandarin(locale: Locale) = locale.language == "zh" &&
    locale.script in setOf("", "Hans") && locale.country in setOf("", "CN", "SG")

  private fun availability(promise: Promise) {
    val context = appContext.reactContext?.applicationContext
    val locale = Locale.getDefault()
    val localMandarin = context != null && simplifiedMandarin(locale) && mandarin.available(context)
    fun resolve(installed: String?) {
      if (locale != Locale.getDefault()) { promise.resolve(null); return }
      bundledLocale = locale.takeIf { installed == null && localMandarin }
      promise.resolve(installed ?: bundledLocale?.let { "zh-CN" })
    }
    val recognizer = context?.let(::createRecognizer)
    if (recognizer == null) {
      resolve(null)
      return
    }
    val language = locale.toLanguageTag()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      recognizer.destroy()
      resolve(language.takeUnless { localMandarin })
      return
    }
    installedLanguages(recognizer, intent(language)) { languages ->
      recognizer.destroy()
      val installed = languages.firstOrNull { Locale.forLanguageTag(it) == locale }
        ?: languages.firstOrNull {
          val supported = Locale.forLanguageTag(it)
          if (simplifiedMandarin(locale)) simplifiedMandarin(supported) else supported.language == locale.language
        }
      resolve(installed)
    }
  }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun installedLanguages(recognizer: SpeechRecognizer, request: Intent, onChecked: (List<String>) -> Unit) {
    var settled = false
    var timeout: Runnable? = null
    fun settle(result: List<String>) {
      if (settled) return
      settled = true
      timeout?.let(main::removeCallbacks)
      onChecked(result)
    }
    timeout = Runnable { settle(emptyList()) }
    main.postDelayed(timeout, 5_000)
    try {
      recognizer.checkRecognitionSupport(request, Executor { main.post(it) }, object : RecognitionSupportCallback {
        override fun onSupportResult(support: RecognitionSupport) = settle(support.installedOnDeviceLanguages)
        override fun onError(error: Int) = settle(emptyList())
      })
    } catch (_: RuntimeException) {
      settle(emptyList())
    }
  }

  private fun hasMicrophone(context: Context) =
    context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

  private fun begin(id: String, language: String): Boolean {
    val context = appContext.reactContext?.applicationContext ?: return false
    if (!foreground || !hasMicrophone(context) || current != null || mandarin.busy() || id.isBlank() || language.isBlank()) {
      return false
    }
    if (language == "zh-CN" && bundledLocale == Locale.getDefault()) {
      return mandarin.start(context, id, { foreground && hasMicrophone(context) }, ::emit)
    }
    val recognizer = createRecognizer(context) ?: return false
    val session = Session(id, recognizer)
    current = session
    recognizer.setRecognitionListener(listener(session, context))
    val request = intent(language)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      installedLanguages(recognizer, request) { installed ->
        if (current !== session) return@installedLanguages
        if (installed.none { Locale.forLanguageTag(it) == Locale.forLanguageTag(language) }) end(session, "unavailable")
        else listen(session, request, context)
      }
    } else listen(session, request, context)
    return true
  }

  private fun listen(session: Session, request: Intent, context: Context) {
    if (!foreground || !hasMicrophone(context)) {
      end(session, "permission")
      return
    }
    try {
      session.recognizer.startListening(request)
      session.listening = true
      deadline(session, 10_000)
    } catch (_: RuntimeException) {
      end(session, "failed")
    }
  }

  private fun finish(session: Session) {
    if (!session.listening || session.finishing) return
    session.finishing = true
    emit(session, "finishing")
    deadline(session, 8_000)
    try { session.recognizer.stopListening() } catch (_: RuntimeException) { end(session, "failed") }
  }

  private fun deadline(session: Session, delay: Long) {
    session.deadline?.let(main::removeCallbacks)
    val timeout = Runnable { end(session, "failed") }
    session.deadline = timeout
    main.postDelayed(timeout, delay)
  }

  private fun end(session: Session, phase: String, text: String? = null) {
    if (current !== session) return
    current = null
    session.deadline?.let(main::removeCallbacks)
    if (phase == "cancelled" || phase == "failed" || phase == "permission") runCatching { session.recognizer.cancel() }
    runCatching { session.recognizer.destroy() }
    emit(session, phase, text)
  }

  private fun emit(session: Session, phase: String, text: String? = null) = emit(session.id, phase, text)

  private fun emit(id: String, phase: String, text: String?) = sendEvent("onDictation", Bundle().apply {
    putString("id", id)
    putString("phase", phase)
    if (text != null) putString("text", text)
  })

  private fun bestText(results: Bundle?) = results
    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()

  private fun listener(session: Session, context: Context) = object : RecognitionListener {
    override fun onReadyForSpeech(params: Bundle?) {
      if (current !== session) return
      if (!hasMicrophone(context)) {
        end(session, "permission")
        return
      }
      if (!session.finishing) {
        emit(session, "listening")
        deadline(session, 45_000)
      }
    }
    override fun onBeginningOfSpeech() = Unit
    override fun onRmsChanged(rmsdB: Float) = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() {
      if (current !== session) return
      session.finishing = true
      emit(session, "finishing")
      deadline(session, 8_000)
    }
    override fun onError(error: Int) {
      end(session, when (error) {
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission"
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "unavailable"
        else -> "failed"
      })
    }
    override fun onResults(results: Bundle?) {
      if (!foreground || !hasMicrophone(context)) {
        end(session, "permission")
        return
      }
      val transcript = bestText(results)
      end(session, if (transcript.isBlank()) "failed" else "result", transcript)
    }
    override fun onPartialResults(partialResults: Bundle?) {
      if (current !== session) return
      if (!foreground || !hasMicrophone(context)) end(session, "permission")
      else if (!session.finishing) emit(session, "partial", bestText(partialResults))
    }
    override fun onEvent(eventType: Int, params: Bundle?) = Unit
  }
}
