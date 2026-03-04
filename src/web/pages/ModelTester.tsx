import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { clearAuthSession, getAuthToken } from '../authSession.js';
import {
  DEBUG_TABS,
  DEFAULT_INPUTS,
  DEFAULT_PARAMETER_ENABLED,
  MODEL_TESTER_STORAGE_KEY,
  MESSAGE_STATUS,
  buildApiPayload,
  countConversationTurns,
  collectModelTesterModelNames,
  createLoadingAssistantMessage,
  createMessage,
  filterModelTesterModelNames,
  finalizeIncompleteMessage,
  findLastLoadingAssistantIndex,
  parseCustomRequestBody,
  parseModelTesterSession,
  processThinkTags,
  serializeModelTesterSession,
  syncCustomRequestBodyToMessages,
  syncMessagesToCustomRequestBody,
  type ChatMessage,
  type DebugTab,
  type ModelTesterInputs,
  type ParameterEnabled,
  type TestTargetFormat,
  type TestChatPayload,
} from './helpers/modelTesterSession.js';
import ModernSelect from '../components/ModernSelect.js';
import { useAnimatedVisibility } from '../components/useAnimatedVisibility.js';
import { tr } from '../i18n.js';

type ChatJobResponse = {
  jobId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  result?: unknown;
  error?: unknown;
};

type DebugTimelineEntry = {
  at: string;
  level: 'info' | 'warn' | 'error';
  text: string;
};

const POLL_INTERVAL_MS = 1200;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const formatJson = (value: unknown): string => {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractErrorMessage = (error: unknown): string => {
  const data = error as any;
  return data?.error?.message || data?.message || 'request failed';
};

const extractClaudeMessageContent = (result: any): { content: string; reasoningContent: string } => {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      contentParts.push(block.text);
      continue;
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      reasoningParts.push(block.thinking);
      continue;
    }
    if (typeof block.text === 'string') {
      contentParts.push(block.text);
    }
  }

  return {
    content: contentParts.join(''),
    reasoningContent: reasoningParts.join('\n\n'),
  };
};

const extractResponsesContent = (result: any): { content: string; reasoningContent: string } => {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];

  const pushContent = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) contentParts.push(value);
  };
  const pushReasoning = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) reasoningParts.push(value);
  };

  const directOutputText = result?.output_text;
  if (typeof directOutputText === 'string') {
    pushContent(directOutputText);
  } else if (Array.isArray(directOutputText)) {
    for (const item of directOutputText) {
      if (typeof item === 'string') {
        pushContent(item);
        continue;
      }
      if (item && typeof item === 'object' && typeof (item as any).text === 'string') {
        pushContent((item as any).text);
      }
    }
  }

  const outputs = Array.isArray(result?.output)
    ? result.output
    : (result && typeof result === 'object' && (Array.isArray(result?.content) || typeof result?.type === 'string'))
      ? [result]
      : [];
  for (const item of outputs) {
    if (!item || typeof item !== 'object') continue;
    const itemType = typeof item.type === 'string' ? item.type : '';

    if (itemType === 'output_text') {
      pushContent(item.text);
      continue;
    }

    if (itemType === 'reasoning') {
      if (typeof item.summary_text === 'string') pushReasoning(item.summary_text);
      if (typeof item.reasoning === 'string') pushReasoning(item.reasoning);
      if (Array.isArray(item.summary)) {
        for (const summaryItem of item.summary) {
          if (summaryItem && typeof summaryItem === 'object' && typeof (summaryItem as any).text === 'string') {
            pushReasoning((summaryItem as any).text);
          }
        }
      }
    }

    const content = Array.isArray((item as any).content) ? (item as any).content : [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const blockType = typeof (block as any).type === 'string' ? (block as any).type : '';
      if (blockType === 'output_text' || blockType === 'text') {
        pushContent((block as any).text);
        continue;
      }
      if (blockType.includes('reasoning')) {
        pushReasoning((block as any).text);
      }
    }
  }

  return {
    content: contentParts.join(''),
    reasoningContent: reasoningParts.join('\n\n'),
  };
};

const extractAssistantResult = (result: unknown): { content: string; reasoningContent: string } => {
  const data = result as any;
  let content = '';
  let reasoning = '';

  if (Array.isArray(data?.choices)) {
    const choice = data.choices[0];
    const maybeContent = choice?.message?.content ?? choice?.text ?? '';
    content = typeof maybeContent === 'string'
      ? maybeContent
      : Array.isArray(maybeContent)
        ? maybeContent
          .map((item) => item?.text ?? '')
          .join('')
        : '';
    reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
  } else if (data?.type === 'message' && Array.isArray(data?.content)) {
    const parsedClaude = extractClaudeMessageContent(data);
    content = parsedClaude.content;
    reasoning = parsedClaude.reasoningContent;
  } else if (data?.object === 'response' || Array.isArray(data?.output) || typeof data?.output_text === 'string') {
    const parsedResponses = extractResponsesContent(data);
    content = parsedResponses.content;
    reasoning = parsedResponses.reasoningContent;
  } else if (Array.isArray(data?.candidates)) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      content = parts
        .filter((item: any) => !(item?.thought === true))
        .map((item: any) => (typeof item?.text === 'string' ? item.text : ''))
        .join('');
      reasoning = parts
        .filter((item: any) => item?.thought === true)
        .map((item: any) => (typeof item?.text === 'string' ? item.text : ''))
        .join('');
    }
  }

  const processed = processThinkTags(content, reasoning);

  if (!processed.content && processed.reasoningContent) {
    return {
      content: '[Only reasoning returned]',
      reasoningContent: processed.reasoningContent,
    };
  }
  if (!processed.content && !processed.reasoningContent) {
    return {
      content: formatJson(result),
      reasoningContent: '',
    };
  }

  return processed;
};

const replaceMessageAt = (messages: ChatMessage[], index: number, nextMessage: ChatMessage): ChatMessage[] => [
  ...messages.slice(0, index),
  nextMessage,
  ...messages.slice(index + 1),
];

const applyAssistantSuccess = (messages: ChatMessage[], result: unknown): ChatMessage[] => {
  const { content, reasoningContent } = extractAssistantResult(result);
  const targetIndex = findLastLoadingAssistantIndex(messages);

  if (targetIndex === -1) {
    return [...messages, createMessage('assistant', content, {
      status: MESSAGE_STATUS.COMPLETE,
      reasoningContent: reasoningContent || null,
      isThinkingComplete: true,
      isReasoningExpanded: false,
      hasAutoCollapsed: true,
    })];
  }

  const current = messages[targetIndex];
  return replaceMessageAt(messages, targetIndex, {
    ...current,
    content,
    reasoningContent: reasoningContent || null,
    status: MESSAGE_STATUS.COMPLETE,
    isThinkingComplete: true,
    isReasoningExpanded: false,
    hasAutoCollapsed: true,
  });
};

const applyAssistantError = (messages: ChatMessage[], errorMessage: string): ChatMessage[] => {
  const targetIndex = findLastLoadingAssistantIndex(messages);
  if (targetIndex === -1) {
    return [...messages, createMessage('assistant', errorMessage, {
      status: MESSAGE_STATUS.ERROR,
      isThinkingComplete: true,
    })];
  }

  const current = messages[targetIndex];
  return replaceMessageAt(messages, targetIndex, {
    ...current,
    content: errorMessage,
    status: MESSAGE_STATUS.ERROR,
    isThinkingComplete: true,
  });
};

const applyAssistantStopped = (messages: ChatMessage[]): ChatMessage[] => {
  const targetIndex = findLastLoadingAssistantIndex(messages);
  if (targetIndex === -1) return messages;

  const current = messages[targetIndex];
  return replaceMessageAt(messages, targetIndex, finalizeIncompleteMessage({
    ...current,
    content: current.content || 'Generation stopped.',
  }));
};

const applyAssistantDelta = (
  messages: ChatMessage[],
  delta: { contentDelta?: string; reasoningDelta?: string },
): ChatMessage[] => {
  const targetIndex = findLastLoadingAssistantIndex(messages);
  if (targetIndex === -1) return messages;

  const current = messages[targetIndex];
  let next: ChatMessage = {
    ...current,
    status: MESSAGE_STATUS.INCOMPLETE,
  };

  const toIncrementalText = (existingText: string, incomingText?: string): string => {
    if (!incomingText) return '';
    if (!existingText) return incomingText;

    if (incomingText === existingText) return '';
    if (incomingText.startsWith(existingText)) {
      return incomingText.slice(existingText.length);
    }
    if (existingText.endsWith(incomingText)) return '';

    const maxOverlap = Math.min(existingText.length, incomingText.length);
    const MIN_OVERLAP = 8;
    for (let overlap = maxOverlap; overlap >= MIN_OVERLAP; overlap -= 1) {
      if (existingText.slice(-overlap) === incomingText.slice(0, overlap)) {
        return incomingText.slice(overlap);
      }
    }

    return incomingText;
  };

  if (delta.reasoningDelta) {
    const existingReasoning = next.reasoningContent || '';
    const reasoningAppend = toIncrementalText(existingReasoning, delta.reasoningDelta);
    if (reasoningAppend) {
      next = {
        ...next,
        reasoningContent: existingReasoning + reasoningAppend,
        isThinkingComplete: false,
      };
    }
  }

  if (delta.contentDelta) {
    const existingContent = next.content || '';
    const contentAppend = toIncrementalText(existingContent, delta.contentDelta);
    if (!contentAppend) {
      return replaceMessageAt(messages, targetIndex, next);
    }

    const hasReasoning = Boolean(next.reasoningContent);
    const shouldAutoCollapse = hasReasoning && !next.hasAutoCollapsed;
    next = {
      ...next,
      content: existingContent + contentAppend,
      isReasoningExpanded: shouldAutoCollapse ? false : next.isReasoningExpanded,
      hasAutoCollapsed: shouldAutoCollapse || next.hasAutoCollapsed,
    };
  }

  return replaceMessageAt(messages, targetIndex, next);
};

const parseStreamErrorText = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      return extractErrorMessage(parsed);
    } catch {
      return text;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
};

const parseSseBlock = (block: string): { event: string; data: string | null } => {
  const lines = block.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    event,
    data: dataLines.length > 0 ? dataLines.join('\n') : null,
  };
};

const parseAnyStreamDelta = (eventPayload: any): {
  contentDelta?: string;
  reasoningDelta?: string;
  done?: boolean;
} => {
  if (!eventPayload || typeof eventPayload !== 'object') return {};

  if (Array.isArray(eventPayload.choices)) {
    const choice = eventPayload.choices[0];
    const delta = choice?.delta || {};
    const reasoningDelta = typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string'
        ? delta.reasoning
        : '';
    const contentDelta = typeof delta.content === 'string'
      ? delta.content
      : typeof choice?.message?.content === 'string'
        ? choice.message.content
        : '';

    return {
      contentDelta: contentDelta || undefined,
      reasoningDelta: reasoningDelta || undefined,
      done: Boolean(choice?.finish_reason),
    };
  }

  if (typeof eventPayload.type === 'string') {
    // Responses stream emits a full-text summary again in several "done" events
    // (output_text.done/content_part.done/output_item.done/response.completed).
    // Treat those as structural events only; otherwise UI appends duplicate text.
    if (eventPayload.type === 'response.output_item.added' || eventPayload.type === 'response.output_item.done') {
      return {};
    }

    if (eventPayload.type === 'response.content_part.added' || eventPayload.type === 'response.content_part.done') {
      return {};
    }

    if (eventPayload.type === 'response.content_part.delta') {
      const delta = eventPayload.delta;
      if (typeof delta === 'string') return { contentDelta: delta || undefined };
      if (delta && typeof delta === 'object') {
        const parsed = extractResponsesContent(delta);
        if (parsed.content || parsed.reasoningContent) {
          return {
            contentDelta: parsed.content || undefined,
            reasoningDelta: parsed.reasoningContent || undefined,
          };
        }
        const text = typeof (delta as any).text === 'string' ? (delta as any).text : '';
        return { contentDelta: text || undefined };
      }
    }

    if (eventPayload.type === 'response.output_text.delta') {
      const text = typeof eventPayload.delta === 'string'
        ? eventPayload.delta
        : typeof eventPayload.text === 'string'
          ? eventPayload.text
          : '';
      return { contentDelta: text || undefined };
    }

    if (eventPayload.type === 'response.reasoning_summary_text.delta' || eventPayload.type === 'response.reasoning.delta') {
      const text = typeof eventPayload.delta === 'string'
        ? eventPayload.delta
        : typeof eventPayload.text === 'string'
          ? eventPayload.text
          : '';
      return { reasoningDelta: text || undefined };
    }

    if (eventPayload.type === 'response.output_text.done') return {};

    if (eventPayload.type === 'response.completed' || eventPayload.type === 'response.failed') {
      return { done: true };
    }

    if (eventPayload.type === 'content_block_delta') {
      const delta = eventPayload.delta || {};
      const deltaType = typeof delta.type === 'string' ? delta.type : '';
      const text = typeof delta.text === 'string' ? delta.text : '';
      if (deltaType === 'thinking_delta') {
        return { reasoningDelta: text || undefined };
      }
      return { contentDelta: text || undefined };
    }

    if (eventPayload.type === 'content_block_start') {
      const block = eventPayload.content_block || {};
      const text = typeof block.text === 'string' ? block.text : '';
      return { contentDelta: text || undefined };
    }

    if (eventPayload.type === 'message_delta') {
      const stopReason = eventPayload?.delta?.stop_reason || eventPayload?.stop_reason;
      return { done: Boolean(stopReason) };
    }

    if (eventPayload.type === 'message_stop') {
      return { done: true };
    }
  }

  if (Array.isArray(eventPayload.candidates)) {
    const parts = eventPayload?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const reasoningDelta = parts
        .filter((item: any) => item?.thought === true)
        .map((item: any) => (typeof item?.text === 'string' ? item.text : ''))
        .join('');
      const contentDelta = parts
        .filter((item: any) => !(item?.thought === true))
        .map((item: any) => (typeof item?.text === 'string' ? item.text : ''))
        .join('');
      return {
        contentDelta: contentDelta || undefined,
        reasoningDelta: reasoningDelta || undefined,
        done: Boolean(eventPayload?.candidates?.[0]?.finishReason),
      };
    }
  }

  return {};
};

const toNumber = (value: string, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const inputBaseStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 13,
  outline: 'none',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  transition: 'border-color 0.2s',
};

function ParameterRow(props: {
  title: string;
  valueText?: string;
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const {
    title,
    valueText,
    enabled,
    onToggle,
    disabled,
    children,
  } = props;
  return (
    <div style={{ marginBottom: 12, opacity: enabled ? 1 : 0.55 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {title}
          {valueText && <span style={{ marginLeft: 6, color: 'var(--color-primary)' }}>{valueText}</span>}
        </div>
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={enabled} onChange={onToggle} disabled={disabled} /> 启用
        </label>
      </div>
      {children}
    </div>
  );
}

export default function ModelTester() {
  const [models, setModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [inputs, setInputs] = useState<ModelTesterInputs>(DEFAULT_INPUTS);
  const [parameterEnabled, setParameterEnabled] = useState<ParameterEnabled>(DEFAULT_PARAMETER_ENABLED);

  const [sending, setSending] = useState(false);
  const [loadingModels, setLoadingModels] = useState(true);
  const [error, setError] = useState('');
  const [pendingPayload, setPendingPayload] = useState<TestChatPayload | null>(null);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  const [customRequestMode, setCustomRequestMode] = useState(false);
  const [customRequestBody, setCustomRequestBody] = useState('');
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const debugPanelPresence = useAnimatedVisibility(showDebugPanel, 220);
  const [activeDebugTab, setActiveDebugTab] = useState<DebugTab>(DEBUG_TABS.PREVIEW);
  const [debugRequest, setDebugRequest] = useState('');
  const [debugResponse, setDebugResponse] = useState('');
  const [debugPreview, setDebugPreview] = useState('');
  const [debugTimeline, setDebugTimeline] = useState<DebugTimelineEntry[]>([]);
  const [debugTimestamp, setDebugTimestamp] = useState('');

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const chatEndRef = useRef<HTMLDivElement>(null);
  const restoredSessionRef = useRef<ReturnType<typeof parseModelTesterSession>>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamStopRequestedRef = useRef(false);

  const pushDebug = useCallback((level: DebugTimelineEntry['level'], text: string) => {
    const now = new Date().toISOString();
    setDebugTimeline((prev) => {
      const next = [...prev, { at: now, level, text }];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
    setDebugTimestamp(now);
  }, []);

  const updateInput = useCallback(<K extends keyof ModelTesterInputs>(key: K, value: ModelTesterInputs[K]) => {
    setInputs((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleParameter = useCallback((key: keyof ParameterEnabled) => {
    setParameterEnabled((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  useEffect(() => {
    const restored = parseModelTesterSession(localStorage.getItem(MODEL_TESTER_STORAGE_KEY));
    restoredSessionRef.current = restored;
    if (!restored) return;

    setMessages(restored.messages);
    setInput(restored.input);
    setInputs(restored.inputs);
    setParameterEnabled(restored.parameterEnabled);
    setPendingPayload(restored.pendingPayload);
    setPendingJobId(restored.pendingJobId || null);
    setCustomRequestMode(restored.customRequestMode);
    setCustomRequestBody(restored.customRequestBody);
    setShowDebugPanel(restored.showDebugPanel);
    setActiveDebugTab(restored.activeDebugTab);

    if (restored.pendingJobId) {
      setSending(true);
      setError('发现未完成的任务，正在重新连接...');
      pushDebug('info', `恢复任务 ${restored.pendingJobId}。`);
    } else if (restored.pendingPayload) {
      setError('发现未完成的请求快照，点击重试继续。');
      pushDebug('warn', '恢复待处理的请求快照。');
    }
  }, [pushDebug]);

  useEffect(() => {
    const fetchModels = async () => {
      setLoadingModels(true);
      try {
        const [marketResult, routesResult] = await Promise.allSettled([
          api.getModelsMarketplace({ includePricing: false }),
          api.getRoutes(),
        ]);

        if (marketResult.status === 'rejected' && routesResult.status === 'rejected') {
          throw marketResult.reason || routesResult.reason || new Error('failed to fetch models');
        }

        const names = collectModelTesterModelNames(
          marketResult.status === 'fulfilled' ? marketResult.value : null,
          routesResult.status === 'fulfilled' ? routesResult.value : null,
        );
        setModels(names);

        const restoredModel = restoredSessionRef.current?.inputs.model || '';
        const currentModel = inputs.model || '';
        const nextModel = restoredModel && names.includes(restoredModel)
          ? restoredModel
          : currentModel && names.includes(currentModel)
            ? currentModel
            : names[0] || '';

        if (nextModel) {
          setInputs((prev) => ({ ...prev, model: nextModel }));
        }
      } catch {
        setError('加载模型列表失败。');
        pushDebug('error', '获取模型列表失败。');
      } finally {
        setLoadingModels(false);
      }
    };

    void fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!inputs.model) return;
    localStorage.setItem(MODEL_TESTER_STORAGE_KEY, serializeModelTesterSession({
      input,
      inputs,
      parameterEnabled,
      messages,
      pendingPayload,
      pendingJobId,
      customRequestMode,
      customRequestBody,
      showDebugPanel,
      activeDebugTab,
    }));
  }, [
    activeDebugTab,
    customRequestBody,
    customRequestMode,
    input,
    inputs,
    messages,
    parameterEnabled,
    pendingJobId,
    pendingPayload,
    showDebugPanel,
  ]);

  const previewPayload = useMemo(() => {
    if (customRequestMode) {
      const raw = customRequestBody.trim();
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return { _error: '自定义请求体中的 JSON 无效', raw };
      }
    }
    return buildApiPayload(messages, inputs, parameterEnabled);
  }, [customRequestBody, customRequestMode, inputs, messages, parameterEnabled]);

  useEffect(() => {
    setDebugPreview(formatJson(previewPayload));
  }, [previewPayload]);

  const finalizeJob = useCallback((jobId: string) => {
    void api.deleteTestChatJob(jobId).catch(() => { });
  }, []);

  useEffect(() => {
    if (!pendingJobId) return;

    let active = true;
    setSending(true);

    const pollTask = async () => {
      while (active) {
        try {
          const status = await api.getTestChatJob(pendingJobId) as ChatJobResponse;
          if (!active) return;

          if (status.status === 'pending') {
            await wait(POLL_INTERVAL_MS);
            continue;
          }

          if (status.status === 'succeeded') {
            setMessages((prev) => applyAssistantSuccess(prev, status.result));
            setError('');
            setDebugResponse(formatJson(status.result));
            setActiveDebugTab(DEBUG_TABS.RESPONSE);
            pushDebug('info', `任务 ${pendingJobId} 已成功。`);
          } else if (status.status === 'cancelled') {
            setMessages((prev) => applyAssistantStopped(prev));
            setError('生成已取消。');
            setDebugResponse(formatJson(status.error));
            setActiveDebugTab(DEBUG_TABS.RESPONSE);
            pushDebug('warn', `任务 ${pendingJobId} 已取消。`);
          } else {
            const message = extractErrorMessage(status.error);
            setMessages((prev) => applyAssistantError(prev, message));
            setError(message);
            setDebugResponse(formatJson(status.error));
            setActiveDebugTab(DEBUG_TABS.RESPONSE);
            pushDebug('error', `任务 ${pendingJobId} 失败：${message}`);
          }

          setPendingJobId(null);
          setPendingPayload(null);
          setSending(false);
          finalizeJob(pendingJobId);
          return;
        } catch (pollError) {
          const message = (pollError as any)?.message || '未知轮询错误';
          pushDebug('warn', `轮询 ${pendingJobId} 失败一次：${message}`);
          await wait(POLL_INTERVAL_MS);
        }
      }
    };

    void pollTask();
    return () => {
      active = false;
    };
  }, [finalizeJob, pendingJobId, pushDebug]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const turnCount = useMemo(() => countConversationTurns(messages), [messages]);
  const filteredModels = useMemo(
    () => filterModelTesterModelNames(models, modelSearch),
    [modelSearch, models],
  );
  const currentModelVisible = useMemo(
    () => filteredModels.includes(inputs.model),
    [filteredModels, inputs.model],
  );
  const modelCountText = useMemo(() => {
    if (!modelSearch.trim()) return `共 ${models.length} 个模型`;
    return `匹配 ${filteredModels.length} / ${models.length}`;
  }, [filteredModels.length, modelSearch, models.length]);

  const modelSelectOptions = useMemo(
    () => filteredModels.map((item) => ({ value: item, label: item })),
    [filteredModels],
  );
  const targetFormatOptions = useMemo<Array<{ value: TestTargetFormat; label: string }>>(() => ([
    { value: 'openai', label: 'OpenAI (/v1/chat/completions)' },
    { value: 'responses', label: 'OpenAI Responses (/v1/responses)' },
    { value: 'claude', label: 'Claude (/v1/messages)' },
  ]), []);

  const canSend = useMemo(() => {
    if (sending || pendingJobId || !inputs.model) return false;
    const hasPrompt = input.trim().length > 0;
    if (!customRequestMode) return hasPrompt;
    return hasPrompt || customRequestBody.trim().length > 0;
  }, [customRequestBody, customRequestMode, input, inputs.model, pendingJobId, sending]);

  const startChatJob = useCallback(async (payload: TestChatPayload) => {
    try {
      setError('');
      setPendingPayload(payload);
      const created = await api.startTestChatJob(payload) as { jobId: string };
      setPendingJobId(created.jobId);
      setSending(true);
      pushDebug('info', `已创建任务 ${created.jobId}。`);
    } catch (e: any) {
      const message = e?.message || '请求失败';
      setMessages((prev) => applyAssistantError(prev, message));
      setError(message);
      setSending(false);
      setDebugResponse(formatJson({ error: { message } }));
      setActiveDebugTab(DEBUG_TABS.RESPONSE);
      pushDebug('error', `创建任务失败：${message}`);
    }
  }, [pushDebug]);

  const startStream = useCallback(async (payload: TestChatPayload) => {
    const controller = new AbortController();
    streamAbortRef.current = controller;
    streamStopRequestedRef.current = false;
    setSending(true);
    setPendingJobId(null);
    setPendingPayload(payload);
    pushDebug('info', '已开始流式请求。');

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const rawEvents: string[] = [];
    const appendRawEvent = (raw: string) => {
      rawEvents.push(raw);
      if (rawEvents.length > 500) {
        rawEvents.splice(0, rawEvents.length - 500);
      }
      setDebugResponse(rawEvents.join('\n'));
    };

    try {
      const response = await api.testChatStream(payload, controller.signal);
      if (response.status === 401 || response.status === 403) {
        const hadToken = Boolean(getAuthToken(localStorage));
        clearAuthSession(localStorage);
        if (hadToken) window.location.reload();
        throw new Error('会话已过期');
      }
      if (!response.ok) {
        throw new Error(await parseStreamErrorText(response));
      }
      if (!response.body) {
        throw new Error('流式响应体为空');
      }

      setActiveDebugTab(DEBUG_TABS.RESPONSE);
      const reader = response.body.getReader();
      let doneReceived = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(/\r?\n\r?\n/);
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const parsed = parseSseBlock(chunk);
          if (!parsed.data) continue;
          appendRawEvent(parsed.data);

          if (parsed.data === '[DONE]') {
            doneReceived = true;
            pushDebug('info', '收到流式 [DONE] 信号。');
            continue;
          }

          let eventPayload: any;
          try {
            eventPayload = JSON.parse(parsed.data);
          } catch {
            pushDebug('warn', `忽略非 JSON 的 SSE 数据块 (event=${parsed.event})。`);
            continue;
          }

          if (eventPayload?.error) {
            throw new Error(extractErrorMessage(eventPayload));
          }

          const delta = parseAnyStreamDelta(eventPayload);
          if (delta.reasoningDelta || delta.contentDelta) {
            setMessages((prev) => applyAssistantDelta(prev, {
              reasoningDelta: delta.reasoningDelta,
              contentDelta: delta.contentDelta,
            }));
          }
          if (delta.done) doneReceived = true;
        }
      }

      setMessages((prev) => {
        const idx = findLastLoadingAssistantIndex(prev);
        if (idx === -1) return prev;
        return replaceMessageAt(prev, idx, {
          ...finalizeIncompleteMessage(prev[idx]),
          status: MESSAGE_STATUS.COMPLETE,
          isThinkingComplete: true,
        });
      });

      setPendingPayload(null);
      setError('');
      pushDebug(doneReceived ? 'info' : 'warn', doneReceived
        ? '流式传输已成功完成。'
        : '流式传输未收到 [DONE] 信号，已在本地完成。');
    } catch (streamError: any) {
      const abortedByUser = controller.signal.aborted && streamStopRequestedRef.current;
      const abortedUnexpectedly = controller.signal.aborted
        || streamError?.name === 'AbortError'
        || streamError?.message === 'This operation was aborted'
        || streamError?.message === 'The user aborted a request.';

      if (abortedByUser) {
        setMessages((prev) => applyAssistantStopped(prev));
        setError('生成已停止。');
        pushDebug('warn', '流式传输被用户中止。');
      } else if (abortedUnexpectedly) {
        const message = '流式连接中断，请重试。';
        setMessages((prev) => applyAssistantError(prev, message));
        setError(message);
        pushDebug('error', `流式传输异常中断：${streamError?.message || 'AbortError'}`);
      } else {
        const rawMsg = streamError?.message || '流式请求失败';
        const message = rawMsg === 'This operation was aborted' ? '操作已中止' : rawMsg;
        setMessages((prev) => applyAssistantError(prev, message));
        setError(message);
        pushDebug('error', `流式传输失败：${message}`);
      }
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
      streamStopRequestedRef.current = false;
      setSending(false);
    }
  }, [pushDebug]);

  const dispatchPayload = useCallback(async (
    nextMessages: ChatMessage[],
    payload: TestChatPayload,
    options?: { syncedCustomBody?: string },
  ) => {
    setMessages(nextMessages);
    if (options?.syncedCustomBody !== undefined) {
      setCustomRequestBody(options.syncedCustomBody);
    }
    setError('');
    setPendingPayload(payload);
    setDebugRequest(formatJson(payload));
    setDebugResponse('');
    setActiveDebugTab(DEBUG_TABS.REQUEST);
    setDebugTimestamp(new Date().toISOString());

    if (payload.stream) {
      await startStream(payload);
    } else {
      await startChatJob(payload);
    }
  }, [startChatJob, startStream]);

  const buildPayloadWithMessages = useCallback((nextMessages: ChatMessage[]): {
    payload: TestChatPayload | null;
    syncedCustomBody?: string;
  } => {
    if (!customRequestMode) {
      return { payload: buildApiPayload(nextMessages, inputs, parameterEnabled) };
    }

    const syncedBody = syncMessagesToCustomRequestBody(customRequestBody, nextMessages, inputs);
    const parsed = parseCustomRequestBody(syncedBody);
    return {
      payload: parsed
        ? { ...parsed, targetFormat: parsed.targetFormat || inputs.targetFormat }
        : null,
      syncedCustomBody: syncedBody,
    };
  }, [customRequestBody, customRequestMode, inputs, parameterEnabled]);

  const sendWithPrompt = useCallback(async (prompt: string, baseMessages: ChatMessage[]) => {
    const userMessage = createMessage('user', prompt);
    const loadingAssistant = createLoadingAssistantMessage();
    const nextMessages = [...baseMessages, userMessage, loadingAssistant];
    const { payload, syncedCustomBody } = buildPayloadWithMessages(nextMessages);

    if (!payload) {
      setError('自定义请求体无效或不包含消息。');
      pushDebug('error', '从自定义请求体构建请求失败。');
      return;
    }

    await dispatchPayload(nextMessages, payload, { syncedCustomBody });
  }, [buildPayloadWithMessages, dispatchPayload, pushDebug]);

  const send = useCallback(async () => {
    if (!canSend) return;

    const trimmed = input.trim();
    if (trimmed.length > 0) {
      setInput('');
      await sendWithPrompt(trimmed, messages);
      return;
    }

    if (!customRequestMode) return;
    const payload = parseCustomRequestBody(customRequestBody);
    if (!payload) {
      setError('自定义请求体必须是有效的 JSON 且包含非空消息。');
      pushDebug('error', '发送被阻止：无效的自定义请求体。');
      return;
    }

    const nextMessages = [...messages, createLoadingAssistantMessage()];
    await dispatchPayload(nextMessages, {
      ...payload,
      targetFormat: payload.targetFormat || inputs.targetFormat,
    });
  }, [canSend, customRequestBody, customRequestMode, dispatchPayload, input, inputs.targetFormat, messages, pushDebug, sendWithPrompt]);

  const retryPending = useCallback(async () => {
    if (sending || pendingJobId || !pendingPayload) return;

    const nextMessages = (() => {
      const copied = [...messages];
      const last = copied[copied.length - 1];
      if (last?.role === 'assistant' && (last.status === MESSAGE_STATUS.ERROR || last.status === MESSAGE_STATUS.COMPLETE)) {
        copied.pop();
      }
      copied.push(createLoadingAssistantMessage());
      return copied;
    })();

    pushDebug('info', '正在重试待处理的请求。');
    await dispatchPayload(nextMessages, pendingPayload);
  }, [dispatchPayload, messages, pendingJobId, pendingPayload, pushDebug, sending]);

  const stopGenerating = useCallback(async () => {
    let hadWork = false;

    if (streamAbortRef.current) {
      hadWork = true;
      streamStopRequestedRef.current = true;
      try {
        streamAbortRef.current.abort();
      } catch {
        // no-op
      }
      streamAbortRef.current = null;
    }

    if (pendingJobId) {
      hadWork = true;
      const jobId = pendingJobId;
      setPendingJobId(null);
      try {
        await api.deleteTestChatJob(jobId);
      } catch {
        // no-op
      }
    }

    if (!hadWork) return;
    setSending(false);
    setMessages((prev) => applyAssistantStopped(prev));
    setError('生成已停止。');
    pushDebug('warn', '生成已被用户停止。');
  }, [pendingJobId, pushDebug]);

  const clearChat = useCallback(() => {
    if (pendingJobId) {
      void api.deleteTestChatJob(pendingJobId).catch(() => { });
    }
    if (streamAbortRef.current) {
      streamStopRequestedRef.current = true;
      try {
        streamAbortRef.current.abort();
      } catch {
        // no-op
      }
      streamAbortRef.current = null;
    }

    setMessages([]);
    setPendingPayload(null);
    setPendingJobId(null);
    setInput('');
    setError('');
    setSending(false);
    setEditingMessageId(null);
    setEditValue('');
    setDebugRequest('');
    setDebugResponse('');
    setDebugPreview('');
    setDebugTimeline([]);
    setDebugTimestamp('');
    localStorage.removeItem(MODEL_TESTER_STORAGE_KEY);
    pushDebug('info', '对话已清除。');
  }, [pendingJobId, pushDebug]);

  const toggleReasoning = useCallback((messageId: string) => {
    setMessages((prev) => prev.map((message) => {
      if (message.id !== messageId || message.role !== 'assistant') return message;
      return { ...message, isReasoningExpanded: !message.isReasoningExpanded };
    }));
  }, []);

  const copyMessage = useCallback(async (message: ChatMessage) => {
    const text = [
      message.reasoningContent ? `[reasoning]\n${message.reasoningContent}` : '',
      message.content,
    ].filter(Boolean).join('\n\n').trim();

    if (!text) {
      setError('没有可复制的文本内容。');
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      pushDebug('info', `已复制消息 ${message.id}。`);
    } catch {
      setError('复制失败，请手动复制。');
    }
  }, [pushDebug]);

  const deleteMessage = useCallback((target: ChatMessage) => {
    if (sending) return;
    setMessages((prev) => {
      const index = prev.findIndex((msg) => msg.id === target.id);
      if (index === -1) return prev;
      if (target.role === 'user' && prev[index + 1]?.role === 'assistant') {
        return prev.filter((_, idx) => idx !== index && idx !== index + 1);
      }
      return prev.filter((msg) => msg.id !== target.id);
    });
    setEditingMessageId(null);
    setEditValue('');
    pushDebug('info', `已删除消息 ${target.id}。`);
  }, [pushDebug, sending]);

  const toggleAssistantRole = useCallback((target: ChatMessage) => {
    if (!(target.role === 'assistant' || target.role === 'system')) return;
    if (sending) return;
    setMessages((prev) => prev.map((msg) => {
      if (msg.id !== target.id) return msg;
      return { ...msg, role: msg.role === 'assistant' ? 'system' : 'assistant' };
    }));
  }, [sending]);

  const resetFromMessage = useCallback((target: ChatMessage) => {
    if (sending || pendingJobId) return;
    const index = messages.findIndex((msg) => msg.id === target.id);
    if (index === -1) return;

    let userIndex = -1;
    if (target.role === 'user') {
      userIndex = index;
    } else {
      for (let i = index - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') {
          userIndex = i;
          break;
        }
      }
    }

    if (userIndex === -1) {
      setError('未找到可重试的用户消息。');
      return;
    }

    const base = messages.slice(0, userIndex);
    const prompt = messages[userIndex].content;
    setEditingMessageId(null);
    setEditValue('');
    void sendWithPrompt(prompt, base);
  }, [messages, pendingJobId, sendWithPrompt, sending]);

  const startEditMessage = useCallback((target: ChatMessage) => {
    if (sending) return;
    setEditingMessageId(target.id);
    setEditValue(target.content);
  }, [sending]);

  const cancelEditMessage = useCallback(() => {
    setEditingMessageId(null);
    setEditValue('');
  }, []);

  const saveEditMessage = useCallback((retry = false) => {
    if (!editingMessageId) return;

    const targetIndex = messages.findIndex((message) => message.id === editingMessageId);
    if (targetIndex === -1) {
      cancelEditMessage();
      return;
    }

    const nextContent = editValue;
    const target = messages[targetIndex];
    const updated = messages.map((message, index) => (index === targetIndex
      ? { ...message, content: nextContent }
      : message));

    setMessages(updated);
    setEditingMessageId(null);
    setEditValue('');

    if (retry && target.role === 'user') {
      const base = updated.slice(0, targetIndex);
      void sendWithPrompt(nextContent, base);
    }
  }, [cancelEditMessage, editValue, editingMessageId, messages, sendWithPrompt]);

  const syncMessageToBody = useCallback(() => {
    const nextBody = syncMessagesToCustomRequestBody(customRequestBody, messages, inputs);
    setCustomRequestBody(nextBody);
    pushDebug('info', '已将消息同步到自定义请求体。');
  }, [customRequestBody, inputs, messages, pushDebug]);

  const syncBodyToMessage = useCallback(() => {
    const nextMessages = syncCustomRequestBodyToMessages(customRequestBody);
    if (!nextMessages) {
      setError('自定义请求体中没有有效的消息。');
      return;
    }
    setMessages(nextMessages);
    pushDebug('info', '已将自定义请求体同步到消息。');
  }, [customRequestBody, pushDebug]);

  const formatCustomBody = useCallback(() => {
    try {
      const parsed = JSON.parse(customRequestBody);
      setCustomRequestBody(JSON.stringify(parsed, null, 2));
      setError('');
    } catch (formatError: any) {
      setError(`JSON 解析错误：${formatError?.message || '无效的 JSON'}`);
    }
  }, [customRequestBody]);

  const debugTabContent = useMemo(() => {
    if (activeDebugTab === DEBUG_TABS.PREVIEW) return debugPreview;
    if (activeDebugTab === DEBUG_TABS.REQUEST) return debugRequest;
    return debugResponse;
  }, [activeDebugTab, debugPreview, debugRequest, debugResponse]);

  const layoutColumns = debugPanelPresence.shouldRender
    ? '340px minmax(0, 1fr) 360px'
    : '340px minmax(0, 1fr)';

  if (loadingModels) {
    return (
      <div className="animate-fade-in">
        <div className="skeleton" style={{ width: 200, height: 28, marginBottom: 20 }} />
        <div className="skeleton" style={{ height: 120, marginBottom: 12, borderRadius: 'var(--radius-md)' }} />
        <div className="skeleton" style={{ height: 520, borderRadius: 'var(--radius-md)' }} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h2 className="page-title">{tr('模型测试')}</h2>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
            支持流式输出、任务模式、自定义请求体和调试面板。
          </p>
        </div>
        <div className="page-actions">
          <button
            onClick={() => setShowDebugPanel((prev) => !prev)}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {showDebugPanel ? '隐藏调试' : '显示调试'}
          </button>
          <button
            onClick={() => { void retryPending(); }}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
            disabled={sending || !!pendingJobId || !pendingPayload}
          >
            重试
          </button>
          <button
            onClick={() => { void stopGenerating(); }}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
            disabled={!pendingJobId && !streamAbortRef.current}
          >
            停止
          </button>
          <button
            onClick={clearChat}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
            disabled={messages.length === 0 && !pendingPayload && !pendingJobId}
          >
            清除
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }} className="animate-slide-up stagger-1">
        <div className="stat-summary-card stat-summary-purple">
          <div className="stat-summary-card-label">模型数量</div>
          <div className="stat-summary-card-value">{models.length}</div>
        </div>
        <div className="stat-summary-card stat-summary-blue">
          <div className="stat-summary-card-label">当前模型</div>
          <div className="stat-summary-card-value" style={{ fontSize: 14, wordBreak: 'break-all' }}>{inputs.model || '未选择'}</div>
        </div>
        <div className="stat-summary-card stat-summary-green">
          <div className="stat-summary-card-label">对话轮数</div>
          <div className="stat-summary-card-value">{turnCount}</div>
        </div>
        <div className="stat-summary-card stat-summary-orange">
          <div className="stat-summary-card-label">模式</div>
          <div className="stat-summary-card-value" style={{ fontSize: 14 }}>
            {(customRequestMode ? '自定义请求' : (inputs.stream ? '流式' : '任务模式'))}
            {' / '}
            {inputs.targetFormat === 'claude'
              ? 'Claude'
              : inputs.targetFormat === 'responses'
                ? 'OpenAI Responses'
                : 'OpenAI'}
          </div>
        </div>
      </div>

      <div
        className="animate-slide-up stagger-2"
        style={{
          display: 'grid',
          gridTemplateColumns: layoutColumns,
          gap: 16,
          alignItems: 'stretch',
        }}
      >
        <div className="card" style={{ padding: 16, minHeight: 680, maxHeight: 740, overflowY: 'auto' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>设置</h3>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 600 }}>模型</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder="搜索模型（支持名称片段）"
                style={{
                  ...inputBaseStyle,
                  flex: 1,
                  marginBottom: 0,
                }}
                disabled={models.length === 0}
              />
              <button
                type="button"
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
                onClick={() => setModelSearch('')}
                disabled={!modelSearch}
              >
                清空
              </button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 6 }}>
              {modelCountText}
            </div>
            <ModernSelect
              value={currentModelVisible ? inputs.model : ''}
              onChange={(next) => {
                if (!next) return;
                updateInput('model', next);
              }}
              options={modelSelectOptions}
              placeholder={
                !currentModelVisible && !!inputs.model
                  ? `当前模型已被筛选：${inputs.model}`
                  : (models.length === 0
                    ? '暂无模型'
                    : (filteredModels.length === 0 ? '未找到匹配模型' : '请选择模型'))
              }
              disabled={models.length === 0 || customRequestMode || filteredModels.length === 0}
              emptyLabel="未找到匹配模型"
              menuMaxHeight={300}
            />
            {!currentModelVisible && !!inputs.model && (
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                当前模型已被筛选：{inputs.model}
              </div>
            )}
            {customRequestMode && (
              <div style={{ fontSize: 11, color: 'var(--color-warning)', marginTop: 4 }}>
                自定义请求模式下模型选择将被忽略。
              </div>
            )}
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 600 }}>
              下游协议
            </div>
            <ModernSelect
              value={inputs.targetFormat}
              onChange={(next) => {
                if (!next) return;
                updateInput('targetFormat', next as TestTargetFormat);
              }}
              options={targetFormatOptions}
              placeholder="请选择下游协议"
            />
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              用于模拟不同客户端接入格式（OpenAI / Claude）。
            </div>
          </div>

          <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>流式输出</div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                checked={inputs.stream}
                onChange={(event) => updateInput('stream', event.target.checked)}
                disabled={customRequestMode}
              />
              启用
            </label>
          </div>

          <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>自定义请求体</div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                checked={customRequestMode}
                onChange={(event) => setCustomRequestMode(event.target.checked)}
              />
              启用
            </label>
          </div>

          <div className={`anim-collapse ${customRequestMode ? 'is-open' : ''}`.trim()} style={{ marginBottom: 14 }}>
            <div className="anim-collapse-inner">
              <textarea
                value={customRequestBody}
                onChange={(event) => setCustomRequestBody(event.target.value)}
                rows={11}
                placeholder='{"model":"gpt-4o-mini","targetFormat":"claude","messages":[{"role":"user","content":"hello"}],"stream":true}'
                style={{
                  ...inputBaseStyle,
                  resize: 'vertical',
                  fontFamily: 'var(--font-mono)',
                  lineHeight: 1.5,
                }}
              />
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={formatCustomBody}>
                  格式化 JSON
                </button>
                <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={syncMessageToBody}>
                  消息 -&gt; 请求体
                </button>
                <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={syncBodyToMessage}>
                  请求体 -&gt; 消息
                </button>
              </div>
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8, fontWeight: 600 }}>
            采样参数
          </div>

          <ParameterRow
            title="温度"
            valueText={inputs.temperature.toFixed(2)}
            enabled={parameterEnabled.temperature}
            onToggle={() => toggleParameter('temperature')}
            disabled={customRequestMode}
          >
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={inputs.temperature}
              onChange={(event) => updateInput('temperature', toNumber(event.target.value, inputs.temperature))}
              style={{ width: '100%', accentColor: 'var(--color-primary)' }}
              disabled={!parameterEnabled.temperature || customRequestMode}
            />
          </ParameterRow>

          <ParameterRow
            title="Top P"
            valueText={inputs.top_p.toFixed(2)}
            enabled={parameterEnabled.top_p}
            onToggle={() => toggleParameter('top_p')}
            disabled={customRequestMode}
          >
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={inputs.top_p}
              onChange={(event) => updateInput('top_p', toNumber(event.target.value, inputs.top_p))}
              style={{ width: '100%', accentColor: 'var(--color-primary)' }}
              disabled={!parameterEnabled.top_p || customRequestMode}
            />
          </ParameterRow>

          <ParameterRow
            title="频率惩罚"
            valueText={inputs.frequency_penalty.toFixed(2)}
            enabled={parameterEnabled.frequency_penalty}
            onToggle={() => toggleParameter('frequency_penalty')}
            disabled={customRequestMode}
          >
            <input
              type="range"
              min={-2}
              max={2}
              step={0.1}
              value={inputs.frequency_penalty}
              onChange={(event) => updateInput('frequency_penalty', toNumber(event.target.value, inputs.frequency_penalty))}
              style={{ width: '100%', accentColor: 'var(--color-primary)' }}
              disabled={!parameterEnabled.frequency_penalty || customRequestMode}
            />
          </ParameterRow>

          <ParameterRow
            title="存在惩罚"
            valueText={inputs.presence_penalty.toFixed(2)}
            enabled={parameterEnabled.presence_penalty}
            onToggle={() => toggleParameter('presence_penalty')}
            disabled={customRequestMode}
          >
            <input
              type="range"
              min={-2}
              max={2}
              step={0.1}
              value={inputs.presence_penalty}
              onChange={(event) => updateInput('presence_penalty', toNumber(event.target.value, inputs.presence_penalty))}
              style={{ width: '100%', accentColor: 'var(--color-primary)' }}
              disabled={!parameterEnabled.presence_penalty || customRequestMode}
            />
          </ParameterRow>

          <ParameterRow
            title="最大 Token 数"
            enabled={parameterEnabled.max_tokens}
            onToggle={() => toggleParameter('max_tokens')}
            disabled={customRequestMode}
          >
            <input
              type="number"
              value={inputs.max_tokens}
              min={1}
              step={1}
              onChange={(event) => updateInput('max_tokens', toNumber(event.target.value, inputs.max_tokens))}
              style={inputBaseStyle}
              disabled={!parameterEnabled.max_tokens || customRequestMode}
            />
          </ParameterRow>

          <ParameterRow
            title="随机种子"
            valueText={inputs.seed === null ? '自动' : String(inputs.seed)}
            enabled={parameterEnabled.seed}
            onToggle={() => toggleParameter('seed')}
            disabled={customRequestMode}
          >
            <input
              type="number"
              value={inputs.seed ?? ''}
              min={0}
              step={1}
              placeholder="可选种子值"
              onChange={(event) => {
                const raw = event.target.value.trim();
                updateInput('seed', raw.length === 0 ? null : toNumber(raw, 0));
              }}
              style={inputBaseStyle}
              disabled={!parameterEnabled.seed || customRequestMode}
            />
          </ParameterRow>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden', minHeight: 680, maxHeight: 740, display: 'flex', flexDirection: 'column' }}>
          <div style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--color-border-light)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--color-bg-card)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>对话</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              {sending ? '生成中...' : '就绪'}
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 280, overflowY: 'auto', padding: 18, background: 'var(--color-bg)' }}>
            {messages.length === 0 ? (
              <div className="empty-state" style={{ padding: '40px 0' }}>
                <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 10h.01M12 14h.01M16 10h.01M9 16h6M12 3C7.03 3 3 6.582 3 11c0 2.2 1.003 4.193 2.63 5.64V21l3.376-1.847A10.76 10.76 0 0012 19c4.97 0 9-3.582 9-8s-4.03-8-9-8z" />
                </svg>
                <div className="empty-state-title">开始对话测试</div>
                <div className="empty-state-desc">支持流式模式、自定义请求体模式和可恢复的任务。</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {messages.map((message) => {
                  const isUser = message.role === 'user';
                  const isSystem = message.role === 'system';
                  const isLoading = message.status === MESSAGE_STATUS.LOADING || message.status === MESSAGE_STATUS.INCOMPLETE;
                  const isError = message.status === MESSAGE_STATUS.ERROR;
                  const showReasoning = Boolean(message.reasoningContent);
                  const isEditing = editingMessageId === message.id;

                  return (
                    <div
                      key={message.id}
                      className="animate-fade-in"
                      style={{
                        display: 'flex',
                        gap: 10,
                        flexDirection: isUser ? 'row-reverse' : 'row',
                      }}
                    >
                      <div style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        fontWeight: 700,
                        flexShrink: 0,
                        background: isUser
                          ? 'linear-gradient(135deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 58%, white))'
                          : (isSystem
                            ? 'linear-gradient(135deg, color-mix(in srgb, var(--color-text-secondary) 88%, black), color-mix(in srgb, var(--color-text-muted) 70%, white))'
                            : (isError
                              ? 'linear-gradient(135deg, var(--color-danger), color-mix(in srgb, var(--color-danger) 68%, white))'
                              : 'linear-gradient(135deg, var(--color-success), color-mix(in srgb, var(--color-success) 62%, white))')),
                        color: 'white',
                      }}>
                        {isUser ? 'U' : (isSystem ? 'SYS' : 'AI')}
                      </div>

                      <div style={{ maxWidth: '78%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {showReasoning && (
                          <div style={{
                            border: '1px solid color-mix(in srgb, var(--color-primary) 28%, transparent)',
                            background: 'color-mix(in srgb, var(--color-primary) 9%, var(--color-bg-card))',
                            borderRadius: '10px',
                            overflow: 'hidden',
                          }}>
                            <button
                              onClick={() => toggleReasoning(message.id)}
                              style={{
                                width: '100%',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                border: 'none',
                                background: 'transparent',
                                cursor: 'pointer',
                                padding: '8px 10px',
                                fontSize: 12,
                                fontWeight: 600,
                                color: 'var(--color-primary)',
                              }}
                            >
                              <span>{isLoading ? '思考中...' : '推理过程'}</span>
                              <span>{message.isReasoningExpanded ? '▼' : '▶'}</span>
                            </button>
                            <div className={`anim-collapse ${message.isReasoningExpanded ? 'is-open' : ''}`.trim()}>
                              <div className="anim-collapse-inner">
                                <div style={{
                                  padding: '8px 10px',
                                  borderTop: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
                                  fontSize: 12,
                                  lineHeight: 1.7,
                                  whiteSpace: 'pre-wrap',
                                  color: 'var(--color-text-secondary)',
                                }}>
                                  {message.reasoningContent}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}

                        <div style={{
                          padding: '10px 12px',
                          borderRadius: isUser ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                          background: isUser ? 'var(--color-primary)' : (isError ? 'var(--color-danger-soft)' : 'var(--color-bg-card)'),
                          color: isUser ? 'white' : 'var(--color-text-primary)',
                          border: isUser ? 'none' : (isError ? '1px solid color-mix(in srgb, var(--color-danger) 32%, transparent)' : '1px solid var(--color-border-light)'),
                          fontSize: 13,
                          lineHeight: 1.65,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          boxShadow: 'var(--shadow-sm)',
                          minHeight: 24,
                        }}>
                          {isEditing ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <textarea
                                value={editValue}
                                onChange={(event) => setEditValue(event.target.value)}
                                rows={3}
                                style={{ ...inputBaseStyle, resize: 'vertical', background: 'var(--color-bg-card)', color: 'var(--color-text-primary)' }}
                              />
                              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                {message.role === 'user' && (
                                  <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => saveEditMessage(true)}>
                                    保存并重试
                                  </button>
                                )}
                                <button className="btn btn-primary" onClick={() => saveEditMessage(false)}>保存</button>
                                <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={cancelEditMessage}>取消</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {isLoading && <span className="spinner spinner-sm" style={{ marginRight: 6, verticalAlign: 'middle' }} />}
                              {message.content || (isLoading ? '思考中...' : '')}
                            </>
                          )}
                        </div>

                        {!isEditing && (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {!isLoading && (
                              <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '4px 8px', fontSize: 11 }} onClick={() => resetFromMessage(message)} disabled={sending || Boolean(pendingJobId)}>
                                重试
                              </button>
                            )}
                            <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '4px 8px', fontSize: 11 }} onClick={() => { void copyMessage(message); }}>
                              复制
                            </button>
                            {!isLoading && (
                              <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '4px 8px', fontSize: 11 }} onClick={() => startEditMessage(message)} disabled={sending}>
                                编辑
                              </button>
                            )}
                            {!isLoading && (
                              <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '4px 8px', fontSize: 11 }} onClick={() => deleteMessage(message)} disabled={sending}>
                                删除
                              </button>
                            )}
                            {(message.role === 'assistant' || message.role === 'system') && !isLoading && (
                              <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '4px 8px', fontSize: 11 }} onClick={() => toggleAssistantRole(message)} disabled={sending}>
                                {message.role === 'assistant' ? '转为系统' : '转为助手'}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={chatEndRef} />
              </div>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--color-border-light)', padding: 14, background: 'var(--color-bg-card)' }}>
            {error && (
              <div className="alert alert-error animate-scale-in" style={{ marginBottom: 10 }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={customRequestMode
                  ? '自定义模式下输入可选。回车发送提示词并同步到自定义请求体。'
                  : '输入提示词...（回车发送，Shift+回车换行）'}
                rows={3}
                style={{ ...inputBaseStyle, resize: 'none', flex: 1 }}
              />
              <button
                onClick={() => { void send(); }}
                disabled={!canSend}
                className="btn btn-primary"
                style={{
                  height: 78,
                  padding: '0 20px',
                  fontSize: 14,
                  fontWeight: 600,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  minWidth: 88,
                }}
              >
                {sending ? (
                  <>
                    <span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />
                    <span style={{ fontSize: 11 }}>发送中</span>
                  </>
                ) : (
                  <>
                    <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                    <span style={{ fontSize: 11 }}>发送</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {debugPanelPresence.shouldRender && (
          <div className={`card panel-presence ${debugPanelPresence.isVisible ? '' : 'is-closing'}`.trim()} style={{ padding: 14, minHeight: 680, maxHeight: 740, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>调试</h3>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                {debugTimestamp ? new Date(debugTimestamp).toLocaleString() : '--'}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button
                className="btn btn-ghost"
                style={{
                  border: activeDebugTab === DEBUG_TABS.PREVIEW ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                  color: activeDebugTab === DEBUG_TABS.PREVIEW ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                }}
                onClick={() => setActiveDebugTab(DEBUG_TABS.PREVIEW)}
              >
                预览
              </button>
              <button
                className="btn btn-ghost"
                style={{
                  border: activeDebugTab === DEBUG_TABS.REQUEST ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                  color: activeDebugTab === DEBUG_TABS.REQUEST ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                }}
                onClick={() => setActiveDebugTab(DEBUG_TABS.REQUEST)}
              >
                请求
              </button>
              <button
                className="btn btn-ghost"
                style={{
                  border: activeDebugTab === DEBUG_TABS.RESPONSE ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                  color: activeDebugTab === DEBUG_TABS.RESPONSE ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                }}
                onClick={() => setActiveDebugTab(DEBUG_TABS.RESPONSE)}
              >
                响应
              </button>
            </div>

            <div style={{ flex: 1, overflow: 'hidden', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)' }}>
              <pre style={{
                margin: 0,
                padding: 12,
                fontSize: 12,
                lineHeight: 1.55,
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflow: 'auto',
                maxHeight: '100%',
              }}>
                {debugTabContent || '// 暂无数据'}
              </pre>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, fontWeight: 600 }}>时间线</div>
            <div style={{
              marginTop: 6,
              border: '1px solid var(--color-border-light)',
              borderRadius: 'var(--radius-sm)',
              padding: 8,
              minHeight: 120,
              maxHeight: 170,
              overflowY: 'auto',
              background: 'var(--color-bg)',
            }}>
              {debugTimeline.length === 0 ? (
                <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>暂无事件。</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {debugTimeline.map((item, index) => (
                    <div key={`${item.at}-${index}`} style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
                      <span style={{
                        display: 'inline-block',
                        minWidth: 40,
                        marginRight: 6,
                        color: item.level === 'error' ? 'var(--color-danger)' : item.level === 'warn' ? 'var(--color-warning)' : 'var(--color-primary)',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                      }}>
                        {item.level}
                      </span>
                      <span style={{ color: 'var(--color-text-muted)', marginRight: 6 }}>
                        {new Date(item.at).toLocaleTimeString()}
                      </span>
                      <span>{item.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
