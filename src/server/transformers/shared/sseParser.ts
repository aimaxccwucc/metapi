export interface SseEvent {
  data: string;
  event?: string;
}

export function* parseSseBuffer(buffer: string): Generator<SseEvent> {
  const text = buffer.includes('\r') ? buffer.replace(/\r\n/g, '\n') : buffer;

  let rest = text;
  while (true) {
    const boundary = rest.indexOf('\n\n');
    if (boundary < 0) break;

    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);

    if (!block.trim()) continue;

    const lines = block.split('\n');
    let eventName = '';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length <= 0) continue;

    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;

    yield { data: payload, event: eventName || undefined };
  }
}

/**
 * Pull SSE events (with event names) from a buffer.
 * Returns parsed events and the unconsumed remainder.
 */
export function pullSseEventsWithDone(buffer: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const text = buffer.includes('\r') ? buffer.replace(/\r\n/g, '\n') : buffer;

  let rest = text;
  const events: Array<{ event: string; data: string }> = [];

  while (true) {
    const boundary = rest.indexOf('\n\n');
    if (boundary < 0) break;
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    if (!block.trim()) continue;

    const lines = block.split('\n');
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) { dataLines.push(line.slice(5).trimStart()); }
    }
    if (dataLines.length <= 0) continue;
    events.push({ event: eventName, data: dataLines.join('\n').trim() });
  }

  return { events, rest };
}

/**
 * Pull SSE data payloads (ignoring event names) from a buffer.
 * Skips [DONE] markers. Returns parsed data strings and the unconsumed remainder.
 */
export function pullSseDataEvents(buffer: string): { events: string[]; rest: string } {
  const { events: raw, rest } = pullSseEventsWithDone(buffer);
  const events: string[] = [];
  for (const { data } of raw) {
    if (!data || data === '[DONE]') continue;
    events.push(data);
  }
  return { events, rest };
}
