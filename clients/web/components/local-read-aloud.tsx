"use client";

import { Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const unavailableText = "本机语音已不可用。";
const playbackError = "本机朗读失败。";
const startTimeoutMs = 5_000;

type Playback = {
  id: string;
  voice: SpeechSynthesisVoice;
  finish: (cancel: boolean, feedback?: string, updateUi?: boolean) => void;
};

function speechEngine() {
  if (typeof SpeechSynthesisUtterance !== "function") return undefined;
  return window.speechSynthesis;
}

function localVoices(engine: SpeechSynthesis | undefined) {
  try {
    return (engine?.getVoices() ?? []).filter((voice) => voice.localService === true);
  } catch {
    return [];
  }
}

function chooseVoice(voices: SpeechSynthesisVoice[], locale: string) {
  const language = locale.split("-")[0];
  return voices.find((voice) => voice.lang.toLowerCase() === locale) ??
    voices.find((voice) => voice.lang.toLowerCase().split("-")[0] === language) ??
    voices.find((voice) => voice.default) ?? voices[0];
}

function isSameVoice(left: SpeechSynthesisVoice, right: SpeechSynthesisVoice) {
  return left.voiceURI === right.voiceURI && left.name === right.name && left.lang === right.lang;
}

function playbackBlocked() {
  return document.visibilityState !== "visible" || document.querySelector("dialog[open]") !== null;
}

export function useLocalReadAloud(conversationId: string | undefined, branchId: string | undefined, locale: string) {
  const active = useRef<Playback | null>(null);
  const [available, setAvailable] = useState(false);
  const [playingId, setPlayingId] = useState<string>();
  const [feedback, setFeedback] = useState<{ id: string; text: string }>();

  useLayoutEffect(() => {
    setPlayingId(undefined);
    setFeedback(undefined);
    return () => active.current?.finish(true, undefined, false);
  }, [conversationId, branchId]);

  useEffect(() => {
    const engine = speechEngine();
    if (!engine) return;

    function refreshVoices() {
      const voices = localVoices(engine);
      setAvailable(voices.length > 0);
      const current = active.current;
      if (current && !voices.some((voice) => isSameVoice(voice, current.voice))) {
        current.finish(true, unavailableText);
      }
    }
    function pageHidden() {
      active.current?.finish(true);
    }
    function visibilityChanged() {
      if (document.visibilityState !== "visible") pageHidden();
      else refreshVoices();
    }

    refreshVoices();
    engine.addEventListener("voiceschanged", refreshVoices);
    window.addEventListener("focus", refreshVoices);
    window.addEventListener("pageshow", refreshVoices);
    window.addEventListener("pagehide", pageHidden);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      engine.removeEventListener("voiceschanged", refreshVoices);
      window.removeEventListener("focus", refreshVoices);
      window.removeEventListener("pageshow", refreshVoices);
      window.removeEventListener("pagehide", pageHidden);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  const toggle = useCallback((id: string, text: string) => {
    const current = active.current;
    current?.finish(true);
    setFeedback(undefined);
    if (current?.id === id || playbackBlocked() || !text.trim()) return;

    const engine = speechEngine();
    const voices = localVoices(engine);
    const voice = chooseVoice(voices, locale.toLowerCase());
    if (!engine || !voice) {
      setAvailable(false);
      setFeedback({ id, text: unavailableText });
      return;
    }

    let utterance: SpeechSynthesisUtterance;
    try {
      utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } catch {
      setFeedback({ id, text: playbackError });
      return;
    }
    if (utterance.voice?.localService !== true) {
      setFeedback({ id, text: unavailableText });
      return;
    }
    const synth = engine;
    const requestedAt = performance.now();
    let started = false;
    const observer = new MutationObserver(() => {
      if (playbackBlocked()) finish(true);
    });
    const watchdog = window.setInterval(() => {
      if (playbackBlocked() || synth.paused) finish(true);
      else if (started && !synth.speaking && !synth.pending) finish(false);
      else if (!started && performance.now() - requestedAt >= startTimeoutMs) {
        finish(true, playbackError);
      }
    }, 250);

    function finish(cancel: boolean, message?: string, updateUi = true) {
      if (active.current !== playback) return;
      active.current = null;
      observer.disconnect();
      window.clearInterval(watchdog);
      utterance.onstart = null;
      utterance.onend = null;
      utterance.onerror = null;
      if (cancel) {
        try {
          synth.cancel();
        } catch {
          // The browser may already have disposed of the engine during navigation.
        }
      }
      if (updateUi) {
        setPlayingId(undefined);
        if (message) setFeedback({ id, text: message });
      }
    }

    const playback = { id, voice, finish };
    active.current = playback;
    utterance.onstart = () => { started = true; };
    utterance.onend = () => finish(false);
    utterance.onerror = ({ error }) => {
      if (error === "canceled" || error === "interrupted") finish(false);
      else finish(true, error === "text-too-long" ? "回复过长，无法使用本机语音朗读。" : playbackError);
    };
    setPlayingId(id);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    try {
      synth.speak(utterance);
    } catch {
      finish(true, playbackError);
    }
  }, [locale]);

  return { available, playingId, feedback, toggle };
}

export function LocalReadAloud({ id, text, playback }: {
  id: string;
  text: string;
  playback: ReturnType<typeof useLocalReadAloud>;
}) {
  const playing = playback.playingId === id;
  const feedback = playback.feedback?.id === id ? playback.feedback.text : "";
  if ((!playback.available || !text.trim()) && !feedback) return null;
  return <>
    {playback.available && !!text.trim() && <button className="button compact-button" type="button"
      onClick={() => playback.toggle(id, text)}>
      {playing ? <Square size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
      {playing ? "停止朗读" : "本机朗读"}
    </button>}
    <span className="reply-audio-status" role="status">{feedback}</span>
  </>;
}
