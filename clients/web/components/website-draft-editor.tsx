"use client";

import type { components } from "@ai-assistant/contracts";
import { useEffect, useState } from "react";

type Website = components["schemas"]["WebsiteDraft"];
type Section = Website["sections"][number];
const sectionLimit = 6;
const paragraphLimit = 4;

export function useWebsiteSandboxSupport() {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    // The Electron host denies all embedded frames and keeps the structured reading view.
    setSupported(!/\bElectron\//.test(navigator.userAgent));
  }, []);
  return supported;
}

export function WebsiteSandbox({ html, title }: { html: string; title: string }) {
  return <iframe className="website-preview" title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={html} />;
}

function newSection(): Section { return { title: "", paragraphs: [""] }; }

export function websiteDraft(website?: Website): Website {
  return website ?? { heading: "", introduction: "", sections: [newSection()] };
}

export function websiteDraftError(website: Website) {
  if (!website.heading.trim() || website.heading.length > 80 || website.introduction.length > 320) {
    return "网页需要 80 个字符以内的标题，简介最多 320 个字符。";
  }
  for (const [index, section] of website.sections.entries()) {
    if (!section.title.trim() || section.title.length > 60) return `第 ${index + 1} 节需要 60 个字符以内的标题。`;
    if (section.paragraphs.some((line) => !line.trim() || line.length > 400)) {
      return `第 ${index + 1} 节的段落需要正文，每段最多 400 个字符。`;
    }
  }
  if (new TextEncoder().encode(JSON.stringify(website)).byteLength > 32 * 1024) return "网页内容合计最多 32 KiB。";
}

export function WebsiteDraftEditor({ website, onChange, disabled }: {
  website: Website;
  onChange: (website: Website) => void;
  disabled: boolean;
}) {
  function editSection(index: number, updated: Section) {
    onChange({ ...website, sections: website.sections.map((entry, position) => index === position ? updated : entry) });
  }

  return <section className="account-data-section" aria-label="网页内容编辑">
    <label className="dialog-field">网页标题<input value={website.heading} maxLength={80} readOnly={disabled}
      onChange={(event) => onChange({ ...website, heading: event.target.value })} /></label>
    <label className="dialog-field">网页简介<textarea value={website.introduction} maxLength={320} rows={3} readOnly={disabled}
      onChange={(event) => onChange({ ...website, introduction: event.target.value })} /></label>
    {website.sections.map((section, index) => <fieldset className="website-draft-section" key={index}>
      <legend>第 {index + 1} 节</legend>
      <label className="dialog-field">小节标题<input value={section.title} maxLength={60} readOnly={disabled}
        onChange={(event) => editSection(index, { ...section, title: event.target.value })} /></label>
      {section.paragraphs.map((line, position) => <div key={position}>
        <label className="dialog-field">第 {position + 1} 段<textarea value={line} rows={4} maxLength={400} readOnly={disabled}
          onChange={(event) => editSection(index, { ...section, paragraphs: section.paragraphs.map(
            (paragraph, row) => row === position ? event.target.value : paragraph,
          ) })} /></label>
        {section.paragraphs.length > 1 && <button type="button" className="button secondary"
          disabled={disabled} aria-label={`删除第 ${position + 1} 段`}
          onClick={() => editSection(index, { ...section, paragraphs: section.paragraphs.filter((_, row) => row !== position) })}>
          删除段落
        </button>}
      </div>)}
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={disabled || section.paragraphs.length >= paragraphLimit}
          onClick={() => editSection(index, { ...section, paragraphs: [...section.paragraphs, ""] })}>新增段落</button>
        {website.sections.length > 1 && <button type="button" className="button secondary" disabled={disabled}
          aria-label={`删除第 ${index + 1} 节`} onClick={() => onChange({ ...website,
            sections: website.sections.filter((_, position) => position !== index),
          })}>删除小节</button>}
      </div>
    </fieldset>)}
    <button type="button" className="button secondary" disabled={disabled || website.sections.length >= sectionLimit}
      onClick={() => onChange({ ...website, sections: [...website.sections, newSection()] })}>新增小节</button>
  </section>;
}

export function WebsiteDraftView({ website }: { website: Website }) {
  return <article className="resource-detail" aria-label="网页正文">
    <h4>{website.heading}</h4>
    {website.introduction && <p className="website-paragraph">{website.introduction}</p>}
    {website.sections.map(({ title, paragraphs }, index) => <section key={index}>
      <h5>{title}</h5>
      {paragraphs.map((line, position) => <p className="website-paragraph" key={position}>{line}</p>)}
    </section>)}
  </article>;
}
