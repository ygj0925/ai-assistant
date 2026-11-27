import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const envFile = new URL('.env', import.meta.url);
const secrets = [
  'ASSISTANT_PG_ADMIN_PASSWORD',
  'ASSISTANT_DB_PASSWORD',
  'ASSISTANT_QA_DB_PASSWORD',
  'ASSISTANT_REDIS_PASSWORD',
  'ASSISTANT_S3_ACCESS_KEY',
  'ASSISTANT_S3_SECRET_KEY',
];
const contents = ['DB_NAME=ai_assistant',
  ...secrets.map((name) => `${name}=${randomBytes(24).toString('hex')}`)].join('\n');

try {
  await writeFile(envFile, `${contents}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created infra/local/.env');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Using the existing infra/local/.env');
}
