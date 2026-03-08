import React, { useEffect, useState, type CSSProperties } from 'react';

const BRAND_ICON_VERSION = '1.83.0';
const ICON_CDN = `https://registry.npmmirror.com/@lobehub/icons-static-png/${BRAND_ICON_VERSION}/files/dark`;
const ICON_CDN_LIGHT = `https://registry.npmmirror.com/@lobehub/icons-static-png/${BRAND_ICON_VERSION}/files/light`;

const LEGACY_ICON_ALIASES: Record<string, string> = {
  'anthropic': 'claude-color',
  'claude.color': 'claude-color',
  'cohere.color': 'cohere-color',
  'doubao.color': 'doubao-color',
  'gemini.color': 'gemini-color',
  'hunyuan.color': 'hunyuan-color',
  'meta': 'meta-color',
  'meta-brand-color': 'meta-color',
  'minimax.color': 'minimax-color',
  'qwen.color': 'qwen-color',
  'spark.color': 'spark-color',
  'stability': 'stability-color',
  'stability-brand-color': 'stability-color',
  'stepfun': 'stepfun-color',
  'wenxin.color': 'wenxin-color',
  'xai': 'xai',
  'yi.color': 'yi-color',
  'zhipu.color': 'zhipu-color',
  'azure': 'microsoft-color',
  'bytedance-brand-color': 'bytedance-color',
};

export function useIconCdn() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.getAttribute('data-theme') === 'dark';
  });
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.getAttribute('data-theme') === 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return isDark ? ICON_CDN : ICON_CDN_LIGHT;
}

export interface BrandMatchContext {
  raw: string;
  cleaned: string;
  segments: string[];
}

interface InternalBrandMatchContext extends BrandMatchContext {
  candidates: string[];
}

export interface BrandInfo {
  name: string;
  icon: string;
  color: string;
}

type BrandDefinition = BrandInfo & {
  match: (context: InternalBrandMatchContext) => boolean;
};

function normalizeInput(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function stripCommonWrappers(value: string): string {
  return value
    .replace(/^(?:\[[^\]]+\]|【[^】]+】)\s*/g, '')
    .replace(/^re:\s*/g, '')
    .replace(/^\^+/, '')
    .replace(/\$+$/, '')
    .trim();
}

function collectBrandCandidates(modelName: string): string[] {
  const queue: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const normalized = normalizeInput(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    queue.push(normalized);
  };

  push(modelName);

  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index]!;
    const cleaned = stripCommonWrappers(candidate);
    push(cleaned);

    if (cleaned.includes('/')) {
      for (const part of cleaned.split('/')) push(part);
    }
    if (cleaned.includes(':')) {
      for (const part of cleaned.split(':')) push(part);
    }
    if (cleaned.includes(',')) {
      for (const part of cleaned.split(',')) push(part);
    }
  }

  return queue;
}

function buildMatchContext(modelName: string): InternalBrandMatchContext {
  const candidates = collectBrandCandidates(modelName);
  const raw = candidates[0] || normalizeInput(modelName);
  const cleaned = stripCommonWrappers(raw);
  const segments = Array.from(new Set(
    candidates
      .flatMap((candidate) => candidate.split(/[/:,\s]+/g))
      .map((segment) => segment.trim())
      .filter(Boolean),
  ));

  return {
    raw,
    cleaned,
    segments,
    candidates,
  };
}

function includesAny(context: InternalBrandMatchContext, needles: string[]): boolean {
  return needles.some((needle) => (
    context.raw.includes(needle)
    || context.cleaned.includes(needle)
    || context.candidates.some((candidate) => candidate.includes(needle))
  ));
}

function startsWithAny(context: InternalBrandMatchContext, needles: string[]): boolean {
  return needles.some((needle) => (
    context.raw.startsWith(needle)
    || context.cleaned.startsWith(needle)
    || context.segments.some((segment) => segment.startsWith(needle))
    || context.candidates.some((candidate) => candidate.startsWith(needle))
  ));
}

function hasExactSegment(context: InternalBrandMatchContext, needles: string[]): boolean {
  return needles.some((needle) => context.segments.includes(needle));
}

function matchesBoundary(context: InternalBrandMatchContext, pattern: RegExp): boolean {
  return pattern.test(context.raw) || pattern.test(context.cleaned) || context.candidates.some((candidate) => pattern.test(candidate));
}

const BRAND_DEFINITIONS: BrandDefinition[] = [
  {
    name: 'OpenAI',
    icon: 'openai',
    color: 'linear-gradient(135deg, #10a37f, #1a7f5a)',
    match: (context) => (
      startsWithAny(context, ['gpt', 'chatgpt', 'dall-e', 'whisper', 'text-embedding', 'text-moderation', 'davinci', 'babbage', 'codex-mini'])
      || startsWithAny(context, ['o1', 'o3', 'o4', 'tts'])
    ),
  },
  {
    name: 'Anthropic',
    icon: 'claude-color',
    color: 'linear-gradient(135deg, #d4a574, #c4956a)',
    match: (context) => includesAny(context, ['claude']),
  },
  {
    name: 'Google',
    icon: 'gemini-color',
    color: 'linear-gradient(135deg, #4285f4, #34a853)',
    match: (context) => (
      includesAny(context, ['gemini', 'gemma', 'google/', 'palm', 'paligemma', 'shieldgemma', 'recurrentgemma', 'deplot', 'codegemma', 'imagen', 'learnlm', 'aqa'])
      || startsWithAny(context, ['veo', 'google/'])
    ),
  },
  {
    name: 'DeepSeek',
    icon: 'deepseek-color',
    color: 'linear-gradient(135deg, #4d6bfe, #44a3ec)',
    match: (context) => includesAny(context, ['deepseek']) || hasExactSegment(context, ['ds-chat']),
  },
  {
    name: '通义千问',
    icon: 'qwen-color',
    color: 'linear-gradient(135deg, #615cf7, #9b8afb)',
    match: (context) => includesAny(context, ['qwen', 'qwq', 'tongyi']),
  },
  {
    name: '智谱 AI',
    icon: 'zhipu-color',
    color: 'linear-gradient(135deg, #3b6cf5, #6366f1)',
    match: (context) => includesAny(context, ['glm', 'chatglm', 'codegeex', 'cogview', 'cogvideo']),
  },
  {
    name: 'Meta',
    icon: 'meta-color',
    color: 'linear-gradient(135deg, #0668E1, #1877f2)',
    match: (context) => includesAny(context, ['llama', 'code-llama', 'codellama']),
  },
  {
    name: 'Mistral',
    icon: 'mistral-color',
    color: 'linear-gradient(135deg, #f7d046, #f2a900)',
    match: (context) => includesAny(context, ['mistral', 'mixtral', 'codestral', 'pixtral', 'ministral', 'voxtral', 'magistral']),
  },
  {
    name: 'Moonshot',
    icon: 'moonshot',
    color: 'linear-gradient(135deg, #000000, #333333)',
    match: (context) => includesAny(context, ['moonshot', 'kimi']),
  },
  {
    name: '零一万物',
    icon: 'yi-color',
    color: 'linear-gradient(135deg, #1d4ed8, #3b82f6)',
    match: (context) => (
      startsWithAny(context, ['yi-'])
      || matchesBoundary(context, /(^|[/:_\-\s])yi(?=$|[/:_\-\s])/)
    ),
  },
  {
    name: '文心一言',
    icon: 'wenxin-color',
    color: 'linear-gradient(135deg, #2932e1, #4468f2)',
    match: (context) => includesAny(context, ['ernie', 'eb-']),
  },
  {
    name: '讯飞星火',
    icon: 'spark-color',
    color: 'linear-gradient(135deg, #0070f3, #00d4ff)',
    match: (context) => includesAny(context, ['spark', 'generalv']),
  },
  {
    name: '腾讯混元',
    icon: 'hunyuan-color',
    color: 'linear-gradient(135deg, #00b7ff, #0052d9)',
    match: (context) => includesAny(context, ['hunyuan', 'tencent-hunyuan']),
  },
  {
    name: '豆包',
    icon: 'doubao-color',
    color: 'linear-gradient(135deg, #3b5bdb, #7048e8)',
    match: (context) => includesAny(context, ['doubao']),
  },
  {
    name: 'MiniMax',
    icon: 'minimax-color',
    color: 'linear-gradient(135deg, #6366f1, #818cf8)',
    match: (context) => includesAny(context, ['minimax', 'abab']) || hasExactSegment(context, ['mini2.1']),
  },
  {
    name: 'Cohere',
    icon: 'cohere-color',
    color: 'linear-gradient(135deg, #39594d, #5ba77f)',
    match: (context) => includesAny(context, ['command', 'c4ai-']) || startsWithAny(context, ['embed-']),
  },
  {
    name: 'Microsoft',
    icon: 'microsoft-color',
    color: 'linear-gradient(135deg, #00bcf2, #0078d4)',
    match: (context) => (
      includesAny(context, ['microsoft/', 'phi-', 'kosmos'])
      || hasExactSegment(context, ['phi4'])
    ),
  },
  {
    name: 'xAI',
    icon: 'xai',
    color: 'linear-gradient(135deg, #111, #444)',
    match: (context) => includesAny(context, ['grok']),
  },
  {
    name: '阶跃星辰',
    icon: 'stepfun-color',
    color: 'linear-gradient(135deg, #0066ff, #3399ff)',
    match: (context) => includesAny(context, ['stepfun']) || startsWithAny(context, ['step-', 'step3']),
  },
  {
    name: 'Stability',
    icon: 'stability-color',
    color: 'linear-gradient(135deg, #8b5cf6, #a855f7)',
    match: (context) => includesAny(context, ['flux', 'stablediffusion', 'stable-diffusion', 'sdxl']) || startsWithAny(context, ['sd3']),
  },
  {
    name: 'NVIDIA',
    icon: 'nvidia-color',
    color: 'linear-gradient(135deg, #76b900, #4a8c0b)',
    match: (context) => (
      includesAny(context, ['nvidia/', 'nvclip', 'nemotron', 'nemoretriever', 'neva', 'riva-translate', 'cosmos'])
      || startsWithAny(context, ['nv-'])
    ),
  },
  {
    name: 'IBM',
    icon: 'ibm',
    color: 'linear-gradient(135deg, #0f62fe, #4589ff)',
    match: (context) => includesAny(context, ['ibm/', 'granite']),
  },
  {
    name: 'BAAI',
    icon: 'baai',
    color: 'linear-gradient(135deg, #111827, #374151)',
    match: (context) => includesAny(context, ['baai/', 'bge-']),
  },
  {
    name: 'ByteDance',
    icon: 'bytedance-color',
    color: 'linear-gradient(135deg, #325ab4, #0f66ff)',
    match: (context) => includesAny(context, ['bytedance', 'seed-oss', 'kolors', 'kwai', 'kwaipilot']) || startsWithAny(context, ['wan-', 'kat-']),
  },
  {
    name: 'InternLM',
    icon: 'internlm-color',
    color: 'linear-gradient(135deg, #1b3882, #4063c5)',
    match: (context) => includesAny(context, ['internlm']),
  },
  {
    name: 'Midjourney',
    icon: 'midjourney',
    color: 'linear-gradient(135deg, #4c6ef5, #748ffc)',
    match: (context) => includesAny(context, ['midjourney']) || startsWithAny(context, ['mj_']),
  },
  {
    name: 'DeepL',
    icon: 'deepl-color',
    color: 'linear-gradient(135deg, #0f2b46, #21476f)',
    match: (context) => startsWithAny(context, ['deepl-']) || includesAny(context, ['deepl/']),
  },
  {
    name: 'Jina AI',
    icon: 'jina',
    color: 'linear-gradient(135deg, #111827, #4b5563)',
    match: (context) => includesAny(context, ['jina']),
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BRAND_FALLBACK_BOUNDARY_RULES = BRAND_DEFINITIONS.map((brand) => ({
  brand,
  boundaryRegex: new RegExp(`(^|[^a-z0-9])${escapeRegExp(brand.name.toLowerCase())}(?=$|[^a-z0-9])`),
}));

export function normalizeBrandIconKey(icon: string | null | undefined): string | null {
  const normalized = normalizeInput(icon).replace(/\./g, '-');
  if (!normalized) return null;
  return LEGACY_ICON_ALIASES[normalized] || normalized;
}

export function getBrandIconUrl(icon: string | null | undefined, cdn: string): string | null {
  const normalized = normalizeBrandIconKey(icon);
  if (!normalized) return null;
  return `${cdn}/${normalized}.png`;
}

export function getBrand(modelName: string): BrandInfo | null {
  const context = buildMatchContext(modelName);

  for (const definition of BRAND_DEFINITIONS) {
    if (definition.match(context)) {
      return {
        name: definition.name,
        icon: definition.icon,
        color: definition.color,
      };
    }
  }

  for (const candidate of context.candidates) {
    for (const rule of BRAND_FALLBACK_BOUNDARY_RULES) {
      if (rule.boundaryRegex.test(candidate)) {
        return {
          name: rule.brand.name,
          icon: rule.brand.icon,
          color: rule.brand.color,
        };
      }
    }
  }

  return null;
}

const FALLBACK_COLORS = [
  'linear-gradient(135deg, #4f46e5, #818cf8)',
  'linear-gradient(135deg, #059669, #34d399)',
  'linear-gradient(135deg, #2563eb, #60a5fa)',
  'linear-gradient(135deg, #d946ef, #f0abfc)',
  'linear-gradient(135deg, #ea580c, #fb923c)',
  'linear-gradient(135deg, #0891b2, #22d3ee)',
  'linear-gradient(135deg, #7c3aed, #a78bfa)',
  'linear-gradient(135deg, #dc2626, #f87171)',
];

export function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

function avatarLetters(name: string): string {
  const parts = name.replace(/[-_/.]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

type BrandGlyphProps = {
  brand?: Pick<BrandInfo, 'name' | 'icon'> | null;
  model?: string | null;
  icon?: string | null;
  alt?: string;
  size?: number;
  fallbackText?: string | null;
  style?: CSSProperties;
};

export function BrandGlyph({ brand, model, icon, alt, size = 16, fallbackText, style }: BrandGlyphProps) {
  const cdn = useIconCdn();
  const resolvedBrand = brand || (model ? getBrand(model) : null);
  const resolvedIcon = normalizeBrandIconKey(icon || resolvedBrand?.icon || null);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [resolvedIcon]);

  if (resolvedIcon && !imgError) {
    const src = getBrandIconUrl(resolvedIcon, cdn);
    if (src) {
      return (
        <img
          src={src}
          alt={alt || resolvedBrand?.name || model || 'brand'}
          style={{
            width: size,
            height: size,
            objectFit: 'contain',
            flexShrink: 0,
            verticalAlign: 'middle',
            ...style,
          }}
          onError={() => setImgError(true)}
          loading="lazy"
        />
      );
    }
  }

  const fallback = (fallbackText ?? resolvedBrand?.name ?? model ?? '').trim();
  if (!fallback) return null;

  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, Math.round(size * 0.33)),
        background: hashColor(fallback),
        color: 'white',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(9, Math.round(size * 0.5)),
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
        overflow: 'hidden',
        ...style,
      }}
    >
      {avatarLetters(fallback)}
    </span>
  );
}

export function BrandIcon({ model, size = 44 }: { model: string; size?: number }) {
  const brand = getBrand(model);

  if (brand) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: 'transparent',
      }}
      >
        <BrandGlyph brand={brand} size={size} fallbackText={brand.name} />
      </div>
    );
  }

  return (
    <div className="model-card-avatar" style={{ width: size, height: size, background: hashColor(model), fontSize: size > 32 ? 16 : 10 }}>
      {avatarLetters(model)}
    </div>
  );
}

export function InlineBrandIcon({ model, size = 16 }: { model: string; size?: number }) {
  const brand = getBrand(model);
  if (!brand) return null;
  return <BrandGlyph brand={brand} size={size} fallbackText={brand.name} />;
}

export function ModelBadge({ model, style }: { model: string; style?: CSSProperties }) {
  const brand = getBrand(model);

  const badgeColors: Record<string, { bg: string; border: string; text: string }> = {
    OpenAI: { bg: 'rgba(16,163,127,0.08)', border: 'rgba(16,163,127,0.2)', text: '#0d9668' },
    Anthropic: { bg: 'rgba(212,165,116,0.1)', border: 'rgba(212,165,116,0.25)', text: '#9a6e3a' },
    Google: { bg: 'rgba(66,133,244,0.08)', border: 'rgba(66,133,244,0.2)', text: '#2563eb' },
    DeepSeek: { bg: 'rgba(77,108,254,0.08)', border: 'rgba(77,108,254,0.2)', text: '#4d6bfe' },
    'Jina AI': { bg: 'rgba(17,24,39,0.08)', border: 'rgba(17,24,39,0.16)', text: '#111827' },
    Microsoft: { bg: 'rgba(0,164,239,0.08)', border: 'rgba(0,164,239,0.18)', text: '#0f62fe' },
    NVIDIA: { bg: 'rgba(118,185,0,0.10)', border: 'rgba(118,185,0,0.18)', text: '#4a8c0b' },
    xAI: { bg: 'rgba(0,0,0,0.06)', border: 'rgba(0,0,0,0.12)', text: '#333' },
  };

  const brandName = brand?.name || '';
  const colors = badgeColors[brandName] || {
    bg: 'var(--color-primary-light)',
    border: 'rgba(79,70,229,0.15)',
    text: 'var(--color-primary)',
  };

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '2px 10px 2px 6px',
      borderRadius: 6,
      fontSize: 12,
      fontWeight: 500,
      background: colors.bg,
      color: colors.text,
      border: `1px solid ${colors.border}`,
      whiteSpace: 'nowrap',
      ...style,
    }}
    >
      <InlineBrandIcon model={model} size={14} />
      {model}
    </span>
  );
}
