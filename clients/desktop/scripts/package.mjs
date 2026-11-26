import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { packager } from '@electron/packager';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: {
    platform: { type: 'string', default: process.platform },
    arch: { type: 'string', default: process.arch },
  },
});
const { platform, arch } = values;
if (!['win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error('支持的打包目标为 Windows 或 macOS 的 x64 和 arm64。');
}

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const zipDir = process.env.ASSISTANT_DESKTOP_ELECTRON_ZIP_DIR;
const outputs = await packager({
  dir: root,
  name: 'QingyuAssistant',
  executableName: 'qingyu-assistant',
  appBundleId: 'dev.assistant.qingyu.desktop',
  platform,
  arch,
  electronVersion: manifest.devDependencies.electron,
  out: path.join(root, 'dist'),
  asar: true,
  prune: true,
  ignore: (file) => file !== '' && file !== '/package.json' && file !== '/src' && !file.startsWith('/src/'),
  ...(zipDir ? { electronZipDir: path.resolve(zipDir) } : {}),
});

if (outputs.length !== 1) throw new Error('没有生成新包。请检查 dist 下当前目标的输出。');
for (const directory of outputs) {
  const file = path.join(directory, platform === 'darwin' ? 'QingyuAssistant.app' : 'qingyu-assistant.exe');
  await flipFuses(file, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  });
  console.log(directory);
}
