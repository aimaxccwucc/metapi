import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Accounts batch apikey source guards', () => {
  it('supports batch api key text input and bypasses single-key verification gate', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Accounts.tsx'), 'utf8');
    const helperSource = readFileSync(resolve(process.cwd(), 'src/web/pages/helpers/accountHelpers.ts'), 'utf8');
    expect(helperSource).toContain("accessTokens: ''");
    expect(source).toContain('批量 API Key（可选，支持换行、空格、逗号分隔）');
    expect(source).toContain("accessTokens: activeSegment === 'apikey' ? tokenForm.accessTokens : undefined");
    expect(source).toContain("if (activeSegment === 'apikey' && batchApiKeyCount <= 1 && !verifyResult?.success && !tokenForm.skipModelFetch)");
    expect(source).toContain("const hasBatchApiKeys = activeSegment === 'apikey'");
  });
});
