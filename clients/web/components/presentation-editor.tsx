"use client";

import { useState } from "react";
import type { components } from "@ai-assistant/contracts";

type Deck = components["schemas"]["Presentation"];
type Slide = Deck["slides"][number];
const slideLimit = 12;
const bulletLimit = 6;
const invalidLine = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\uFFFE\uFFFF]/u;

function emptySlide(): Slide { return { title: "", bullets: [] }; }

export function presentationDraft(presentation?: Deck): Deck {
  return presentation ?? { slides: [emptySlide()] };
}

export function presentationError(presentation: Deck) {
  for (const [index, { title, bullets }] of presentation.slides.entries()) {
    if (!title.trim() || title.length > 60 || invalidLine.test(title)) return `第 ${index + 1} 页需要 60 个字符以内的单行标题。`;
    if (bullets.some((line) => !line.trim() || line.length > 96 || invalidLine.test(line))) {
      return `第 ${index + 1} 页的要点需要单行文字，每项最多 96 个字符。`;
    }
  }
  if (new TextEncoder().encode(JSON.stringify(presentation)).byteLength > 32 * 1024) return "幻灯片内容最多 32 KiB。";
}

export function PresentationEditor({ deck, onChange, disabled }: {
  deck: Deck;
  onChange: (deck: Deck) => void;
  disabled: boolean;
}) {
  const [active, setActive] = useState(0);
  const index = Math.min(active, deck.slides.length - 1);
  const slide = deck.slides[index];

  function edit(update: Slide) {
    onChange({ slides: deck.slides.map((item, position) => position === index ? update : item) });
  }

  return <section className="account-data-section" aria-label="编辑幻灯片">
    <label className="dialog-field">当前幻灯片
      <select value={index} disabled={disabled} onChange={(event) => setActive(Number(event.target.value))}>
        {deck.slides.map(({ title }, position) => <option key={position} value={position}>
          第 {position + 1} 页{title && ` · ${title}`}
        </option>)}
      </select>
    </label>
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={disabled || deck.slides.length >= slideLimit} onClick={() => {
        setActive(deck.slides.length);
        onChange({ slides: [...deck.slides, emptySlide()] });
      }}>新增幻灯片</button>
      <button type="button" className="button secondary" disabled={disabled || deck.slides.length < 2} onClick={() => {
        onChange({ slides: deck.slides.filter((_, position) => position !== index) });
        setActive(Math.max(0, index - 1));
      }}>删除当前幻灯片</button>
    </div>
    <label className="dialog-field">幻灯片标题<input value={slide.title} maxLength={60} readOnly={disabled}
      onChange={(event) => edit({ ...slide, title: event.target.value })} /></label>
    {slide.bullets.map((line, position) => <div className="account-data-section" key={position}>
      <label className="dialog-field">要点 {position + 1}<input value={line} maxLength={96} readOnly={disabled}
        onChange={(event) => edit({ ...slide, bullets: slide.bullets.map((item, number) => number === position ? event.target.value : item) })} /></label>
      <button type="button" className="button secondary" disabled={disabled} aria-label={`删除要点 ${position + 1}`}
        onClick={() => edit({ ...slide, bullets: slide.bullets.filter((_, number) => number !== position) })}>删除要点</button>
    </div>)}
    <button type="button" className="button secondary" disabled={disabled || slide.bullets.length >= bulletLimit}
      onClick={() => edit({ ...slide, bullets: [...slide.bullets, ""] })}>新增要点</button>
  </section>;
}

export function PresentationView({ deck }: { deck: Deck }) {
  return <ol className="private-record-list" aria-label="幻灯片内容">
    {deck.slides.map(({ title, bullets }, index) => <li key={index}>
      <strong>{title}</strong>
      {!!bullets.length && <ul>{bullets.map((line, position) => <li key={position}>{line}</li>)}</ul>}
    </li>)}
  </ol>;
}
