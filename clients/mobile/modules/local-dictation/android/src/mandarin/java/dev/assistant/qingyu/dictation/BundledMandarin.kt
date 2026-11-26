package dev.assistant.qingyu.dictation

import android.annotation.SuppressLint
import android.app.AppOpsManager
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import androidx.annotation.RequiresApi
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineZipformer2CtcModelConfig
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.math.min

internal class BundledMandarin {
  private enum class Stop { LISTEN, FINISH, DISCARD }

  private class Capture(val id: String, val emit: (String, String, String?) -> Unit) {
    val stop = AtomicReference(Stop.LISTEN)
    var watchdog: Runnable? = null
    var audio: AudioRecord? = null
  }

  private val main = Handler(Looper.getMainLooper())
  private var current: Capture? = null
  private var workerActive = false
  fun busy() = workerActive

  fun available(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !Process.is64Bit()) return false
    return runCatching {
      context.assets.open("$asset/model.int8.onnx").use { it.read() != -1 } &&
        context.assets.open("$asset/tokens.txt").use { it.read() != -1 }
    }.getOrDefault(false)
  }

  fun start(context: Context, id: String, permitted: () -> Boolean, emit: (String, String, String?) -> Unit): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || workerActive || !available(context) || !permitted()) return false
    val capture = Capture(id, emit)
    current = capture
    workerActive = true
    watch(capture, loadLimitMillis) { discard(capture, "failed") }
    thread(name = "QingyuMandarin", isDaemon = true) { recognize(context, capture, permitted) }
    return true
  }

  fun finish(id: String) {
    val capture = current?.takeIf { it.id == id } ?: return
    if (capture.stop.compareAndSet(Stop.LISTEN, Stop.FINISH)) {
      finishing(capture)
    }
  }

  fun cancel(id: String? = null) {
    val capture = current?.takeIf { id == null || it.id == id } ?: return
    discard(capture, "cancelled")
  }

  private fun finishing(capture: Capture) {
    halt(capture)
    capture.emit(capture.id, "finishing", null)
    watch(capture, finishLimitMillis) { discard(capture, "failed") }
  }

  private fun watch(capture: Capture, millis: Long, elapsed: () -> Unit) {
    capture.watchdog?.let(main::removeCallbacks)
    capture.watchdog = Runnable { if (current === capture) elapsed() }.also { main.postDelayed(it, millis) }
  }

  private fun discard(capture: Capture, phase: String) {
    current = null
    capture.watchdog?.let(main::removeCallbacks)
    capture.stop.set(Stop.DISCARD)
    halt(capture)
    capture.emit(capture.id, phase, null)
  }

  private fun halt(capture: Capture) = synchronized(capture) {
    capture.audio?.let { audio ->
      runCatching { if (audio.recordingState == AudioRecord.RECORDSTATE_RECORDING) audio.stop() }
    }
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  @SuppressLint("MissingPermission")
  private fun recognize(context: Context, capture: Capture, permitted: () -> Boolean) {
    val pcm = ShortArray(chunkFrames)
    val samples = FloatArray(chunkFrames)
    val startedAt = SystemClock.elapsedRealtime()
    var recognizer: OnlineRecognizer? = null
    var stream: OnlineStream? = null
    var recorder: AudioRecord? = null
    var result: String? = null
    var phase = "failed"
    val ops = context.getSystemService(AppOpsManager::class.java)
    fun checkAccess() {
      check(capture.stop.get() != Stop.DISCARD)
      val mode = ops?.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_RECORD_AUDIO, Process.myUid(), context.packageName)
      if (!permitted() || mode == AppOpsManager.MODE_IGNORED || mode == AppOpsManager.MODE_ERRORED ||
          recorder?.activeRecordingConfiguration?.isClientSilenced == true) {
        throw SecurityException("Microphone access ended")
      }
    }
    try {
      checkAccess()
      val local = OnlineRecognizer(context.assets, OnlineRecognizerConfig(
        featConfig = FeatureConfig(sampleRate = rate, featureDim = 80),
        modelConfig = OnlineModelConfig(zipformer2Ctc = OnlineZipformer2CtcModelConfig("$asset/model.int8.onnx"),
          tokens = "$asset/tokens.txt", numThreads = 1, provider = "cpu"),
        enableEndpoint = false,
      ))
      recognizer = local
      val decoding = local.createStream()
      stream = decoding
      checkAccess()
      check(SystemClock.elapsedRealtime() - startedAt < loadLimitMillis)

      val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      check(minimum in 1..(rate * 2))
      val audio = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.MIC)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setBufferSizeInBytes(maxOf(minimum, chunkFrames * 4)).build()
      recorder = audio
      synchronized(capture) {
        capture.audio = audio
        checkAccess()
        check(audio.state == AudioRecord.STATE_INITIALIZED)
        audio.startRecording()
        check(audio.recordingState == AudioRecord.RECORDSTATE_RECORDING)
      }
      main.post {
        if (current === capture && permitted()) {
          watch(capture, captureLimitMillis) { finish(capture.id) }
          capture.emit(capture.id, "listening", null)
        }
      }
      val deadline = SystemClock.elapsedRealtime() + captureLimitMillis
      var frames = 0
      var filled = 0
      var lastText = ""
      var nextPartial = 0L
      while (frames < maxFrames && capture.stop.get() == Stop.LISTEN && SystemClock.elapsedRealtime() < deadline) {
        checkAccess()
        val count = audio.read(pcm, filled, min(chunkFrames - filled, maxFrames - frames), AudioRecord.READ_NON_BLOCKING)
        if (capture.stop.get() != Stop.LISTEN) break
        check(count >= 0)
        if (count == 0) { Thread.sleep(12); continue }
        frames += count
        filled += count
        if (filled < chunkFrames) continue
        for (index in pcm.indices) samples[index] = pcm[index] / 32768f
        decoding.acceptWaveform(samples, rate)
        while (capture.stop.get() == Stop.LISTEN && local.isReady(decoding)) {
          checkAccess()
          check(SystemClock.elapsedRealtime() < deadline + finishLimitMillis)
          local.decode(decoding)
        }
        filled = 0
        val now = SystemClock.elapsedRealtime()
        if (now < nextPartial) continue
        nextPartial = now + 250L
        val text = transcript(local.getResult(decoding).text)
        if (text == lastText) continue
        lastText = text
        main.post {
          if (current === capture && capture.stop.get() == Stop.LISTEN && permitted()) {
            capture.emit(capture.id, "partial", text)
          }
        }
      }
      checkAccess()
      halt(capture)
      if (capture.stop.compareAndSet(Stop.LISTEN, Stop.FINISH)) {
        main.post { if (current === capture) finishing(capture) }
      }
      if (frames == 0) return
      if (filled > 0) decoding.acceptWaveform(FloatArray(filled) { pcm[it] / 32768f }, rate)
      decoding.acceptWaveform(FloatArray(tailFrames), rate)
      decoding.inputFinished()
      val finishAt = SystemClock.elapsedRealtime() + finishLimitMillis
      while (local.isReady(decoding)) {
        checkAccess()
        check(SystemClock.elapsedRealtime() < finishAt)
        local.decode(decoding)
      }
      checkAccess()
      result = transcript(local.getResult(decoding).text).takeIf { it.isNotBlank() }
      if (result != null) phase = "result"
    } catch (_: SecurityException) {
      phase = "permission"
    } catch (_: LinkageError) {
      phase = "unavailable"
    } catch (_: Exception) {
      phase = "failed"
    } finally {
      pcm.fill(0)
      samples.fill(0f)
      synchronized(capture) {
        halt(capture)
        capture.audio = null
        runCatching { recorder?.release() }
      }
      runCatching { stream?.release() }
      runCatching { recognizer?.release() }
      main.post {
        workerActive = false
        capture.watchdog?.let(main::removeCallbacks)
        if (current === capture) {
          current = null
          if (permitted()) capture.emit(capture.id, phase, result)
          else capture.emit(capture.id, "permission", null)
        }
      }
    }
  }

  private fun transcript(raw: String): String {
    val points = raw.replace("<unk>", "").replace("unk>", "").trim()
      .codePoints().filter { !Character.isISOControl(it) }.limit(2_000).toArray()
    return if (points.any { Character.UnicodeScript.of(it) == Character.UnicodeScript.HAN }) {
      String(points, 0, points.size)
    } else ""
  }

  private companion object {
    const val asset = "qingyu-mandarin"
    const val rate = 16000
    const val chunkFrames = rate / 10
    const val tailFrames = 4800
    const val maxFrames = rate * 30
    const val loadLimitMillis = 8_000L
    const val captureLimitMillis = 30_000L
    const val finishLimitMillis = 2_000L
  }
}
