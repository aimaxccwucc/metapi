export interface DownstreamRoutingPolicy {
  supportedModels: string[];
  allowedRouteIds: number[];
  siteWeightMultipliers: Record<number, number>;
  excludedSiteIds?: number[];
  excludedCredentialRefs?: string[];
  globalAllowedModels?: string[];
  denyAllWhenEmpty?: boolean;
  stickySessionKey?: string | null;
  forcedChannelId?: number | null;
  publicRoutesOnly?: boolean;
}

export const EMPTY_DOWNSTREAM_ROUTING_POLICY: DownstreamRoutingPolicy = {
  supportedModels: [],
  allowedRouteIds: [],
  siteWeightMultipliers: {},
  excludedSiteIds: [],
  excludedCredentialRefs: [],
  globalAllowedModels: [],
  stickySessionKey: null,
  forcedChannelId: null,
  publicRoutesOnly: false,
};
