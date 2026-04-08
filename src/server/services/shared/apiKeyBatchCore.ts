export function splitApiKeyBatchInput(input: string): string[] {
  return String(input || '')
    .split(/[\s,，;\n\r\t]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeApiKeyBatchInput(input: string): string[] {
  const unique = new Set<string>();
  for (const item of splitApiKeyBatchInput(input)) {
    unique.add(item);
  }
  return [...unique];
}
