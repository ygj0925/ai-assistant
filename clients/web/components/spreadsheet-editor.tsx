"use client";

import { useState } from "react";
import type { components } from "@ai-assistant/contracts";

type Spreadsheet = components["schemas"]["Spreadsheet"];
type Cell = components["schemas"]["SpreadsheetCell"];
type CellKind = "blank" | "string" | "number" | "boolean";
type DraftCell = { type: CellKind; value: string };
export type SpreadsheetDraft = { name: string; rows: DraftCell[][] };

const rowLimit = 64;
const columnLimit = 16;
const blank = (): DraftCell => ({ type: "blank", value: "" });
const columnName = (column: number) => String.fromCharCode(65 + column);
const address = (row: number, column: number) => columnName(column) + (row + 1);

function fromValue(value: Cell): DraftCell {
  if (value === null) return blank();
  const type = typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
  return { type, value: String(value) };
}

export function spreadsheetDraft(sheet?: Spreadsheet): SpreadsheetDraft {
  return sheet ? { name: sheet.name, rows: sheet.rows.map((row) => row.map(fromValue)) }
    : { name: "工作表1", rows: Array.from({ length: 3 }, () => Array.from({ length: 3 }, blank)) };
}

function numericInput(value: string): number | undefined {
  const input = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(input)) return undefined;
  const mantissa = input.toLowerCase().split("e")[0];
  const digits = mantissa.replace(/[^0-9]/g, "").replace(/^0+|0+$/g, "");
  const result = Number(input);
  const magnitude = Math.abs(result);
  if (!Number.isFinite(result) || digits.length > 15 || magnitude > 1e100 ||
    (digits.length > 0 && magnitude < 1e-100)) return undefined;
  return result;
}

export function serializeSpreadsheet(draft: SpreadsheetDraft): { sheet?: Spreadsheet; error?: string } {
  const name = draft.name.trim();
  if (!name || name.length > 31 || [...name].some((character) => "[]:*?/\\".includes(character)) ||
    name.startsWith("'") || name.endsWith("'")) {
    return { error: "请输入 1–31 个字符的有效工作表名称。" };
  }
  const rows: Cell[][] = [];
  for (const [rowIndex, cells] of draft.rows.entries()) {
    const row: Cell[] = [];
    for (const [column, cell] of cells.entries()) {
      if (cell.type === "blank") row.push(null);
      else if (cell.type === "boolean") row.push(cell.value === "true");
      else if (cell.type === "string") row.push(cell.value);
      else {
        const result = numericInput(cell.value);
        if (result === undefined) return { error: `单元格 ${address(rowIndex, column)} 的数字无效或超过精度范围。` };
        row.push(result);
      }
    }
    rows.push(row);
  }
  const sheet = { name, rows };
  if (new TextEncoder().encode(JSON.stringify(sheet)).byteLength > 32768) {
    return { error: "表格内容最多使用 32 KiB。" };
  }
  return { sheet };
}

export function SpreadsheetEditor({ value, onChange, disabled }: {
  value: SpreadsheetDraft;
  onChange: (value: SpreadsheetDraft) => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState<readonly [number, number]>([0, 0]);
  const [activeRow, activeColumn] = selected;
  const cell = value.rows[activeRow]?.[activeColumn] ?? value.rows[0][0];
  const columns = value.rows[0].length;

  function update(row: number, column: number, next: DraftCell) {
    onChange({ ...value, rows: value.rows.map((cells, index) => index === row
      ? cells.map((current, position) => column === position ? next : current) : cells) });
  }

  return <div className="spreadsheet-editor">
    <label className="dialog-field">工作表名称
      <input value={value.name} readOnly={disabled} maxLength={31} onChange={(event) => onChange({ ...value, name: event.target.value })} />
    </label>
    <div className="spreadsheet-grid" role="region" aria-label="可编辑单元格">
      <table>
        <thead><tr><th scope="col">行</th>{value.rows[0].map((_, column) => <th scope="col" key={column}>{columnName(column)}</th>)}</tr></thead>
        <tbody>{value.rows.map((cells, row) => <tr key={row}>
          <th scope="row">{row + 1}</th>
          {cells.map((current, column) => <td key={column}>
            {current.type === "boolean" ? <select aria-label={`单元格 ${address(row, column)}`} disabled={disabled}
              value={current.value} onFocus={() => setSelected([row, column])}
              onChange={(event) => update(row, column, { type: "boolean", value: event.target.value })}>
              <option value="true">是</option><option value="false">否</option>
            </select> : <textarea rows={1} aria-label={`单元格 ${address(row, column)}`} readOnly={disabled} maxLength={1024}
              value={current.value} inputMode={current.type === "number" ? "decimal" : undefined}
              onFocus={() => setSelected([row, column])} onChange={(event) => update(row, column, {
                type: current.type === "blank" && event.target.value ? "string" : current.type, value: event.target.value,
              })} />}
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="dialog-actions">
      <label className="dialog-field">{address(activeRow, activeColumn)} 类型
        <select aria-label="所选单元格类型" value={cell.type} disabled={disabled} onChange={(event) => {
          const type = event.target.value as CellKind;
          const next = type === "blank" ? "" : type === "boolean" ? (cell.value === "false" ? "false" : "true") : cell.value;
          update(activeRow, activeColumn, { type, value: next });
        }}>
          <option value="blank">空白</option>
          <option value="string">文字</option>
          <option value="number">数字</option>
          <option value="boolean">是或否</option>
        </select>
      </label>
      <button type="button" className="button secondary" disabled={disabled || value.rows.length >= rowLimit}
        onClick={() => onChange({ ...value, rows: [...value.rows, Array.from({ length: columns }, blank)] })}>新增一行</button>
      <button type="button" className="button secondary" disabled={disabled || columns >= columnLimit}
        onClick={() => onChange({ ...value, rows: value.rows.map((row) => [...row, blank()]) })}>新增一列</button>
      <button type="button" className="button secondary" disabled={disabled || value.rows.length === 1}
        onClick={() => {
          setSelected([Math.min(activeRow, value.rows.length - 2), activeColumn]);
          onChange({ ...value, rows: value.rows.slice(0, -1) });
        }}>移除末行</button>
      <button type="button" className="button secondary" disabled={disabled || columns === 1}
        onClick={() => {
          setSelected([activeRow, Math.min(activeColumn, columns - 2)]);
          onChange({ ...value, rows: value.rows.map((row) => row.slice(0, -1)) });
        }}>移除末列</button>
    </div>
  </div>;
}

export function SpreadsheetView({ sheet }: { sheet: Spreadsheet }) {
  return <div className="spreadsheet-grid" role="region" aria-label={`工作表 ${sheet.name}`}>
    <table>
      <caption>{sheet.name}</caption>
      <thead><tr><th scope="col">行</th>{sheet.rows[0].map((_, column) => <th scope="col" key={column}>{columnName(column)}</th>)}</tr></thead>
      <tbody>{sheet.rows.map((row, r) => <tr key={r}>
        <th scope="row">{r + 1}</th>
        {row.map((cell, c) => <td key={c}>{typeof cell === "boolean" ? cell ? "是" : "否" : cell}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}
