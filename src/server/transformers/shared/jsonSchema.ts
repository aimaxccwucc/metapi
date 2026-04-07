function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const SCHEMA_MAP_KEYS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

const SCHEMA_LIST_KEYS = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);

const SCHEMA_VALUE_KEYS = new Set([
  'additionalProperties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

function schemaTypeIncludesObject(type: unknown): boolean {
  if (typeof type === 'string') return type.trim().toLowerCase() === 'object';
  if (!Array.isArray(type)) return false;
  return type.some((item) => typeof item === 'string' && item.trim().toLowerCase() === 'object');
}

function sanitizeRequired(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const required = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return required.length > 0 ? required : undefined;
}

function sanitizeSchemaMap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeJsonSchemaNode(item)]),
  );
}

function sanitizeJsonSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonSchemaNode(item));
  }

  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'required') {
      const required = sanitizeRequired(entry);
      if (required) next.required = required;
      continue;
    }

    if (SCHEMA_MAP_KEYS.has(key)) {
      if (isRecord(entry)) next[key] = sanitizeSchemaMap(entry);
      continue;
    }

    if (SCHEMA_LIST_KEYS.has(key)) {
      if (Array.isArray(entry)) {
        next[key] = entry.map((item) => sanitizeJsonSchemaNode(item));
      }
      continue;
    }

    if (SCHEMA_VALUE_KEYS.has(key)) {
      next[key] = isRecord(entry) || Array.isArray(entry)
        ? sanitizeJsonSchemaNode(entry)
        : entry;
      continue;
    }

    next[key] = sanitizeJsonSchemaNode(entry);
  }

  if (schemaTypeIncludesObject(next.type) || 'properties' in next || 'required' in next) {
    if (!isRecord(next.properties)) next.properties = {};
  }

  return next;
}

export function sanitizeJsonSchemaForFunctionTool(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeJsonSchemaNode(value);
  if (!isRecord(sanitized)) {
    return { type: 'object', properties: {} };
  }
  if (schemaTypeIncludesObject(sanitized.type) || 'properties' in sanitized || 'required' in sanitized) {
    if (!isRecord(sanitized.properties)) sanitized.properties = {};
  }
  return sanitized;
}
