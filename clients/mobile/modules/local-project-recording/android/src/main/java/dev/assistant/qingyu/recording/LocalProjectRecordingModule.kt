package dev.assistant.qingyu.recording

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.RequiresApi
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.math.min

class LocalProjectRecordingModule : Module() {
  private enum class Stop { RECORDING, FINISH, DISCARD }

  private class Capture(val id: String) {
    val samples = ShortArray(maxFrames)
    val stop = AtomicReference(Stop.RECORDING)
  }

  private data class Clip(val capture: Capture, val frames: Int)
  private data class Playback(val id: String, val track: AudioTrack, val audio: AudioManager,
    val focus: AudioFocusRequest, val deadline: Runnable)

  private val main = Handler(Looper.getMainLooper())
  private var foreground = true
  private var workerActive = false
  private var capture: Capture? = null
  private var clip: Clip? = null
  private var playback: Playback? = null
  private val guard = object : Runnable {
    override fun run() {
      if (capture == null && clip == null) return
      val failure = checkAccess(appContext.reactContext)
      if (failure != null) discard(failure) else main.postDelayed(this, checkMillis)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("QingyuLocalProjectRecording")
    Events("onProjectRecording")

    Function("supported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q }
    AsyncFunction("start") { id: String -> start(id) }.runOnQueue(Queues.MAIN)
    AsyncFunction("finish") { id: String ->
      capture?.takeIf { it.id == id }?.stop?.compareAndSet(Stop.RECORDING, Stop.FINISH)
      Unit
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("discard") { id: String ->
      if (capture?.id == id || clip?.capture?.id == id) discard("discarded")
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("copyClip") { id: String -> copyClip(id) }.runOnQueue(Queues.MAIN)
    AsyncFunction("play") { id: String -> play(id) }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopPlayback") { id: String ->
      if (playback?.id == id) stopPlayback()
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground { foreground = true }
    OnActivityEntersBackground { foreground = false; discard("discarded") }
    OnActivityDestroys { foreground = false; discard("discarded") }
    OnDestroy { main.post { foreground = false; discard("discarded") } }
  }

  private fun checkAccess(context: Context?): String? {
    if (!foreground || context == null) return "discarded"
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return "permission"
    val connected = runCatching {
      val network = context.getSystemService(ConnectivityManager::class.java)
      network?.getNetworkCapabilities(network.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }.getOrDefault(false)
    return if (connected) null else "offline"
  }

  private fun start(id: String): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !idPattern.matches(id) || workerActive) return "unavailable"
    val problem = checkAccess(appContext.reactContext)
    if (problem != null) return problem
    discard("discarded")
    val next = Capture(id)
    capture = next
    workerActive = true
    main.postDelayed(guard, checkMillis)
    thread(name = "QingyuProjectRecording", isDaemon = true) { collect(next) }
    return null
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  @SuppressLint("MissingPermission")
  private fun collect(current: Capture) {
    var recorder: AudioRecord? = null
    var frames = 0
    var failure: String? = null
    try {
      val audio = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.MIC)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setBufferSizeInBytes(maxOf(readFrames * 4,
          AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)))
        .build()
      recorder = audio
      if (current.stop.get() == Stop.DISCARD) return
      check(audio.state == AudioRecord.STATE_INITIALIZED)
      audio.startRecording()
      check(audio.recordingState == AudioRecord.RECORDSTATE_RECORDING)
      main.post { if (capture === current) emit(current.id, "recording") }
      val deadline = SystemClock.elapsedRealtime() + 30_000
      var checkAt = 0L
      while (frames < maxFrames && current.stop.get() == Stop.RECORDING && SystemClock.elapsedRealtime() < deadline) {
        val now = SystemClock.elapsedRealtime()
        if (now >= checkAt) {
          checkAt = now + checkMillis
          if (audio.activeRecordingConfiguration?.isClientSilenced == true) {
            failure = "permission"
            break
          }
        }
        val count = audio.read(current.samples, frames, min(readFrames, maxFrames - frames), AudioRecord.READ_NON_BLOCKING)
        check(count >= 0)
        frames += count
        if (count == 0) Thread.sleep(10)
      }
    } catch (_: SecurityException) {
      failure = "permission"
    } catch (_: Exception) {
      failure = "unavailable"
    } finally {
      recorder?.let {
        runCatching { it.stop() }
        runCatching { it.release() }
      }
      main.post { complete(current, frames, failure) }
    }
  }

  private fun complete(current: Capture, frames: Int, failure: String?) {
    workerActive = false
    if (capture !== current) { current.samples.fill(0); return }
    capture = null
    val problem = failure ?: checkAccess(appContext.reactContext)
    if (current.stop.get() == Stop.DISCARD || frames <= 0 || problem != null) {
      main.removeCallbacks(guard)
      current.samples.fill(0)
      emit(current.id, problem ?: "empty")
    } else {
      clip = Clip(current, frames)
      emit(current.id, "ready", frames)
    }
  }

  private fun discard(phase: String) {
    val id = capture?.id ?: clip?.capture?.id
    capture?.stop?.set(Stop.DISCARD)
    capture = null
    stopPlayback()
    clip?.capture?.samples?.fill(0)
    clip = null
    main.removeCallbacks(guard)
    if (id != null) emit(id, phase)
  }

  private fun requireClip(id: String): Clip? {
    val current = clip?.takeIf { it.capture.id == id } ?: return null
    val problem = checkAccess(appContext.reactContext)
    if (problem != null) { discard(problem); return null }
    return current
  }

  private fun copyClip(id: String): ByteArray? {
    val selected = requireClip(id) ?: return null
    val bytes = selected.frames * 2
    val wave = ByteBuffer.allocate(44 + bytes).order(ByteOrder.LITTLE_ENDIAN)
    wave.put("RIFF".toByteArray(Charsets.US_ASCII)).putInt(bytes + 36)
      .put("WAVEfmt ".toByteArray(Charsets.US_ASCII)).putInt(16)
      .putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
      .put("data".toByteArray(Charsets.US_ASCII)).putInt(bytes)
    wave.asShortBuffer().put(selected.capture.samples, 0, selected.frames)
    return wave.array()
  }

  private fun play(id: String): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
    val selected = requireClip(id) ?: return false
    val audio = appContext.reactContext?.getSystemService(AudioManager::class.java) ?: return false
    stopPlayback()
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      .setAudioAttributes(attributes).setOnAudioFocusChangeListener({ change ->
        if (change < 0 && playback?.id == id) stopPlayback()
      }, main).build()
    if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return false
    var track: AudioTrack? = null
    try {
      val output = AudioTrack.Builder().setAudioAttributes(attributes).setTransferMode(AudioTrack.MODE_STATIC)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setBufferSizeInBytes(selected.frames * 2).build()
      track = output
      check(output.write(selected.capture.samples, 0, selected.frames, AudioTrack.WRITE_BLOCKING) == selected.frames)
      output.play()
      val deadline = Runnable { if (playback?.track === output) stopPlayback() }
      playback = Playback(id, output, audio, focus, deadline)
      main.postDelayed(deadline, (selected.frames * 1_000L + rate - 1) / rate + 100L)
      emit(id, "playing")
      return true
    } catch (_: RuntimeException) {
      track?.let { runCatching { it.release() } }
      audio.abandonAudioFocusRequest(focus)
      return false
    }
  }

  private fun stopPlayback() {
    val current = playback ?: return
    playback = null
    main.removeCallbacks(current.deadline)
    runCatching { current.track.stop() }
    runCatching { current.track.release() }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      current.audio.abandonAudioFocusRequest(current.focus)
    }
    emit(current.id, "playback_finished")
  }

  private fun emit(id: String, phase: String, frames: Int? = null) = sendEvent("onProjectRecording", Bundle().apply {
    putString("id", id)
    putString("phase", phase)
    if (frames != null) putInt("frames", frames)
  })

  companion object {
    private const val rate = 16_000
    private const val maxFrames = rate * 30
    private const val readFrames = 1_600
    private const val checkMillis = 200L
    private val idPattern = Regex("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
  }
}
