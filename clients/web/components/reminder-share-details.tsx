import type { components } from "@ai-assistant/contracts";

type Preview = components["schemas"]["ReminderSharePreview"];
const cadence = { once: "一次", daily: "每日", weekly: "每周" };

export function reminderShareTime(instant: string, timeZone?: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(instant));
  } catch {
    return instant;
  }
}

export function ReminderShareDetails({ preview }: { preview: Preview }) {
  const { template, firstDeliveryAt } = preview;
  return <section className="account-data-section" aria-label="将复制的提醒设置">
    <h3>{template.title}</h3>
    <p>{cadence[template.cadence]} · {template.timeZone}</p>
    <p>首次计划时间 {template.startsAtLocal.replace("T", " ")}</p>
    <p>首次预计送达 {reminderShareTime(firstDeliveryAt, template.timeZone)}</p>
    {template.quietHours && <p>静默时段 {template.quietHours.start} 至 {template.quietHours.end}</p>}
    <p>通知方式为站内提醒。</p>
  </section>;
}
