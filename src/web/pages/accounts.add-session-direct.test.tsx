import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Accounts session add flow', () => {
  it('allows adding session accounts without prior verification', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Accounts.tsx'), 'utf8');
    expect(source).toContain("const canSubmitWithoutVerification = activeSegment === 'session';");
    expect(source).toContain("if (activeSegment === 'apikey' && batchApiKeyCount <= 1 && !verifyResult?.success && !tokenForm.skipModelFetch)");
    expect(source).toContain('(!canSubmitWithoutVerification && !canAddVerifiedConnection)');
  });
});
