"use client";

import { Check, Copy } from "lucide-react";
import { memo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeLink(href: string) {
  try {
    const url = new URL(href);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function CodeText({ content }: { content: string }) {
  const [feedback, setFeedback] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setFeedback("已复制");
    } catch {
      setFeedback("复制失败，可选中文字后复制。");
    }
  }
  return (
    <div className="code-block">
      <button type="button" className="button compact-button" onClick={copy}>
        {feedback === "已复制" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        复制代码
      </button>
      {feedback && <span className="code-feedback" role="status">{feedback}</span>}
    </div>
  );
}

export const MessageContent = memo(function MessageContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
  if (streaming) return <p className="message-plain">{content}</p>;
  return (
    <div className="markdown">
      <Markdown skipHtml remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => href && safeLink(href)
          ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>
          : <span>{children}</span>,
        img: ({ alt }) => <span>{alt}</span>,
        table: ({ children }) => <div className="table-scroll" tabIndex={0} role="region" aria-label="可滚动表格"><table>{children}</table></div>,
        pre: ({ children, node }) => {
          const code = node?.children[0];
          const text = code?.type === "element" ? code.children[0] : undefined;
          return <div className="code-frame">
            {text?.type === "text" && <CodeText content={text.value} />}
            <pre>{children}</pre>
          </div>;
        },
      }}>{content}</Markdown>
    </div>
  );
});
