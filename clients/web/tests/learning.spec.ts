import { expect, test, type Page } from "@playwright/test";

async function openLearning(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill("study-" + Date.now().toString(36) + "-" + Math.random()
    .toString(36).slice(2, 6));
  await page.getByLabel("密码", { exact: true }).fill("local-learning-fixture!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: "对话工作区" })).toBeVisible();
  const trigger = page.getByRole("button", { name: "学习模式", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "学习模式" });
  await expect(dialog.getByRole("heading", { name: "从图表比较数据" })).toBeVisible();
  return { trigger, dialog };
}

test.describe("local learning and text fallback", () => {
  test.skip(Boolean(process.env.ASSISTANT_WEB_TEST_API_ORIGIN), "This panel can be tested with the loopback browser fixture.");

  test("completes the chart quiz by keyboard and in the text-only view while offline", async ({ page, context }) => {
    const { dialog, trigger } = await openLearning(page);
    await context.setOffline(true);
    await expect(dialog.getByRole("list", { name: "项目及数值" })).toContainText("周二7 本");
    await dialog.getByLabel("基准项目").selectOption("周一");
    await dialog.getByLabel("比较项目").selectOption("周二");
    await expect(dialog.getByText("周二减去周一，差值 3 本。")).toBeVisible();
    const quiz = dialog.getByRole("form", { name: "课后练习" });
    const first = quiz.getByRole("group", { name: /哪一天的借阅量最多/ });
    const second = quiz.getByRole("group", { name: /周二比周一多借阅/ });
    const grade = quiz.getByRole("button", { name: "提交答案", exact: true });
    await first.getByRole("radio", { name: "周一" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(first.getByRole("radio", { name: "周二" })).toBeChecked();
    await grade.focus();
    await page.keyboard.press("Enter");
    await expect(quiz.getByText("请选择第 2 题的有效选项。")).toBeVisible();
    await expect(second.getByRole("radio", { name: "2 本", exact: true })).toBeFocused();
    await page.keyboard.press("Space");
    await grade.focus();
    await page.keyboard.press("Enter");
    await expect(quiz.getByRole("status")).toHaveText("答对 1 / 2 题。");
    await expect(second).toContainText("答错了。 正确选项是「3 本」。");

    const choiceMode = dialog.getByRole("button", { name: "文本练习", exact: true });
    await choiceMode.focus();
    await page.keyboard.press("Enter");
    await expect(choiceMode).toHaveAttribute("aria-pressed", "true");
    const table = dialog.getByRole("table", { name: "本周借阅量" });
    await expect(table.getByRole("row", { name: /周二.*7 本/ })).toBeVisible();
    await expect(dialog.getByText("周二减去周一，差值 3 本。")).toBeVisible();
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await expect(dialog.getByLabel("第 1 题答案序号")).toHaveValue("2");
    await dialog.getByLabel("第 2 题答案序号").fill("２");
    await grade.focus();
    await page.keyboard.press("Enter");
    await expect(quiz.getByRole("status")).toHaveText("答对 2 / 2 题。");
    await expect(second).toContainText("两者相差 3 本。");

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await context.setOffline(false);
  });

  test("keeps malformed lessons out and renders accepted content as plain text on a narrow screen", async ({ page }) => {
    const { dialog } = await openLearning(page);
    await page.setViewportSize({ width: 320, height: 680 });
    await dialog.getByText("导入课程 JSON", { exact: true }).click();
    const editor = dialog.getByRole("textbox", { name: "课程 JSON" });
    const importButton = dialog.getByRole("button", { name: "载入课程", exact: true });
    await editor.fill("{");
    await importButton.click();
    await expect(dialog.getByRole("alert")).toHaveText("JSON 格式不正确，请检查后重新导入。");
    const guide = '<img src="https://example.com/x" onerror="window.__studyUnsafe=true">';
    const lesson = {
      title: "本地合成课程",
      guide: [guide],
      questions: [{ prompt: "请选择负数", options: ["负三", "正二"], answer: 1, explanation: "−3 小于 0。" }],
      chart: {
        title: "含负数的示例",
        unit: "单位",
        points: [{ label: "a".repeat(32), value: -3 }, { label: "正数", value: 2 }],
      },
    };
    await editor.fill(JSON.stringify({ ...lesson, html: "<script>alert(1)</script>" }));
    await importButton.click();
    await expect(dialog.getByRole("alert")).toContainText("多余字段");
    await expect(dialog.getByRole("heading", { name: "从图表比较数据" })).toBeVisible();

    await editor.fill(JSON.stringify(lesson));
    await importButton.click();
    await expect(dialog.getByRole("heading", { name: lesson.title })).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByText(guide, { exact: true })).toBeVisible();
    await expect(dialog.locator("img, script, a")).toHaveCount(0);
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await dialog.getByRole("button", { name: "文本练习", exact: true }).click();
    const table = dialog.getByRole("table", { name: "含负数的示例" });
    await expect(table.getByRole("cell", { name: "-3 单位" })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await dialog.getByLabel("第 1 题答案序号").fill("1");
    await dialog.getByRole("button", { name: "提交答案", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("答对 1 / 1 题。");
  });
});
