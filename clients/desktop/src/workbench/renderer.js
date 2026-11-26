'use strict';

const api = window.localWorkbench;
const byId = (id) => document.getElementById(id);
const editor = byId('source');
const versions = byId('revision');
const code = byId('diff');
const literal = byId('literal-version');
const initialScope = byId('scope-value').textContent;
const encoder = new TextEncoder();

let project = null;
let inspection = null;
let running = false;

function dirty() { return project && editor.value !== project.source; }

function paintControls() {
  const changed = Boolean(dirty());
  const currentInspected = project && inspection?.number === project.revision;
  const reviewed = project && project.reviewed === project.revision;
  byId('workspace').hidden = !project;
  byId('clear').hidden = !project;
  for (const id of ['choose', 'clear', 'revision', 'source']) byId(id).disabled = running;
  byId('save').disabled = running || !changed;
  byId('restore').disabled = running || !changed;
  byId('approve').disabled = running || changed || !currentInspected || reviewed;
  byId('verify').disabled = running || changed || !reviewed;
  byId('export').disabled = running || changed || !project?.report;
  if (project) {
    const bytes = encoder.encode(editor.value).length;
    byId('size').textContent = `${bytes} / 32,768 字节${changed ? ' · 有未保存编辑' : ''}`;
  }
  document.dispatchEvent(new Event('workbench-controls-changed'));
}

function renderSnapshot() {
  byId('scope-value').textContent = project ? `${project.name} / ${project.entry}` : initialScope;
  byId('head-revision').textContent = project ? `第 ${project.revision} 版` : '';
  byId('review-status').textContent = project ? (project.reviewed ? `第 ${project.reviewed} 版已确认` : '等待审阅') : '';
  const report = project?.report;
  byId('build-status').textContent = report ? (report.outcome === 'passed' ? '语法编译通过' : '语法编译失败') : '';
  byId('build-details').hidden = !report;
  byId('build-revision').textContent = report ? `第 ${report.revision} 版` : '';
  byId('compiler').textContent = report ? `${report.compiler.name} ${report.compiler.version}` : '';
  byId('source-hash').textContent = report?.sourceSha256 ?? '';
  byId('cache-size').textContent = report ? `${report.cacheBytes} 字节` : '';
  byId('diagnostics').textContent = report?.diagnostics.join('\n') ?? '';
  paintControls();
}

function renderInspection(next) {
  inspection = next;
  code.replaceChildren();
  code.hidden = !next?.rows.length;
  literal.hidden = !next;
  literal.open = false;
  byId('literal-source').textContent = next?.source ?? '';
  if (!next) {
    byId('diff-summary').textContent = '';
    paintControls();
    return;
  }
  const adds = next.rows.filter(({ kind }) => kind === 'add').length;
  const removes = next.rows.filter(({ kind }) => kind === 'remove').length;
  byId('diff-summary').textContent = next.previous === null ? '第 1 版来自选中的样例目录。'
    : `与第 ${next.previous} 版相比 · 新增 ${adds} 行 · 删除 ${removes} 行`;
  const rows = document.createDocumentFragment();
  for (const row of next.rows) {
    const element = document.createElement('li');
    element.dataset.kind = row.kind;
    const position = document.createElement('span');
    position.className = 'change-line';
    position.textContent = row.kind === 'add' ? `新增 ${row.after}` : row.kind === 'remove' ? `删除 ${row.before}` : `${row.before} → ${row.after}`;
    const content = document.createElement('code');
    content.textContent = row.text;
    element.append(position, content);
    rows.append(element);
  }
  code.replaceChildren(rows);
  paintControls();
}

async function call(action, ...args) {
  const result = await api[action](...args);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

async function attach(next) {
  project = next;
  editor.value = next?.source ?? '';
  versions.replaceChildren();
  renderInspection(null);
  renderSnapshot();
  if (!next) return;
  for (const revision of [...next.revisions].reverse()) {
    const option = new Option(`第 ${revision.number} 版`, String(revision.number));
    versions.add(option);
  }
  versions.value = String(next.revision);
  renderInspection(await call('inspect', next.id, next.revision));
}

async function operate(label, action) {
  if (running) return;
  running = true;
  byId('error').textContent = '';
  byId('status').textContent = label;
  paintControls();
  try { byId('status').textContent = (await action()) ?? ''; }
  catch (error) {
    byId('status').textContent = '';
    byId('error').textContent = error.message;
  } finally { running = false; paintControls(); }
}

byId('choose').addEventListener('click', () => void operate('正在选择目录…', async () => {
  let next;
  try { next = await call('choose'); }
  catch (error) {
    if (!await call('snapshot')) await attach(null);
    throw error;
  }
  if (!next) return '已取消选择目录。';
  await attach(next);
  return '已载入所选样例。';
}));

byId('clear').addEventListener('click', () => void operate('正在撤销…', async () => {
  await attach(await call('clear'));
  return '已撤销目录授权。';
}));

editor.addEventListener('input', paintControls);
byId('restore').addEventListener('click', () => {
  if (!project) return;
  editor.value = project.source;
  byId('error').textContent = '';
  byId('status').textContent = '已恢复当前修订。';
  paintControls();
});

byId('save').addEventListener('click', () => void operate('正在保存修订…', async () => {
  await attach(await call('save', project.id, project.revision, editor.value));
  return `已保存第 ${project.revision} 版。`;
}));

versions.addEventListener('change', () => void operate('正在读取修订…', async () => {
  renderInspection(await call('inspect', project.id, Number(versions.value)));
}));

byId('approve').addEventListener('click', () => void operate('正在确认审阅…', async () => {
  project = await call('review', project.id, project.revision);
  renderSnapshot();
  return `已确认审阅第 ${project.revision} 版。`;
}));

byId('verify').addEventListener('click', () => void operate('正在编译语法…', async () => {
  project = await call('build', project.id, project.revision);
  renderSnapshot();
  return project.report.outcome === 'passed' ? '语法编译通过。' : '语法编译失败。可查看诊断。';
}));

byId('export').addEventListener('click', () => void operate('正在选择保存目录…', async () => {
  const filename = await call('export', project.id, project.revision);
  return filename ? `已导出 ${filename}。` : '已取消导出。';
}));

void operate('正在载入工作台…', async () => { await attach(await call('snapshot')); });
