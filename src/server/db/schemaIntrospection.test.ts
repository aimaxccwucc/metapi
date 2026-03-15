import { describe, expect, it } from 'vitest';
import { normalizeDefaultValue, normalizeSqlType } from './schemaIntrospection.js';

describe('schema introspection normalization', () => {
  it('normalizes booleans consistently across dialects', () => {
    expect(normalizeSqlType('sqlite', 'INTEGER', 'use_system_proxy')).toBe('boolean');
    expect(normalizeSqlType('mysql', 'tinyint', 'use_system_proxy')).toBe('boolean');
    expect(normalizeSqlType('postgres', 'boolean', 'use_system_proxy')).toBe('boolean');
  });

  it('normalizes common default values', () => {
    expect(normalizeDefaultValue("DEFAULT 'active'")).toBe("'active'");
    expect(normalizeDefaultValue('DEFAULT FALSE')).toBe('false');
    expect(normalizeDefaultValue("datetime('now')")).toBe("datetime('now')");
  });
});
