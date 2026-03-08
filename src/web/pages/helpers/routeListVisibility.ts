export type RouteListVisibilityItem = {
  id: number;
  modelPattern: string;
  displayName?: string | null;
  enabled: boolean;
};

function hasCustomDisplayName(route: Pick<RouteListVisibilityItem, 'modelPattern' | 'displayName'>): boolean {
  const displayName = (route.displayName || '').trim();
  const modelPattern = (route.modelPattern || '').trim();
  return !!displayName && displayName !== modelPattern;
}

export function buildVisibleRouteList<T extends RouteListVisibilityItem>(
  routes: T[],
  isExactModelPattern: (pattern: string) => boolean,
  matchesModelPattern: (model: string, pattern: string) => boolean,
): T[] {
  const coveringGroups = routes.filter((route) => (
    route.enabled
    && !isExactModelPattern(route.modelPattern)
    && hasCustomDisplayName(route)
  ));

  if (coveringGroups.length === 0) return routes;

  return routes.filter((route) => {
    if (!isExactModelPattern(route.modelPattern)) return true;
    if (hasCustomDisplayName(route)) return true;

    const exactModel = (route.modelPattern || '').trim();
    if (!exactModel) return true;

    return !coveringGroups.some((groupRoute) => (
      groupRoute.id !== route.id
      && matchesModelPattern(exactModel, groupRoute.modelPattern)
    ));
  });
}
