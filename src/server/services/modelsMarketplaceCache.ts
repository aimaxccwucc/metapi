const MODELS_MARKETPLACE_BASE_TTL_MS = 15_000;
const MODELS_MARKETPLACE_PRICING_TTL_MS = 90_000;

type ModelsMarketplaceCacheEntry = {
  expiresAt: number;
  models: any[];
};

const modelsMarketplaceCache = new Map<'base' | 'pricing', ModelsMarketplaceCacheEntry>();

export function readModelsMarketplaceCache(includePricing: boolean): any[] | null {
  const key = includePricing ? 'pricing' : 'base';
  const cached = modelsMarketplaceCache.get(key);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    modelsMarketplaceCache.delete(key);
    return null;
  }
  return cached.models;
}

export function writeModelsMarketplaceCache(includePricing: boolean, models: any[]): void {
  const ttl = includePricing ? MODELS_MARKETPLACE_PRICING_TTL_MS : MODELS_MARKETPLACE_BASE_TTL_MS;
  const key = includePricing ? 'pricing' : 'base';
  modelsMarketplaceCache.set(key, {
    expiresAt: Date.now() + ttl,
    models,
  });
}

export function invalidateModelsMarketplaceCache(): void {
  modelsMarketplaceCache.clear();
}
