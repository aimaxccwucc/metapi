import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('release workflow', () => {
  it('ships source release plus docker images without desktop packaging jobs', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toContain('name: Publish GitHub Release');
    expect(workflow).toContain('name: Publish Docker Image (${{ matrix.arch }})');
    expect(workflow).toContain('arch: armv7');
    expect(workflow).toContain('platform: linux/arm/v7');

    expect(workflow).not.toContain('macos-15-intel');
    expect(workflow).not.toContain('macos-15');
    expect(workflow).not.toContain('verifyMacArchitecture');
    expect(workflow).not.toContain('electron-builder');
  });
});
