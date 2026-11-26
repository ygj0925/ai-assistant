import type { ReactNode } from "react";
import type { ShareView } from "@/lib/sharing";

export function ShareMessages({ messages, reportReply }: {
  messages: ShareView["messages"];
  reportReply?: (index: number) => ReactNode;
}) {
  return (
    <ol className="share-messages">
      {messages.map((message, index) => (
        <li key={index} className={message.role === "user" ? "shared-prompt" : undefined}>
          <p className="message-author">{message.role === "user" ? "提问" : "助手回复"}</p>
          <p className="message-plain">{message.content}</p>
          {message.role === "assistant" && reportReply?.(index)}
        </li>
      ))}
    </ol>
  );
}
