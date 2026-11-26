import type { Metadata } from "next";
import { Assistant } from "@/components/assistant";

export const metadata: Metadata = {
  title: "会话分享 | 青屿助手",
  description: "查看分享的对话快照。",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

export default function SharePage() {
  return <Assistant sharedEntry />;
}
