package dev.assistant.qingyu.dictation

import android.content.Context

@Suppress("UNUSED_PARAMETER")
internal class BundledMandarin {
  fun available(context: Context) = false
  fun busy() = false
  fun start(context: Context, id: String, permitted: () -> Boolean, emit: (String, String, String?) -> Unit) = false
  fun finish(id: String) = Unit
  fun cancel(id: String? = null) = Unit
}
