import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('App sidebar config', () => {
  it('uses 连接管理 for /accounts and removes standalone /tokens navigation item', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');

    expect(source).toContain("{ to: '/accounts', label: '连接管理'");
    expect(source).not.toContain("{ to: '/accounts', label: '账号'");
    expect(source).not.toContain("{ to: '/tokens', label: '令牌管理'");
  });
});
