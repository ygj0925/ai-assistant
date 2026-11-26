const { WorkbenchError } = require('./workbench-store.cjs');

function sameBinding(first, second) {
  return first && second && first.scopeId === second.scopeId && first.revision === second.revision
    && first.sourceSha256 === second.sourceSha256;
}

class CompanionWorkbench {
  #store;
  #client;
  #sourceEpoch = 0;
  #sessionEpoch = 0;
  #working = false;
  #published;
  #withdrawal;

  constructor(store, client) {
    this.#store = store;
    this.#client = client;
  }

  #binding() {
    const project = this.#store.snapshot();
    if (!project || project.reviewed !== project.revision) return undefined;
    return { scopeId: project.id, revision: project.revision, sourceSha256: project.revisions.at(-1).sha256 };
  }

  sourceChanged() {
    this.#sourceEpoch++;
    const published = this.#published;
    this.#published = undefined;
    if (published) this.#withdraw(published.pair, published.task);
  }

  #withdraw(pair, task) {
    const session = this.#sessionEpoch;
    const pending = this.#client.withdraw(pair, task).catch(async () => {
      if (session !== this.#sessionEpoch) return;
      // No further heartbeat may extend a task whose withdrawal could not be verified.
      await this.signOut();
    }).finally(() => { if (this.#withdrawal === pending) this.#withdrawal = undefined; });
    this.#withdrawal = pending;
    return pending;
  }

  signOut() {
    this.#sessionEpoch++;
    this.#published = undefined;
    return this.#client.signOut();
  }

  async perform(action, ...args) {
    if (action === 'companionLogout') { await this.signOut(); return this.#client.state(); }
    if (this.#working) throw new WorkbenchError('已有接续操作进行中。');
    this.#working = true;
    try {
      await this.#withdrawal;
      return await this.#perform(action, ...args);
    } finally { this.#working = false; }
  }

  async #perform(action, first, second) {
    switch (action) {
      case 'companionState': return this.#state();
      case 'companionLogin': return this.#client.signIn(first, second);
      case 'companionOffer': return this.#client.createOffer();
      case 'companionConfirm': return this.#client.confirm(first);
      case 'companionUnpair': {
        const state = await this.#client.revoke(first);
        this.#published = undefined;
        return state;
      }
      case 'companionPublish': return this.#publish();
      case 'companionBuild': return this.#build();
      default: throw new WorkbenchError('无效的接续操作。');
    }
  }

  async #state() {
    const state = await this.#client.state();
    if (state.task && !sameBinding(state.task, this.#binding())) {
      const { pair, task, ...publicState } = state;
      await this.#withdraw(pair.id, task.id);
      return { ...publicState, pair: this.#client.authenticated ? pair : undefined, signedIn: this.#client.authenticated };
    }
    return state;
  }

  async #publish() {
    const epoch = this.#sourceEpoch;
    const binding = this.#binding();
    if (!binding) throw new WorkbenchError('请先审阅当前本地修订。');
    const state = await this.#state();
    if (epoch !== this.#sourceEpoch || state.pair?.state !== 'active') throw new WorkbenchError('请核对本地修订和配对设备。');
    let result;
    try {
      result = await this.#client.publish(state.pair.id, binding);
      if (!sameBinding(result.task, binding) || result.pair?.id !== state.pair.id) throw new WorkbenchError('无法核对发布的修订。');
    } catch (error) {
      // The request can commit even when its response is lost. End the authority in that case.
      await this.signOut();
      throw error;
    }
    if (epoch !== this.#sourceEpoch) {
      await this.#withdraw(result.pair.id, result.task.id);
      throw new WorkbenchError('发布期间本地修订已变化。');
    }
    this.#published = { pair: result.pair.id, task: result.task.id };
    return result;
  }

  async #build() {
    const epoch = this.#sourceEpoch;
    const session = this.#sessionEpoch;
    const binding = this.#binding();
    const state = await this.#state();
    if (epoch !== this.#sourceEpoch || state.task?.status !== 'approved' || !sameBinding(state.task, binding)) {
      throw new WorkbenchError('当前本地修订没有有效的手机批准。');
    }
    await this.#client.consume(state.pair.id, state.task.id, binding);
    if (session !== this.#sessionEpoch || epoch !== this.#sourceEpoch || !sameBinding(binding, this.#binding())) {
      throw new WorkbenchError('授权或当前本地修订已变化。');
    }
    return this.#store.build(binding.scopeId, binding.revision);
  }
}

module.exports = { CompanionWorkbench };
