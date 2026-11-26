const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');

const cache = path.resolve(__dirname, '../.cache');
fs.mkdirSync(cache, { recursive: true });
const profile = fs.mkdtempSync(path.join(cache, 'smoke-profile-'));

const smoke = process.argv[2] === 'workbench' ? 'workbench-smoke.cjs' : 'electron-smoke.cjs';
const child = spawn(electron, [`--user-data-dir=${profile}`, path.join(__dirname, smoke)], {
  stdio: 'inherit',
  windowsHide: true,
});
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (status) => {
  process.exitCode = status ?? 1;
});
