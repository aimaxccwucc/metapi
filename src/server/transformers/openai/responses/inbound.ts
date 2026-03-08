import { normalizeResponsesInputForCompatibility, normalizeResponsesMessageItem } from './compatibility.js';

export const openAiResponsesInbound = {
  normalizeInput: normalizeResponsesInputForCompatibility,
  normalizeMessage: normalizeResponsesMessageItem,
};
