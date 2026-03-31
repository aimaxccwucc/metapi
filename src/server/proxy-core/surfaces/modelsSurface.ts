function isSearchPseudoModel(modelName: string): boolean {
  const normalized = (modelName || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized === '__search' || /^__.+_search$/.test(normalized);
}

type ModelsSurfaceInput = {
  downstreamPolicy: unknown;
  responseFormat: 'openai' | 'claude';
  tokenRouter: {
    getAvailableModels(downstreamPolicy?: unknown): Promise<string[]>;
  };
  refreshModelsAndRebuildRoutes(): Promise<unknown>;
  isModelAllowed(modelName: string, downstreamPolicy: unknown): Promise<boolean>;
  allowRefreshOnEmpty?: boolean;
  now?: () => Date;
};

type VisibleModelsRead = {
  rawModels: string[];
  allowedModels: string[];
};

async function readVisibleModels(input: ModelsSurfaceInput): Promise<VisibleModelsRead> {
  const rawModels = Array.from(new Set(await input.tokenRouter.getAvailableModels(input.downstreamPolicy)))
    .filter((modelName) => !isSearchPseudoModel(modelName))
    .sort();
  const allowedModels: string[] = [];
  for (const modelName of rawModels) {
    if (!await input.isModelAllowed(modelName, input.downstreamPolicy)) {
      continue;
    }
    allowedModels.push(modelName);
  }
  return {
    rawModels,
    allowedModels,
  };
}

export async function listModelsSurface(input: ModelsSurfaceInput) {
  let read = await readVisibleModels(input);
  if (read.rawModels.length === 0 && input.allowRefreshOnEmpty !== false) {
    await input.refreshModelsAndRebuildRoutes();
    read = await readVisibleModels(input);
  }
  const models = read.allowedModels;

  const now = input.now?.() ?? new Date();
  if (input.responseFormat === 'claude') {
    const data = models.map((id) => ({
      id,
      type: 'model' as const,
      display_name: id,
      created_at: now.toISOString(),
    }));
    return {
      data,
      first_id: data[0]?.id || null,
      last_id: data[data.length - 1]?.id || null,
      has_more: false,
    };
  }

  return {
    object: 'list' as const,
    data: models.map((id) => ({
      id,
      object: 'model' as const,
      created: Math.floor(now.getTime() / 1000),
      owned_by: 'metapi',
    })),
  };
}
