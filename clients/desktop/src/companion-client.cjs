const { request } = require('node:http');
const { WorkbenchError } = require('./workbench-store.cjs');

const endpoint = '/desktop-companion';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const offerCode = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const pairStates = new Set(['awaiting_desktop_confirmation', 'active']);
const states = new Set(['pending', 'approved', 'declined', 'consumed']);
const events = new Set(['offer_created', 'mobile_claimed', 'paired', 'task_offered', 'task_approved', 'task_declined',
  'task_cancelled', 'task_consumed', 'pair_revoked', 'expired', 'device_unavailable']);
const unavailable = '本地接续服务暂不可用。';

function localOrigin(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !url.username
        && !url.password && (value === url.origin || value === url.origin + '/')) return url.origin;
  } catch { /* Invalid configuration disables the separate feature. */ }
  return undefined;
}

function isTime(value) {
  return typeof value === 'string' && value.length < 40 && Number.isFinite(Date.parse(value));
}

function key(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw new WorkbenchError('接续标识无效。');
  return value;
}

function scope({ scopeId, revision, sourceSha256 } = {}) {
  if (typeof scopeId !== 'string' || !uuid.test(scopeId) || !Number.isInteger(revision) || revision < 1
      || revision > 24 || typeof sourceSha256 !== 'string' || !digest.test(sourceSha256)) {
    throw new WorkbenchError('请选择有效的本地修订。');
  }
  return { scopeId, revision, sourceSha256 };
}

function publicState(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.audit)) throw new WorkbenchError(unavailable);
  const audit = value.audit.slice(-24).filter((row) => row && events.has(row.event) && isTime(row.at))
    .map(({ event, at }) => ({ event, at }));
  if (!value.pair) return { audit };
  const { id, state, role, peerDevice, expiresAt } = value.pair;
  if (!pairStates.has(state) || role !== 'desktop' || typeof peerDevice !== 'string' || !/^[a-f0-9]{8}$/.test(peerDevice)
      || !isTime(expiresAt)) throw new WorkbenchError(unavailable);
  const pair = { id: key(id), state, role, peerDevice, expiresAt };
  if (!value.task || pair.state !== 'active') return { pair, audit };
  if (!states.has(value.task.status) || !isTime(value.task.expiresAt)) throw new WorkbenchError(unavailable);
  return { pair, task: { id: key(value.task.id), ...scope(value.task), status: value.task.status, expiresAt: value.task.expiresAt }, audit };
}

async function json(response, limit) {
  if (!response.headers['content-type']?.toLowerCase().startsWith('application/json')
      || Number(response.headers['content-length']) > limit) throw new WorkbenchError(unavailable);
  const chunks = [];
  let length = 0;
  for await (const chunk of response) {
    length += chunk.byteLength;
    if (length > limit) throw new WorkbenchError(unavailable);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}

function directRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    // Use a separate one-shot agent so an environment proxy cannot receive the local credentials.
    const outgoing = request(url, { ...options, agent: false }, resolve);
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

class DesktopCompanionClient {
  #origin;
  #session;
  #generation = new AbortController();

  constructor(origin) { this.#origin = localOrigin(origin); }

  get configured() { return !!this.#origin; }
  get authenticated() { return !!this.#session && Date.parse(this.#session.expiresAt) > Date.now(); }

  async #send(method, route, status, body, session, signal = this.#generation.signal) {
    if (!this.#origin) throw new WorkbenchError(unavailable);
    const headers = { Accept: 'application/json' };
    if (session) {
      headers.Authorization = `Bearer ${session.token}`;
      headers['X-Workspace-Id'] = session.workspaceId;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }
    const joined = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    let response;
    try {
      response = await directRequest(this.#origin + '/api/assistant/v1' + route, { method, headers, signal: joined }, payload);
    } catch { throw new WorkbenchError(unavailable); }
    try {
      const returnedStatus = response.statusCode;
      if (returnedStatus === status) {
        const value = status === 204 ? undefined : await json(response, 16384);
        if (joined.aborted) throw new WorkbenchError(unavailable);
        return value;
      }
      if (returnedStatus === 401 && session && this.#session === session) this.#drop();
      const messages = { 400: '请核对当前输入。', 401: '桌面登录已失效或账号密码不正确。', 403: '当前工作空间不可接续。',
        404: '该设备或任务已不可访问。', 409: '接续范围、修订或审批状态已变化。', 429: '操作次数过多，请稍后再试。' };
      throw new WorkbenchError(messages[returnedStatus] ?? unavailable);
    } catch (error) {
      throw error instanceof WorkbenchError ? error : new WorkbenchError(unavailable);
    } finally {
      response.destroy();
    }
  }

  #drop() {
    this.#generation.abort();
    this.#generation = new AbortController();
    const session = this.#session;
    this.#session = undefined;
    return session;
  }

  async signIn(username, password) {
    if (this.authenticated) throw new WorkbenchError('请先退出当前桌面登录。');
    if (typeof username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(username) || typeof password !== 'string'
        || !password || password.includes('\0') || Buffer.byteLength(password, 'utf8') > 72) {
      throw new WorkbenchError('请核对账号和密码。');
    }
    this.#drop();
    const { signal } = this.#generation;
    const response = await this.#send('POST', '/auth/login', 200, { username, password }, undefined, signal);
    if (!response || typeof response.accessToken !== 'string' || !/^as_[A-Za-z0-9_-]{43}$/.test(response.accessToken)
        || !isTime(response.expiresAt) || typeof response.user?.workspaceId !== 'string' || !uuid.test(response.user.workspaceId)) {
      throw new WorkbenchError(unavailable);
    }
    const current = { token: response.accessToken, workspaceId: response.user.workspaceId, expiresAt: response.expiresAt };
    try {
      const caps = await this.#send('GET', '/capabilities', 200, undefined, current, signal);
      if (!caps?.capabilities?.some(({ id, available }) => id === 'local_desktop_companion' && available === true) || signal.aborted) {
        throw new WorkbenchError(unavailable);
      }
      this.#session = current;
      return await this.state();
    } catch (error) {
      if (this.#session === current) this.#drop();
      await this.#send('POST', '/auth/logout', 204, undefined, current, new AbortController().signal).catch(() => undefined);
      throw error;
    }
  }

  async signOut() {
    const session = this.#drop();
    if (session) await this.#send('POST', '/auth/logout', 204, undefined, session).catch(() => undefined);
  }

  #authorized() {
    if (!this.authenticated) throw new WorkbenchError('请先登录本地接续。');
    return this.#session;
  }

  async state() {
    if (!this.authenticated) return { configured: this.configured, signedIn: false };
    const current = await this.#send('GET', endpoint, 200, undefined, this.#authorized());
    return { configured: true, signedIn: true, ...publicState(current) };
  }

  async createOffer() {
    const offer = await this.#send('POST', endpoint + '/offers', 201, undefined, this.#authorized());
    if (typeof offer?.code !== 'string' || !offerCode.test(offer.code) || !isTime(offer.expiresAt)) throw new WorkbenchError(unavailable);
    return { code: offer.code, expiresAt: offer.expiresAt };
  }

  async confirm(id) {
    await this.#send('POST', `${endpoint}/pairs/${key(id)}/confirm`, 200, { confirm: true }, this.#authorized());
    return this.state();
  }

  async revoke(id) {
    await this.#send('DELETE', `${endpoint}/pairs/${key(id)}`, 204, undefined, this.#authorized());
    return this.state();
  }

  async publish(pair, binding) {
    const value = await this.#send('PUT', `${endpoint}/pairs/${key(pair)}/task`, 200, scope(binding), this.#authorized());
    return { configured: true, signedIn: true, ...publicState(value) };
  }

  async withdraw(pair, task) {
    await this.#send('DELETE', `${endpoint}/pairs/${key(pair)}/task/${key(task)}`, 204, undefined, this.#authorized());
  }

  async consume(pair, task, binding) {
    await this.#send('POST', `${endpoint}/pairs/${key(pair)}/task/${key(task)}/consume`, 204, scope(binding), this.#authorized());
  }
}

module.exports = { DesktopCompanionClient };
