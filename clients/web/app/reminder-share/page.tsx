import type { Metadata } from "next";
import { Assistant } from "@/components/assistant";

export const metadata: Metadata = {
  title: "提醒分享 | 青屿助手",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

export default function ReminderSharePage() {
  return <Assistant reminderShareEntry />;
}
