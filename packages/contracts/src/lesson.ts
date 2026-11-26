export type LessonQuestion = { prompt: string; options: string[]; answer: number; explanation: string };
export type LessonChart = { title: string; unit?: string; points: { label: string; value: number }[] };
export type Lesson = { title: string; guide: string[]; questions: LessonQuestion[]; chart?: LessonChart };

const maxInputBytes = 16_384;
export const exampleLesson: Lesson = {
  title: "从图表比较数据",
  guide: ["先找出图表中的最大数值。比较两个数值相差多少时，用较大的数减去较小的数。"],
  questions: [
    { prompt: "哪一天的借阅量最多？", options: ["周一", "周二", "周三"], answer: 2,
      explanation: "周二借阅了 7 本。7 大于 4 和 6。" },
    { prompt: "周二比周一多借阅了几本？", options: ["2 本", "3 本", "11 本"], answer: 2,
      explanation: "周二借阅 7 本，周一借阅 4 本，两者相差 3 本。" },
  ],
  chart: {
    title: "本周借阅量",
    unit: "本",
    points: [{ label: "周一", value: 4 }, { label: "周二", value: 7 }, { label: "周三", value: 6 }],
  },
};

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("包含多余字段或无效的数据结构。");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number, multiline = false) {
  if (typeof value !== "string" || value.length > limit * 2 ||
      [...value].length > limit || !value.trim() ||
      [...value].some((character) => {
        const point = character.codePointAt(0) as number;
        return ((point < 32 || point >= 127 && point <= 159) &&
          !(multiline && (character === "\n" || character === "\t"))) ||
          (point >= 0xd800 && point <= 0xdfff);
      })) {
    throw new Error("检查课程文字是否为空、过长或包含控制字符。");
  }
  return value.trim();
}

function boundedList(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error("课程条目数量超出允许范围。");
  }
  return Array.from(value);
}

export function parseLesson(value: unknown): Lesson {
  const lesson = object(value, ["title", "guide", "questions", "chart"]);
  const guide = boundedList(lesson.guide, 1, 6).map((item) => text(item, 400, true));
  const questions = boundedList(lesson.questions, 1, 10).map((value) => {
    const item = object(value, ["prompt", "options", "answer", "explanation"]);
    const options = boundedList(item.options, 2, 6).map((option) => text(option, 120));
    const answer = item.answer;
    if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 1 ||
        answer > options.length || new Set(options).size !== options.length) {
      throw new Error("每道题须有不同的选项，答案序号须对应一个选项。");
    }
    return { prompt: text(item.prompt, 240), options, answer, explanation: text(item.explanation, 400, true) };
  });
  const title = text(lesson.title, 80);
  if (lesson.chart === undefined) return { title, guide, questions };
  const input = object(lesson.chart, ["title", "unit", "points"]);
  const points = boundedList(input.points, 1, 12).map((value) => {
    const point = object(value, ["label", "value"]);
    if (typeof point.value !== "number" || !Number.isFinite(point.value) || Math.abs(point.value) > 1e9) {
      throw new Error("图表的每个数值须在 −10 亿至 10 亿之间。");
    }
    return { label: text(point.label, 32), value: point.value };
  });
  if (new Set(points.map(({ label }) => label)).size !== points.length) {
    throw new Error("图表项目名称须各不相同。");
  }
  const unit = input.unit === undefined ? undefined : text(input.unit, 16);
  return { title, guide, questions, chart: { title: text(input.title, 80), unit, points } };
}

export function parseLessonJson(source: string): Lesson {
  if (source.length > maxInputBytes || new TextEncoder().encode(source).byteLength > maxInputBytes) {
    throw new Error("课程 JSON 不能超过 16 KiB。");
  }
  return parseLesson(JSON.parse(source) as unknown);
}

export function normalizeLessonChoice(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim();
}

export type LessonGrade = { invalidQuestion: number } | { answers: number[]; correct: number };

export function gradeLesson(lesson: Lesson, choices: readonly (string | undefined)[]): LessonGrade {
  const selected = lesson.questions.map((_, index) => normalizeLessonChoice(choices[index]));
  const invalidQuestion = selected.findIndex((value, index) =>
    !/^[1-6]$/.test(value) || Number(value) > lesson.questions[index].options.length);
  if (invalidQuestion >= 0) return { invalidQuestion };
  const answers = selected.map(Number);
  return { answers, correct: answers.filter((answer, index) => answer === lesson.questions[index].answer).length };
}
