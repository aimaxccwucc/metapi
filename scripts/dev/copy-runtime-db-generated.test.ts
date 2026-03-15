import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { copyRuntimeDbGeneratedAssets } from './copy-runtime-db-generated.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('copyRuntimeDbGeneratedAssets', () => {
  it('copies generated runtime db artifacts into dist', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'metapi-runtime-db-assets-'));
    tempDirs.push(repoRoot);

    const sourceDir = join(repoRoot, 'src', 'server', 'db', 'generated');
    const nestedDir = join(sourceDir, 'fixtures');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(sourceDir, 'mysql.bootstrap.sql'), 'create table demo ();');
    writeFileSync(join(nestedDir, 'baseline.json'), '{"ok":true}');

    copyRuntimeDbGeneratedAssets(repoRoot);

    expect(
      readFileSync(join(repoRoot, 'dist', 'server', 'db', 'generated', 'mysql.bootstrap.sql'), 'utf8'),
    ).toBe('create table demo ();');
    expect(
      readFileSync(join(repoRoot, 'dist', 'server', 'db', 'generated', 'fixtures', 'baseline.json'), 'utf8'),
    ).toBe('{"ok":true}');
  });
});
