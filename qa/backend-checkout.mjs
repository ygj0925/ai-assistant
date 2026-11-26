import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const backendModule = join('continew-assistant', 'pom.xml');

export function resolveBackend(project) {
  const nested = join(project, 'services', 'api');
  if (existsSync(join(nested, backendModule))) return nested;

  const sibling = join(project, '..', 'ai-assistant-api');
  return existsSync(join(sibling, backendModule)) ? sibling : nested;
}
