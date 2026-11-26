const { constants } = require('node:fs');
const { lstat, open, realpath, unlink } = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { Script } = require('node:vm');

const entry = 'main.cjs';
const marker = 'qingyu-workbench.json';
const sampleSchema = 'qingyu-local-code-sample/1';
const maxSourceBytes = 32768;
const maxLines = 400;
const maxRevisions = 24;
const maxCacheBytes = 262144;

class WorkbenchError extends Error {}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function localDirectory(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) ||
      (process.platform === 'win32' && !/^[A-Za-z]:\\/.test(candidate))) {
    throw new WorkbenchError('请选择本机磁盘上的目录。');
  }
  const selected = path.resolve(candidate);
  const canonical = await realpath(selected);
  const identity = await lstat(selected, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || !samePath(selected, canonical)) {
    throw new WorkbenchError('请选择实际目录。此入口不接受目录链接。');
  }
  return { path: canonical, identity };
}

async function verifyDirectory(root) {
  const current = await localDirectory(root.path);
  if (!sameIdentity(root.identity, current.identity)) throw new WorkbenchError('目录已变化，请重新选择。');
}

function isOrdinaryFile(info) {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1n;
}

async function readScopedText(root, name, limit) {
  const filename = path.join(root.path, name);
  const before = await lstat(filename, { bigint: true });
  if (!isOrdinaryFile(before) || !samePath(filename, await realpath(filename))) {
    throw new WorkbenchError('样例文件必须是目录内的普通文件。');
  }
  if (before.size > BigInt(limit)) throw new WorkbenchError('样例文件超过允许大小。');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!isOrdinaryFile(opened) || !sameIdentity(before, opened) || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) {
      throw new WorkbenchError('样例文件已变化，请重新选择。');
    }
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const end = await handle.stat({ bigint: true });
    const current = await lstat(filename, { bigint: true });
    await verifyDirectory(root);
    if (offset > limit || BigInt(offset) !== opened.size || !isOrdinaryFile(current) || !sameIdentity(opened, current)
      || end.size !== opened.size || end.mtimeNs !== opened.mtimeNs || current.mtimeNs !== opened.mtimeNs) {
      throw new WorkbenchError('样例文件已变化，请重新选择。');
    }
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset)); }
    catch { throw new WorkbenchError('请使用 UTF-8 编码的样例文件。'); }
  } finally { await handle.close(); }
}

function validateSource(value) {
  if (typeof value !== 'string' || value.length > maxSourceBytes || Buffer.byteLength(value, 'utf8') > maxSourceBytes) {
    throw new WorkbenchError('源代码最多 32 KiB。');
  }
  const source = value.replace(/\r\n?/g, '\n');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source) || source.split('\n').length > maxLines) {
    throw new WorkbenchError('源代码限 400 行，支持换行和制表符。');
  }
  if (source !== Buffer.from(source, 'utf8').toString('utf8')) throw new WorkbenchError('源代码包含无法保存的字符。');
  return source;
}

function diffLines(before, after) {
  if (before === after) return [];
  const left = before.split('\n');
  const right = after.split('\n');
  const matches = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let row = left.length - 1; row >= 0; row--) {
    for (let column = right.length - 1; column >= 0; column--) {
      matches[row][column] = left[row] === right[column] ? matches[row + 1][column + 1] + 1
        : Math.max(matches[row + 1][column], matches[row][column + 1]);
    }
  }
  const rows = [];
  let row = 0;
  let column = 0;
  while (row < left.length || column < right.length) {
    if (row < left.length && column < right.length && left[row] === right[column]) {
      rows.push({ kind: 'same', before: row + 1, after: column + 1, text: left[row] });
      row++;
      column++;
    } else if (row < left.length && (column === right.length || matches[row + 1][column] >= matches[row][column + 1])) {
      rows.push({ kind: 'remove', before: row + 1, text: left[row++] });
    } else {
      rows.push({ kind: 'add', after: column + 1, text: right[column++] });
    }
  }
  return rows;
}

function createRevision(number, source) {
  return { number, source, sha256: createHash('sha256').update(source).digest('hex'),
    bytes: Buffer.byteLength(source), createdAt: new Date().toISOString() };
}

function buildReport(revision) {
  const metadata = { schema: 'qingyu-syntax-build/1', entry, revision: revision.number, sourceSha256: revision.sha256,
    sourceBytes: revision.bytes, compiler: { name: 'V8 Script', version: process.versions.v8 },
    createdAt: new Date().toISOString() };
  try {
    const cache = new Script(revision.source, { filename: entry }).createCachedData();
    if (!cache.length || cache.length > maxCacheBytes) throw new Error('Unexpected compiler cache size');
    return { ...metadata, outcome: 'passed', diagnostics: [], cacheBytes: cache.length,
      cacheSha256: createHash('sha256').update(cache).digest('hex'), cacheBase64: cache.toString('base64') };
  } catch (error) {
    const diagnostic = error instanceof SyntaxError ? String(error.message).slice(0, 240) : '暂时无法生成编译缓存。';
    return { ...metadata, outcome: 'failed', diagnostics: [diagnostic], cacheBytes: 0 };
  }
}

class WorkbenchStore {
  #project;
  #generation = 0;

  clear() {
    this.#generation++;
    this.#project = undefined;
    return null;
  }

  async select(candidate) {
    this.clear();
    const generation = this.#generation;
    const root = await localDirectory(candidate);
    let manifest;
    try { manifest = JSON.parse((await readScopedText(root, marker, 1024)).replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError('请选择含青屿样例标记的目录。');
    }
    if (!manifest || manifest.schema !== sampleSchema || manifest.entry !== entry || Object.keys(manifest).length !== 2) {
      throw new WorkbenchError('请选择含青屿样例标记的目录。');
    }
    let source;
    try { source = validateSource(await readScopedText(root, entry, maxSourceBytes)); }
    catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError('无法读取样例中的 main.cjs。');
    }
    if (generation !== this.#generation) return null;
    this.#project = { id: randomUUID(), name: path.basename(root.path), revisions: [createRevision(1, source)],
      reviewed: null, report: null };
    return this.snapshot();
  }

  #current(id) {
    const project = this.#project;
    if (!project || id !== project.id) throw new WorkbenchError('目录授权已失效，请重新选择样例。');
    return project;
  }

  #atHead(id, revision) {
    const project = this.#current(id);
    if (revision !== project.revisions.length) {
      throw new WorkbenchError('修订已变化，请重新打开当前修订。');
    }
    return project;
  }

  snapshot() {
    const project = this.#project;
    if (!project) return null;
    const revision = project.revisions.at(-1);
    const { cacheBase64: ignored, ...summary } = project.report ?? {};
    return { id: project.id, name: project.name, entry, revision: revision.number, source: revision.source,
      revisions: project.revisions.map(({ number, sha256, bytes, createdAt }) => ({ number, sha256, bytes, createdAt })),
      reviewed: project.reviewed, report: project.report ? summary : null };
  }

  inspect(id, revision) {
    const project = this.#current(id);
    if (!Number.isInteger(revision) || revision < 1 || revision > project.revisions.length) {
      throw new WorkbenchError('请选择现有修订。');
    }
    const target = project.revisions[revision - 1];
    const previous = project.revisions[revision - 2];
    return { ...target, previous: previous?.number ?? null, rows: previous ? diffLines(previous.source, target.source) : [] };
  }

  save(id, expected, value) {
    const project = this.#atHead(id, expected);
    const source = validateSource(value);
    if (source === project.revisions.at(-1).source) return this.snapshot();
    if (project.revisions.length >= maxRevisions) throw new WorkbenchError('当前样例已达到 24 个修订。');
    project.revisions.push(createRevision(expected + 1, source));
    project.reviewed = null;
    project.report = null;
    return this.snapshot();
  }

  review(id, revision) {
    const project = this.#atHead(id, revision);
    project.reviewed = revision;
    return this.snapshot();
  }

  build(id, revision) {
    const project = this.#atHead(id, revision);
    if (!project.reviewed || project.reviewed !== revision) throw new WorkbenchError('请先审阅并确认这一修订。');
    project.report = buildReport(project.revisions.at(-1));
    return this.snapshot();
  }

  async export(id, revision, candidate) {
    const project = this.#atHead(id, revision);
    const report = project.report;
    if (!report) throw new WorkbenchError('请先生成该修订的验证产物。');
    const output = await localDirectory(candidate);
    this.#atHead(id, revision);
    if (report !== project.report) throw new WorkbenchError('验证结果已变化，请重新导出。');
    const name = `qingyu-build-r${revision}.json`;
    const file = path.join(output.path, name);
    const payload = JSON.stringify(report, null, 2) + '\n';
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new WorkbenchError('所选目录已有同名产物，请选择其他目录。');
      throw new WorkbenchError('无法在此目录创建验证产物。');
    }
    try {
      const created = await handle.stat({ bigint: true });
      await verifyDirectory(output);
      const current = await lstat(file, { bigint: true });
      this.#atHead(id, revision);
      if (report !== project.report) throw new WorkbenchError('验证结果已变化，请重新导出。');
      if (!isOrdinaryFile(current) || !sameIdentity(created, current)) throw new WorkbenchError('产物路径已变化，请重新选择。');
      await handle.writeFile(payload, 'utf8');
      this.#atHead(id, revision);
      return name;
    } catch (error) {
      const created = await handle.stat({ bigint: true }).catch(() => null);
      await handle.close().catch(() => undefined);
      const existing = await lstat(file, { bigint: true }).catch(() => null);
      if (created && existing && isOrdinaryFile(existing) && sameIdentity(created, existing)) await unlink(file).catch(() => undefined);
      throw error;
    } finally { await handle.close().catch(() => undefined); }
  }
}

module.exports = { WorkbenchStore, WorkbenchError, maxSourceBytes, sampleSchema };
