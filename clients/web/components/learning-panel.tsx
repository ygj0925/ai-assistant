"use client";

import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { exampleLesson, gradeLesson, normalizeLessonChoice, parseLesson, parseLessonJson,
  type LessonChart as Chart } from "@ai-assistant/contracts";
import { Modal } from "./modal";

function initialState(input: unknown) {
  if (input === undefined) return { lesson: exampleLesson, error: "" };
  try {
    return { lesson: parseLesson(input), error: "" };
  } catch {
    return { lesson: exampleLesson, error: "无法读取传入的课程。已打开本机示例。" };
  }
}

function chartText(value: number, unit: string | undefined) {
  return unit ? String(value) + " " + unit : String(value);
}

function LessonChart({ chart, textOnly }: { chart: Chart; textOnly: boolean }) {
  if (textOnly) {
    return <table style={{ inlineSize: "100%", tableLayout: "fixed", overflowWrap: "anywhere" }}>
      <caption>{chart.title}</caption>
      <thead><tr><th scope="col">项目</th><th scope="col">数值</th></tr></thead>
      <tbody>{chart.points.map(({ label, value }) =>
        <tr key={label}><th scope="row">{label}</th><td>{chartText(value, chart.unit)}</td></tr>)}</tbody>
    </table>;
  }
  const max = Math.max(1, ...chart.points.map(({ value }) => Math.abs(value)));
  return <section aria-label={chart.title}>
    <h4 style={{ overflowWrap: "anywhere" }}>{chart.title}</h4>
    <ul className="analysis-plot" aria-label="项目及数值">
      {chart.points.map(({ label, value }) => {
        const width = Math.abs(value) / max * 50;
        return <li key={label}>
          <span style={{ maxInlineSize: "8rem", overflowWrap: "anywhere" }}>{label}</span>
          <span className="analysis-track" aria-hidden="true"><span className="analysis-bar" style={{
            inlineSize: width + "%", insetInlineStart: (value < 0 ? 50 - width : 50) + "%",
          }} /></span>
          <span className="analysis-value">{chartText(value, chart.unit)}</span>
        </li>;
      })}
    </ul>
  </section>;
}

function ChartComparison({ chart }: { chart: Chart }) {
  const [baseline, setBaseline] = useState("");
  const [comparison, setComparison] = useState("");
  const first = chart.points.find(({ label }) => label === baseline);
  const second = chart.points.find(({ label }) => label === comparison);
  const difference = first && second && second.value - first.value;
  return <fieldset className="resource-detail">
    <legend>比较图表数值</legend>
    <div className="reminder-fields">
      <label className="dialog-field">基准项目
        <select value={baseline} onChange={(event) => setBaseline(event.target.value)}>
          <option value="">选择项目</option>
          {chart.points.map(({ label }) => <option key={label}>{label}</option>)}
        </select>
      </label>
      <label className="dialog-field">比较项目
        <select value={comparison} onChange={(event) => setComparison(event.target.value)}>
          <option value="">选择项目</option>
          {chart.points.map(({ label }) => <option key={label}>{label}</option>)}
        </select>
      </label>
    </div>
    {difference !== undefined && <p aria-live="polite">
      {comparison}减去{baseline}，差值 {chartText(Number(difference.toPrecision(12)), chart.unit)}。
    </p>}
  </fieldset>;
}

export function LearningPanel({ close, returnFocus, initialLesson }: {
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  initialLesson?: unknown;
}) {
  const [{ lesson: startingLesson, error: startingError }] = useState(() => initialState(initialLesson));
  const [lesson, setLesson] = useState(startingLesson);
  const [json, setJson] = useState(() => JSON.stringify(startingLesson, null, 2));
  const [importError, setImportError] = useState(startingError);
  const [textOnly, setTextOnly] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState<{ answers: number[]; correct: number }>();
  const [invalidQuestion, setInvalidQuestion] = useState<number>();
  const importOptions = useRef<HTMLDetailsElement>(null);
  const quiz = useRef<HTMLFormElement>(null);
  const modeButton = useRef<HTMLButtonElement>(null);
  const id = useId();

  function importLesson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setImportError("");
    try {
      const next = parseLessonJson(json);
      setLesson(next);
      setAnswers({});
      setSubmitted(undefined);
      setInvalidQuestion(undefined);
      if (importOptions.current) importOptions.current.open = false;
      modeButton.current?.focus();
    } catch (error) {
      setImportError(error instanceof SyntaxError ? "JSON 格式不正确，请检查后重新导入。" :
        error instanceof Error ? error.message : "无法读取课程内容。");
    }
  }

  function updateAnswer(index: number, value: string) {
    setAnswers((current) => ({ ...current, [index]: value }));
    setSubmitted(undefined);
    if (invalidQuestion === index) setInvalidQuestion(undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const grade = gradeLesson(lesson, lesson.questions.map((_, index) => answers[index]));
    if ("invalidQuestion" in grade) {
      const invalid = grade.invalidQuestion;
      setInvalidQuestion(invalid);
      quiz.current?.querySelector<HTMLInputElement>("[data-question='" + invalid + "'] input")?.focus();
      return;
    }
    setInvalidQuestion(undefined);
    setSubmitted(grade);
  }

  const correctCount = submitted?.correct;
  return <Modal label="学习模式" className="action-dialog resource-dialog" close={close} returnFocus={returnFocus}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: ".5rem" }}>
      <h2>学习模式</h2>
      <button className="button secondary" type="button" onClick={close}>关闭</button>
    </header>
    <h3 style={{ overflowWrap: "anywhere" }}>{lesson.title}</h3>
    {lesson.guide.map((line, index) => <p key={index}>{line}</p>)}
    <button ref={modeButton} className="button secondary" type="button" aria-pressed={textOnly}
      onClick={() => setTextOnly((current) => !current)}>文本练习</button>
    {lesson.chart && <>
      <LessonChart chart={lesson.chart} textOnly={textOnly} />
      {lesson.chart.points.length > 1 && <ChartComparison key={JSON.stringify(lesson.chart)} chart={lesson.chart} />}
    </>}
    <form ref={quiz} onSubmit={submit} aria-label="课后练习" noValidate>
      {lesson.questions.map((question, index) => {
        const knownAnswer = submitted?.answers[index];
        const invalid = invalidQuestion === index;
        const feedbackId = id + "-feedback-" + index;
        return <fieldset key={index} data-question={index} className="resource-detail"
          style={{ minInlineSize: 0, overflowWrap: "anywhere" }}
          aria-describedby={invalid ? feedbackId : undefined}>
          <legend>{(index + 1) + ". " + question.prompt}</legend>
          {textOnly ? <>
            <ol>{question.options.map((option) => <li key={option}>{option}</li>)}</ol>
            <label className="dialog-field">第 {index + 1} 题答案序号
              <input inputMode="numeric" maxLength={2} value={answers[index] ?? ""}
                aria-invalid={invalid || undefined} aria-describedby={invalid ? feedbackId : undefined}
                onChange={(event) => updateAnswer(index, event.target.value)} />
            </label>
          </> : question.options.map((option, position) => <label className="memory-toggle" key={option}>
            <input type="radio" name={id + "-question-" + index} value={position + 1}
              checked={normalizeLessonChoice(answers[index]) === String(position + 1)}
              onChange={(event) => updateAnswer(index, event.target.value)} />
            <span>{option}</span>
          </label>)}
          {invalid && <p id={feedbackId} className="error-box">请选择第 {index + 1} 题的有效选项。</p>}
          {knownAnswer !== undefined && <p>
            <strong>{knownAnswer === question.answer ? "正确。" : "答错了。"}</strong>
            {" 正确选项是「" + question.options[question.answer - 1] + "」。" + question.explanation}
          </p>}
        </fieldset>;
      })}
      <div className="dialog-actions">
        <button className="button primary" type="submit">提交答案</button>
      </div>
      <p role="status">{correctCount === undefined ? "" : "答对 " + correctCount + " / " + lesson.questions.length + " 题。"}</p>
    </form>
    <details ref={importOptions}>
      <summary className="button secondary">导入课程 JSON</summary>
      <form aria-label="导入课程" onSubmit={importLesson}>
        <label className="dialog-field">课程 JSON
          <textarea rows={9} value={json} spellCheck={false} autoCapitalize="off"
            onChange={(event) => setJson(event.target.value)} />
        </label>
        <div className="dialog-actions">
          <button className="button secondary" type="submit">载入课程</button>
        </div>
      </form>
    </details>
    {importError && <p className="error-box" role="alert">{importError}</p>}
  </Modal>;
}
