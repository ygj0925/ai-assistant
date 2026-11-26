"use client";

import type { components } from "@ai-assistant/contracts";

type Code = components["schemas"]["CodeDraft"];
type Language = Code["language"];
const languages: Record<Language, { label: string; extension: string }> = {
  plaintext: { label: "纯文本", extension: "" },
  javascript: { label: "JavaScript", extension: "js" },
  typescript: { label: "TypeScript", extension: "ts" },
  python: { label: "Python", extension: "py" },
  java: { label: "Java", extension: "java" },
  sql: { label: "SQL", extension: "sql" },
  json: { label: "JSON", extension: "json" },
  css: { label: "CSS", extension: "css" },
};

export function codeDraft(code?: Code): Code { return code ?? { language: "plaintext", source: "" }; }

export function codeDraftError(code: Code) {
  if (/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(code.source)) {
    return "源码含有无法保存的控制字符。";
  }
  if (new TextEncoder().encode(JSON.stringify(code)).byteLength > 32 * 1024) return "源码和语言信息合计最多 32 KiB。";
}

export function codeDownloadName(code: Code, version?: number) {
  const extension = languages[code.language].extension;
  const name = version === undefined ? "artifact" : `artifact-${version}`;
  return extension ? `${name}.${extension}.txt` : `${name}.txt`;
}

export function CodeDraftEditor({ code, onChange, disabled }: { code: Code; onChange: (code: Code) => void; disabled: boolean }) {
  return <section className="account-data-section" aria-label="源代码编辑">
    <label className="dialog-field">代码语言
      <select value={code.language} disabled={disabled} onChange={(event) => {
        const language = event.target.value as Language;
        if (Object.hasOwn(languages, language)) onChange({ ...code, language });
      }}>
        {Object.entries(languages).map(([key, { label }]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </label>
    <label className="dialog-field">源码<textarea className="artifact-source-editor" value={code.source} rows={10}
      spellCheck={false} autoCapitalize="off" autoCorrect="off" readOnly={disabled}
      onChange={(event) => onChange({ ...code, source: /^([^\r\n]*\r\n)+[^\r\n]*$/.test(code.source)
        ? event.target.value.replaceAll("\n", "\r\n") : event.target.value })} /></label>
    <p className="list-notice">此处保存和下载源代码文本。</p>
  </section>;
}

export function CodeDraftView({ code }: { code: Code }) {
  return <div>
    <p className="list-notice">{languages[code.language].label}</p>
    <pre className="resource-text"><code>{code.source}</code></pre>
  </div>;
}
