import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

export function copyRuntimeDbGeneratedAssets(repoRoot: string = resolveRepoRoot()): void {
  const sourceDir = resolve(repoRoot, 'src/server/db/generated');
  const targetDir = resolve(repoRoot, 'dist/server/db/generated');

  if (!existsSync(sourceDir)) {
    throw new Error(`Runtime DB generated assets directory does not exist: ${sourceDir}`);
  }

  mkdirSync(dirname(targetDir), { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyRuntimeDbGeneratedAssets();
}
