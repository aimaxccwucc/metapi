export interface DownstreamRoutingPolicy {
  supportedModels: string[];
  allowedRouteIds: number[];
  siteWeightMultipliers: Record<number, number>;
  denyAllWhenEmpty?: boolean;
  stickySessionKey?: string | null;
  publicRoutesOnly?: boolean;
}

export const EMPTY_DOWNSTREAM_ROUTING_POLICY: DownstreamRoutingPolicy = {
  supportedModels: [],
  allowedRouteIds: [],
  siteWeightMultipliers: {},
  stickySessionKey: null,
  publicRoutesOnly: false,
};
