import { describe, expect, it } from 'vitest';
import { classifyLegacyCompatMutation } from './legacySchemaCompat.js';

describe('legacy schema compat boundary', () => {
  it('allows only explicitly registered legacy upgrade shims', () => {
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN billing_details text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('UPDATE "sites" SET "use_system_proxy" = FALSE WHERE "use_system_proxy" IS NULL')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE "model_availability" ADD COLUMN "is_manual" BOOLEAN DEFAULT FALSE')).toBe('legacy');
    expect(classifyLegacyCompatMutation('UPDATE "model_availability" SET "is_manual" = FALSE WHERE "is_manual" IS NULL')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE sites ADD COLUMN brand_new_column text;')).toBe('forbidden');
    expect(classifyLegacyCompatMutation('UPDATE "sites" SET "brand_new_column" = 1')).toBe('forbidden');
  });
});
