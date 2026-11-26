'use strict';

(() => {
  const entry = (id) => byId(`companion-${id}`);
  const auditNames = { offer_created: '生成配对码', mobile_claimed: '手机请求配对', paired: '确认设备配对',
    task_offered: '发布修订', task_approved: '手机批准修订', task_declined: '手机拒绝修订', task_cancelled: '撤回修订',
    task_consumed: '桌面领取批准', pair_revoked: '解除配对', expired: '授权到期', device_unavailable: '设备授权失效' };
  const taskNames = { pending: '等待手机批准', approved: '手机已批准', declined: '手机已拒绝', consumed: '桌面已领取批准' };
  const time = (value) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
  let signed = {};
  let offer;
  let waiting = false;

  function paint() {
    byId('companion').hidden = !signed.configured;
    const { signedIn, pair, task, audit } = signed;
    const validTask = task && Date.parse(task.expiresAt) > Date.now() && !dirty()
      && project?.id === task.scopeId && project.reviewed === task.revision && project.revision === task.revision
      && project.revisions.at(-1).sha256 === task.sourceSha256;
    entry('login').hidden = Boolean(signedIn);
    entry('login').querySelector('button').disabled = waiting;
    entry('signed').hidden = !signedIn;
    entry('logout').hidden = !signedIn;
    entry('pair').textContent = pair ? `${pair.state === 'active' ? '已配对手机' : '手机请求配对'} · ${pair.peerDevice} · 到期 ${time(pair.expiresAt)}`
      : '暂无配对手机。';
    entry('offer').hidden = Boolean(pair);
    entry('confirm').hidden = pair?.state !== 'awaiting_desktop_confirmation';
    entry('unpair').hidden = !pair;
    entry('publish').hidden = pair?.state !== 'active';
    entry('build').hidden = !validTask || task.status !== 'approved';
    for (const id of ['offer', 'confirm', 'unpair']) entry(id).disabled = waiting;
    entry('publish').disabled = waiting || running || !project || dirty() || project.reviewed !== project.revision
      || validTask && (task.status === 'approved' || task.status === 'pending');
    entry('build').disabled = waiting || running;
    if (!signedIn || pair || offer && Date.parse(offer.expiresAt) <= Date.now()) offer = undefined;
    entry('code').hidden = !offer;
    entry('code').textContent = offer ? `配对码 ${offer.code} · 到期 ${time(offer.expiresAt)}` : '';
    entry('task').hidden = !validTask;
    entry('task').textContent = validTask ? `第 ${task.revision} 版 · ${taskNames[task.status]} · 到期 ${time(task.expiresAt)}\n目录授权 ${task.scopeId.slice(0, 8)}\n源码 SHA-256 ${task.sourceSha256}` : '';
    entry('history').hidden = !audit?.length;
    const rows = (audit ?? []).map(({ event, at }) => {
      const row = document.createElement('li');
      row.textContent = `${time(at)} · ${auditNames[event]}`;
      return row;
    });
    entry('audit').replaceChildren(...rows);
  }

  async function run(action, quiet = false) {
    if (waiting) return;
    waiting = true;
    if (!quiet) { entry('error').textContent = ''; entry('notice').textContent = ''; }
    paint();
    try { await action(); entry('error').textContent = ''; }
    catch (error) {
      signed = { configured: signed.configured, signedIn: signed.signedIn };
      offer = undefined;
      entry('error').textContent = error.message;
    } finally { waiting = false; paint(); }
  }

  entry('login').addEventListener('submit', (event) => {
    event.preventDefault();
    const username = entry('account').value;
    const password = entry('password').value;
    entry('password').value = '';
    void run(async () => { signed = await call('companionLogin', username, password); entry('account').value = ''; });
  });
  entry('logout').addEventListener('click', () => {
    entry('password').value = '';
    offer = undefined;
    signed = { configured: signed.configured };
    paint();
    void call('companionLogout').then((state) => { signed = state; paint(); }).catch(() => undefined);
  });
  entry('offer').addEventListener('click', () => void run(async () => { offer = await call('companionOffer'); }));
  entry('confirm').addEventListener('click', () => void run(async () => { signed = await call('companionConfirm', signed.pair.id); }));
  entry('unpair').addEventListener('click', () => void run(async () => { signed = await call('companionUnpair', signed.pair.id); }));
  entry('publish').addEventListener('click', () => void run(async () => { signed = await call('companionPublish'); }));
  entry('build').addEventListener('click', () => void run(async () => {
    if (running || dirty()) return;
    await operate('正在按手机批准验证…', async () => {
      project = await call('companionBuild');
      renderSnapshot();
      return project.report.outcome === 'passed' ? '语法编译通过。' : '语法编译失败。可查看诊断。';
    });
    signed = await call('companionState');
  }));

  document.addEventListener('workbench-controls-changed', paint);
  const refresh = () => void run(async () => { signed = await call('companionState'); }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (signed.signedIn && !document.hidden) refresh(); }, 4000);
  refresh();
})();
