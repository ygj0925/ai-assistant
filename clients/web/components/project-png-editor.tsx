"use client";

import { useState, type FormEvent } from "react";
import type { components } from "@ai-assistant/contracts";
import { idempotencyKey } from "@/lib/assistant";

type Edit = components["schemas"]["LocalImageEditWrite"];
const rotations = [0, 90, 180, 270] as const;

export function ProjectPngEditor({ source, previewUrl, disabled, close, onConfirm }: {
  source: { width: number; height: number };
  previewUrl: string;
  disabled: boolean;
  close: () => void;
  onConfirm: (command: Edit, key: string) => void;
}) {
  const [review, setReview] = useState<{ command: Edit; key: string }>();
  const [draft, setDraft] = useState({ x: "0", y: "0", width: String(source.width), height: String(source.height), rotation: "0" });
  const [error, setError] = useState("");

  function prepare(event: FormEvent) {
    event.preventDefault();
    const x = Number(draft.x);
    const y = Number(draft.y);
    const width = Number(draft.width);
    const height = Number(draft.height);
    const rotation = rotations.find((value) => String(value) === draft.rotation) ?? 0;
    if (Object.values(draft).some((value) => value.trim() === "") || ![x, y, width, height].every(Number.isInteger)
      || x < 0 || y < 0 || width < 1 || height < 1 || x + width > source.width || y + height > source.height) {
      setError("请输入图像范围内的整数像素坐标和尺寸。");
      return;
    }
    if (x === 0 && y === 0 && width === source.width && height === source.height && rotation === 0) {
      setError("请选择裁剪范围或旋转角度。");
      return;
    }
    setError("");
    setReview({ command: { x, y, width, height, rotation, confirm: true }, key: idempotencyKey() });
  }

  const rect = review?.command;
  const sideways = rect && rect.rotation % 180 !== 0;
  return <section className="account-data-section" aria-label="编辑项目图像">
    <h4>裁剪与旋转</h4>
    <p>原图 {source.width} × {source.height} 像素。从左上角开始填写裁剪范围。</p>
    <div className="png-edit-source" style={{ inlineSize: `min(100%, ${source.width}px)` }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- approved private object URL */}
      <img src={previewUrl} width={source.width} height={source.height} alt="正在编辑的项目原图" />
      {rect && <span aria-hidden="true" className="png-edit-selection" style={{
        left: `${100 * rect.x / source.width}%`, top: `${100 * rect.y / source.height}%`,
        width: `${100 * rect.width / source.width}%`, height: `${100 * rect.height / source.height}%`,
      }} />}
    </div>
    {error && <p className="error-box" role="alert">{error}</p>}
    {review && rect ? <>
      <p>范围从 ({rect.x}, {rect.y}) 开始，宽 {rect.width}、高 {rect.height} 像素，顺时针旋转 {rect.rotation}°。</p>
      <p>副本尺寸 {sideways ? rect.height : rect.width} × {sideways ? rect.width : rect.height} 像素，扫描通过后可预览或保存为资产版本。</p>
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={disabled} onClick={() => setReview(undefined)}>返回修改范围</button>
        <button type="button" className="button primary" disabled={disabled}
          onClick={() => onConfirm(review.command, review.key)}>确认生成编辑副本</button>
      </div>
    </> : <form onSubmit={prepare}>
      <div className="png-edit-fields">
        {([
          ["x", "起点 X", 0, source.width - 1], ["y", "起点 Y", 0, source.height - 1],
          ["width", "裁剪宽度", 1, source.width], ["height", "裁剪高度", 1, source.height],
        ] as const).map(([field, label, minimum, maximum]) => <label className="dialog-field" key={field}>{label}
          <input type="number" min={minimum} max={maximum} step={1} value={draft[field]} required disabled={disabled}
            onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} />
        </label>)}
      </div>
      <label className="dialog-field">顺时针旋转<select value={draft.rotation} disabled={disabled}
        onChange={(event) => setDraft({ ...draft, rotation: event.target.value })}>
        {rotations.map((rotation) => <option value={rotation} key={rotation}>{rotation}°</option>)}
      </select></label>
      <button className="button secondary" type="submit" disabled={disabled}>审核裁剪与旋转</button>
    </form>}
    <button className="button secondary" type="button" disabled={disabled} onClick={close}>取消编辑</button>
  </section>;
}
