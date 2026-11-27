import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { backendModule, resolveBackend } from './backend-checkout.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const contracts = join(project, 'packages', 'contracts');
const backend = resolveBackend(project);
const web = join(project, 'clients', 'web');
const windows = process.platform === 'win32';
const suiteNames = ['contracts', 'backend', 'api', 'web'];
const usage = `Usage: node qa/verify.mjs [--only contracts,backend,api,web]
  --api-url URL          Standard loopback API origin (default http://127.0.0.1:18090)
  --expired-api-url URL  Additional loopback API origin with a small event-retention limit
  --skip-install         Reuse existing npm dependencies and Playwright Chromium
  --with-browser-deps    Install Chromium system dependencies with Playwright`;

function apiOrigin(value, option) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${option} requires an HTTP(S) loopback origin.`);
  }
  return url.origin;
}

function npm(name, cwd, args, requires = []) {
  return { name, cwd, executable: 'npm', args, requires, windowsScript: 'npm.cmd' };
}

function smoke(name, script, origin, overrides) {
  return { name, cwd: project, executable: process.execPath,
    args: [join('qa', script), origin], overrides };
}

async function run(check, directory) {
  const { name, cwd, executable, args, windowsScript, overrides, preflight } = check;
  const log = `${name}.log`;
  const output = await open(join(directory, log), 'wx');
  const started = performance.now();
  let result;
  const command = [windows && windowsScript ? windowsScript : executable, ...args];
  try {
    if (preflight && !existsSync(join(cwd, preflight))) {
      await output.writeFile(`Missing ${relative(project, join(cwd, preflight))}. Supply the assistant backend checkout.\n`);
      result = { exitCode: null };
    } else {
      const runScript = windows && windowsScript;
      const child = spawn(runScript ? (process.env.ComSpec || 'cmd.exe') : executable,
        runScript ? ['/d', '/s', '/c', ...command] : args, {
          cwd, env: { ...process.env, ...overrides }, stdio: ['ignore', output.fd, output.fd], windowsHide: true,
        });
      result = await new Promise((resolve) => {
        child.once('error', (error) => resolve({ exitCode: null, error: error.message }));
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });
      if (result.error) await output.writeFile(`${result.error}\n`);
    }
  } finally {
    await output.close();
  }
  return { name, status: result.exitCode === 0 ? 'passed' : 'failed',
    durationMs: Math.round(performance.now() - started), cwd: relative(project, cwd) || '.', command, log, ...result };
}

async function main() {
  const { values } = parseArgs({ options: {
    only: { type: 'string', default: suiteNames.join(',') },
    'api-url': { type: 'string', default: 'http://127.0.0.1:18090' },
    'expired-api-url': { type: 'string' },
    'skip-install': { type: 'boolean' },
    'with-browser-deps': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log(usage);
    return;
  }
  const selected = values.only.split(',').map((name) => name.trim());
  if (selected.some((name) => !suiteNames.includes(name))) throw new Error('Unknown suite in --only.');
  const suites = suiteNames.filter((name) => selected.includes(name));
  if (values['skip-install'] && values['with-browser-deps']) {
    throw new Error('--with-browser-deps requires browser installation.');
  }
  const api = apiOrigin(values['api-url'], '--api-url');
  const expired = values['expired-api-url'] && apiOrigin(values['expired-api-url'], '--expired-api-url');
  if (expired === api) throw new Error('Use separate origins for standard and truncated event histories.');
  const install = !values['skip-install'];
  const contractsSelected = suites.includes('contracts');
  const webContracts = contractsSelected ? 'contracts-test' : 'web-contracts-generate';
  const webDependencies = [webContracts, ...(install ? ['web-install'] : [])];
  const plans = {
    contracts: [
      ...(install ? [npm('contracts-install', contracts, ['ci'])] : []),
      npm('contracts-test', contracts, ['test'], install ? ['contracts-install'] : []),
    ],
    backend: [{ name: 'backend-verify', cwd: backend, executable: './mvnw', windowsScript: '.\\mvnw.cmd',
      args: ['-B', '-pl', ':continew-server', '-am', 'verify'], preflight: backendModule }],
    api: [
      smoke('api-account', 'assistant-account-smoke.mjs', api),
      smoke('api-conversations', 'assistant-conversation-smoke.mjs', api),
      smoke('api-run', 'assistant-run-smoke.mjs', api, {
        ASSISTANT_QA_EXPECT_SESSION_REVOCATION: 'true', ASSISTANT_QA_EXPECT_EXPIRED_CURSOR: 'false',
      }),
      ...(expired ? [smoke('api-expired-cursor', 'assistant-run-smoke.mjs', expired, {
        ASSISTANT_QA_EXPECT_EXPIRED_CURSOR: 'true',
      })] : []),
    ],
    web: [
      ...(!contractsSelected ? [
        ...(install ? [npm('web-contracts-install', contracts, ['ci'])] : []),
        npm(webContracts, contracts, ['run', 'generate'], install ? ['web-contracts-install'] : []),
      ] : []),
      ...(install ? [npm('web-install', web, ['ci']),
        npm('web-browser', web, ['exec', '--offline', '--', 'playwright', 'install', 'chromium',
          ...(values['with-browser-deps'] ? ['--with-deps'] : [])], ['web-install'])] : []),
      npm('web-build', web, ['run', 'build'], webDependencies),
      {
        ...npm('web-e2e', web, ['test'], ['web-build', ...(install ? ['web-browser'] : [])]),
        overrides: { ASSISTANT_WEB_TEST_PRODUCTION: 'true' },
      },
    ],
  };

  const startedAt = new Date().toISOString();
  const directory = join(project, 'qa', 'verify-results', `${startedAt.replace(/[:.]/g, '-')}-${process.pid}`);
  await mkdir(directory, { recursive: true });
  const checks = [];
  for (const suite of suites) {
    for (const check of plans[suite]) {
      const dependency = checks.find(({ name, status }) => check.requires?.includes(name) && status !== 'passed');
      if (dependency) {
        checks.push({ suite, name: check.name, status: 'skipped', reason: `${dependency.name} did not pass` });
        console.log(`${check.name} skipped`);
        continue;
      }
      console.log(`${check.name} running`);
      const result = await run(check, directory);
      checks.push({ suite, ...result });
      console.log(`${check.name} ${result.status} ${relative(project, join(directory, result.log))}`);
    }
  }
  const status = checks.every((check) => check.status === 'passed') ? 'passed' : 'failed';
  const report = join(directory, 'summary.json');
  await writeFile(report, JSON.stringify({ schemaVersion: 1, status, startedAt,
    finishedAt: new Date().toISOString(), suites, checks }, null, 2) + '\n');
  console.log(`QA ${status} ${relative(project, report)}`);
  if (status === 'failed') process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
