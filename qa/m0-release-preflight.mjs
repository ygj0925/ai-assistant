import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const executableSuffix = windows ? '.exe' : '';

function probe(name, args, env = process.env) {
  const result = spawnSync(name, args, {
    env, encoding: 'utf8', timeout: 8_000, maxBuffer: 64 * 1024,
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error?.code === 'ENOENT') return { state: 'missing' };
  if (result.status !== 0) return { state: 'unavailable', failure: result.error?.code ?? 'EXIT_NONZERO' };
  return { state: 'available', output: result.stdout.trim() };
}

function locatedCommand(name, roots, relatives) {
  for (const base of roots.filter(Boolean)) {
    for (const relative of relatives) {
      const candidate = path.resolve(base, relative, name + executableSuffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name + executableSuffix;
}

function androidDebugPackage(sdkRoots) {
  const artifact = 'clients/mobile/android/app/build/outputs/apk/debug/app-debug.apk';
  const apk = path.resolve(root, artifact);
  if (!existsSync(apk)) return { state: 'missing' };
  const versions = [];
  for (const sdk of sdkRoots) {
    const directory = path.resolve(sdk, 'build-tools');
    if (!existsSync(directory)) continue;
    const entries = readdirSync(directory).filter((name) => /^\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    versions.push(...entries.map((name) => path.resolve(directory, name)));
  }
  const command = locatedCommand('aapt2', versions, ['']);
  const result = probe(command, ['dump', 'badging', apk]);
  if (result.state !== 'available') return { artifact, state: 'uninspected' };
  const sdk = (name) => {
    const match = new RegExp(`^${name}:'(\\d+)'$`, 'm').exec(result.output);
    return match ? Number(match[1]) : null;
  };
  const native = /^native-code: (.+)$/m.exec(result.output)?.[1] ?? '';
  return {
    artifact, state: 'inspected', minSdk: sdk('minSdkVersion') ?? sdk('sdkVersion'),
    targetSdk: sdk('targetSdkVersion'),
    architectures: [...native.matchAll(/'([a-z0-9_-]+)'/gi)].map((match) => match[1]),
  };
}

function android() {
  const sdkRoots = [...new Set([process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean))];
  const command = locatedCommand('adb', sdkRoots, ['platform-tools']);
  const result = probe(command, ['devices']);
  const counts = { emulators: 0, deviceTargets: 0, unavailable: 0 };
  for (const row of result.output?.split(/\r?\n/) ?? []) {
    const match = /^(\S+)\s+(device|offline|unauthorized)\s*$/.exec(row);
    if (!match) continue;
    if (match[2] !== 'device') counts.unavailable += 1;
    else if (match[1].startsWith('emulator-')) counts.emulators += 1;
    else counts.deviceTargets += 1;
  }
  const platforms = new Set();
  for (const base of sdkRoots) {
    const directory = path.resolve(base, 'platforms');
    if (!existsSync(directory)) continue;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory() && /^android-\d+$/.test(item.name)) platforms.add(item.name);
    }
  }
  return { adb: result.state, installedPlatforms: [...platforms].sort(), ...counts, debugPackage: androidDebugPackage(sdkRoots) };
}

function harmony() {
  const roots = [process.env.HARMONYOS_SDK_HOME, process.env.OHOS_SDK_HOME, process.env.DEVECO_SDK_HOME];
  if (windows && process.env.ProgramFiles) {
    roots.push(path.join(process.env.ProgramFiles, 'Huawei', 'DevEco Studio'));
    roots.push(path.join(process.env.ProgramFiles, 'DevEco Studio'));
  }
  const command = locatedCommand('hdc', roots, ['toolchains', 'HarmonyOS/toolchains', 'sdk/default/HarmonyOS/toolchains']);
  const result = probe(command, ['list', 'targets']);
  const targets = result.output?.split(/\r?\n/).filter((line) => line && line !== '[Empty]').length ?? 0;
  return { hdc: result.state, targets };
}

function apple() {
  if (process.platform !== 'darwin') return { buildHost: false, xcode: 'unavailable' };
  const result = probe('xcodebuild', ['-version']);
  return { buildHost: true, xcode: result.state, version: /^Xcode ([\d.]+)/.exec(result.output ?? '')?.[1] ?? null };
}

async function windowsPackage(architecture) {
  const relative = `clients/desktop/dist/QingyuAssistant-win32-${architecture}/qingyu-assistant.exe`;
  const executable = path.resolve(root, relative);
  if (!existsSync(executable)) return { architecture, state: 'missing' };
  const input = await open(executable);
  let machine;
  try {
    const header = Buffer.alloc(64);
    const pe = Buffer.alloc(6);
    const { bytesRead } = await input.read(header, 0, header.length, 0);
    if (bytesRead === header.length && header.toString('ascii', 0, 2) === 'MZ') {
      const { bytesRead: peBytes } = await input.read(pe, 0, pe.length, header.readUInt32LE(60));
      if (peBytes === pe.length && pe.readUInt32LE(0) === 0x4550) machine = pe.readUInt16LE(4);
    }
  } finally {
    await input.close();
  }
  const actualArchitecture = { 0x8664: 'x64', 0xaa64: 'arm64' }[machine] ?? null;
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(executable)) hash.update(bytes);
  let signing = 'not-inspected';
  if (windows) {
    const signingEnv = { ...process.env, ASSISTANT_QA_PACKAGE_PATH: executable };
    // Windows PowerShell resolves its own module paths even when launched from PowerShell 7.
    for (const name of Object.keys(signingEnv)) {
      if (name.toLowerCase() === 'psmodulepath') delete signingEnv[name];
    }
    const result = probe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-AuthenticodeSignature -LiteralPath $env:ASSISTANT_QA_PACKAGE_PATH -ErrorAction Stop).Status.ToString()'], signingEnv);
    if (result.state === 'available' && /^\w+$/.test(result.output)) signing = result.output;
    else signing = 'unavailable';
  }
  return {
    architecture, state: actualArchitecture === architecture ? 'present' : 'unexpected-architecture',
    actualArchitecture, artifact: relative, bytes: (await stat(executable)).size, sha256: hash.digest('hex'), signing,
  };
}

const modelConfigured = Boolean(process.env.M0_MODEL_ID?.trim());
console.log(JSON.stringify({
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  host: { platform: process.platform, architecture: process.arch, node: process.versions.node },
  android: android(),
  harmony: harmony(),
  apple: apple(),
  windowsPackages: await Promise.all(['x64', 'arm64'].map(windowsPackage)),
  evaluationCredentials: {
    dashscope: modelConfigured && Boolean(process.env.DASHSCOPE_API_KEY?.trim()),
    ark: modelConfigured && Boolean(process.env.ARK_API_KEY?.trim()),
  },
}, null, 2));
