import { type DownstreamFormat } from '../../shared/normalized.js';

export function shouldRetryNormalizedMessagesBody(input: {
  downstreamFormat: DownstreamFormat;
  endpointPath: string;
  status: number;
  upstreamErrorText: string;
}): boolean {
  if (input.downstreamFormat !== 'claude') return false;
  if (!input.endpointPath.includes('/v1/messages')) return false;
  if (input.status < 400 || input.status >= 500) return false;
  return /messages\s+is\s+required/i.test(input.upstreamErrorText);
}

export function isMessagesRequiredError(upstreamErrorText: string): boolean {
  return /messages\s+is\s+required/i.test(upstreamErrorText);
}
