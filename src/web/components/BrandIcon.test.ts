import { describe, expect, it } from 'vitest';
import { getBrand } from './BrandIcon.js';

describe('getBrand', () => {
  it('detects simple prefixed model names', () => {
    expect(getBrand('claude-opus-4-6')?.name).toBe('Anthropic');
    expect(getBrand('gpt-4o-mini')?.name).toBe('OpenAI');
  });

  it('detects brand for regex and wrapped model patterns', () => {
    expect(getBrand('re:^claude-(opus|sonnet)-4-5$')?.name).toBe('Anthropic');
    expect(getBrand('[Summer] gpt-5.2-codex')?.name).toBe('OpenAI');
  });

  it('detects brand from namespaced model paths', () => {
    expect(getBrand('openrouter/anthropic/claude-3-7-sonnet')?.name).toBe('Anthropic');
    expect(getBrand('openrouter/google/gemini-2.5-pro')?.name).toBe('Google');
  });

  it('detects issue #38 existing-brand additions', () => {
    expect(getBrand('google/shieldgemma-9b')).toMatchObject({ name: 'Google', icon: expect.any(String) });
    expect(getBrand('PaLM-2')).toMatchObject({ name: 'Google', icon: expect.any(String) });
    expect(getBrand('imagen3-fast')).toMatchObject({ name: 'Google', icon: expect.any(String) });
    expect(getBrand('veo3-pro')).toMatchObject({ name: 'Google', icon: expect.any(String) });
    expect(getBrand('davinci-002')).toMatchObject({ name: 'OpenAI', icon: expect.any(String) });
    expect(getBrand('babbage-002')).toMatchObject({ name: 'OpenAI', icon: expect.any(String) });
    expect(getBrand('codex-mini-2025-05-16')).toMatchObject({ name: 'OpenAI', icon: expect.any(String) });
    expect(getBrand('ds-chat')).toMatchObject({ name: 'DeepSeek', icon: expect.any(String) });
    expect(getBrand('tongyi-deepresearch-30b-a3b')).toMatchObject({ name: '通义千问', icon: expect.any(String) });
    expect(getBrand('microsoft/kosmos-2')).toMatchObject({ name: 'Microsoft', icon: expect.any(String) });
    expect(getBrand('phi4')).toMatchObject({ name: 'Microsoft', icon: expect.any(String) });
    expect(getBrand('stablediffusion3.5-l')).toMatchObject({ name: 'Stability', icon: expect.any(String) });
    expect(getBrand('sd3-medium')).toMatchObject({ name: 'Stability', icon: expect.any(String) });
    expect(getBrand('tencent-hunyuanvideo-hd')).toMatchObject({ name: '腾讯混元', icon: expect.any(String) });
    expect(getBrand('mini2.1')).toMatchObject({ name: 'MiniMax', icon: expect.any(String) });
    expect(getBrand('stepfun-ai/step3')).toMatchObject({ name: '阶跃星辰', icon: expect.any(String) });
  });

  it('detects issue #38 newly added brands with registered icons', () => {
    expect(getBrand('nvidia/vila')).toMatchObject({ name: 'NVIDIA', icon: expect.any(String) });
    expect(getBrand('ibm/granite-3.3-8b-instruct')).toMatchObject({ name: 'IBM', icon: expect.any(String) });
    expect(getBrand('BAAI/bge-m3')).toMatchObject({ name: 'BAAI', icon: expect.any(String) });
    expect(getBrand('bytedance/seed-oss-36b-instruct')).toMatchObject({ name: 'ByteDance', icon: expect.any(String) });
    expect(getBrand('internlm/internlm2_5-7b-chat')).toMatchObject({ name: 'InternLM', icon: expect.any(String) });
    expect(getBrand('mj_turbo')).toMatchObject({ name: 'Midjourney', icon: expect.any(String) });
    expect(getBrand('deepl-zh-en')).toMatchObject({ name: 'DeepL', icon: expect.any(String) });
    expect(getBrand('jina-embeddings-v3')).toMatchObject({ name: 'Jina AI', icon: expect.any(String) });
  });

  it('returns null for unknown model names', () => {
    expect(getBrand('totally-unknown-model')).toBeNull();
  });

  it('does not misclassify GPTQ llama variants as OpenAI', () => {
    expect(getBrand('TheBloke/Llama-2-7B-GPTQ')?.name).toBe('Meta');
  });
});
