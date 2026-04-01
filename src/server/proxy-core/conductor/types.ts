export type SelectedChannelLike = {
  channel: { id: number; routeId?: number; [key: string]: any };
  site: any;
  account: any;
  token?: any;
  tokenName?: string;
  tokenValue?: string;
  actualModel?: string;
};

export type AttemptSuccess = {
  ok: true;
  response: unknown;
  latencyMs?: number | null;
  cost?: number | null;
};

export type AttemptFailureAction =
  | 'retry_same_channel'
  | 'refresh_auth'
  | 'failover'
  | 'terminal'
  | 'stop';

export type AttemptFailure = {
  ok: false;
  action: AttemptFailureAction;
  status?: number;
  rawErrorText?: string;
  retryAfterHeader?: string | null;
  retryAfterMs?: number | null;
  error?: unknown;
};

export type AttemptResult = AttemptSuccess | AttemptFailure;

export type ExecuteAttemptContext = {
  selected: SelectedChannelLike;
  attemptIndex: number;
  excludeChannelIds: number[];
  excludeSiteIds: number[];
  maxAttempts: number;
};

export type ProxyConductorDependencies = {
  selectChannel: (requestedModel: string, downstreamPolicy?: unknown) => Promise<SelectedChannelLike | null>;
  previewSelectedChannel?: (requestedModel: string, downstreamPolicy?: unknown) => Promise<SelectedChannelLike | null>;
  selectNextChannel: (
    requestedModel: string,
    excludeChannelIds: number[],
    downstreamPolicy?: unknown,
    excludeSiteIds?: ReadonlySet<number>,
  ) => Promise<SelectedChannelLike | null>;
  recordSuccess?: (channelId: number, metrics: { latencyMs: number | null; cost: number | null }) => Promise<void> | void;
  recordFailure?: (channelId: number, failure: {
    status?: number;
    rawErrorText?: string;
    retryAfterHeader?: string | null;
    retryAfterMs?: number | null;
  }) => Promise<void> | void;
  refreshAuth?: (
    selected: SelectedChannelLike,
    failure: {
      status?: number;
      rawErrorText?: string;
      retryAfterHeader?: string | null;
      retryAfterMs?: number | null;
    },
  ) => Promise<SelectedChannelLike | null>;
};

export type ExecuteInput = {
  requestedModel: string;
  downstreamPolicy?: unknown;
  maxAttempts?: number;
  onBeforeInitialSelect?: () => Promise<void> | void;
  refreshSelection?: () => Promise<SelectedChannelLike | null>;
  onNoChannel?: (context: { attempts: number }) => Promise<void> | void;
  getFailoverSiteId?: (selected: SelectedChannelLike, failure: {
    status?: number;
    rawErrorText?: string;
    retryAfterHeader?: string | null;
    retryAfterMs?: number | null;
  }) => number | null;
  attempt: (context: ExecuteAttemptContext) => Promise<AttemptResult>;
  onTerminalFailure?: (
    selected: SelectedChannelLike,
    failure: {
      status?: number;
      rawErrorText?: string;
      retryAfterHeader?: string | null;
      retryAfterMs?: number | null;
    },
  ) => Promise<void> | void;
};

export type ExecuteResult =
  | {
    ok: true;
    selected: SelectedChannelLike;
    response: unknown;
    attempts: number;
  }
  | {
    ok: false;
    reason: 'no_channel' | 'failed' | 'terminal';
    selected?: SelectedChannelLike;
    status?: number;
    rawErrorText?: string;
    retryAfterHeader?: string | null;
    retryAfterMs?: number | null;
    attempts: number;
  };
