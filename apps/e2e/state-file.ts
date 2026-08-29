import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const workspaceKey = createHash('sha256')
  .update(packageRoot)
  .digest('hex')
  .slice(0, 12);

export const stateFilePath = join(tmpdir(), `moi-e2e-${workspaceKey}.json`);

export type E2eStateFile = Readonly<{
  controlOrigin: string;
  credential: string;
}>;
