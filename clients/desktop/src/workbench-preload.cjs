const { contextBridge, ipcRenderer } = require('electron');

const channel = 'qingyu:local-workbench';
const invoke = (operation, ...args) => ipcRenderer.invoke(channel, operation, ...args);

contextBridge.exposeInMainWorld('localWorkbench', {
  choose: () => invoke('choose'),
  snapshot: () => invoke('snapshot'),
  clear: () => invoke('clear'),
  inspect: (id, revision) => invoke('inspect', id, revision),
  save: (id, revision, source) => typeof source === 'string' && source.length <= 32768
    ? invoke('save', id, revision, source) : Promise.resolve({ ok: false, message: '源代码最多 32 KiB。' }),
  review: (id, revision) => invoke('review', id, revision),
  build: (id, revision) => invoke('build', id, revision),
  export: (id, revision) => invoke('export', id, revision),
  companionState: () => invoke('companionState'),
  companionLogin: (username, password) => invoke('companionLogin', username, password),
  companionLogout: () => invoke('companionLogout'),
  companionOffer: () => invoke('companionOffer'),
  companionConfirm: (id) => invoke('companionConfirm', id),
  companionUnpair: (id) => invoke('companionUnpair', id),
  companionPublish: () => invoke('companionPublish'),
  companionBuild: () => invoke('companionBuild'),
});
