import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FallbackClient, OpenAICompatible } from '../scripts/lib/llm.mjs';
import { QuotaExhausted } from '../scripts/lib/gemini.mjs';

const okBody = (content) => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });

test('Gemini가 한도 소진이면 OpenRouter로 넘어가고, 이후에는 바로 대체 모델 사용', async () => {
  const orig = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url, opt) => {
    hits.push(String(url));
    return okBody('```json\n{"events":[{"title":"마코토 픽업"}]}\n```');
  };
  let geminiCalls = 0;
  const gemini = { calls: 0, notes: [], model: 'g', structured: async () => { geminiCalls++; throw new QuotaExhausted('없음'); } };
  const or = new OpenAICompatible({ name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', models: ['m:free'], minIntervalMs: 0 });
  try {
    const c = new FallbackClient(gemini, [or]);
    assert.deepEqual(await c.structured('p', { type: 'OBJECT' }), { events: [{ title: '마코토 픽업' }] });
    await c.structured('p2', { type: 'OBJECT' });
    assert.equal(geminiCalls, 1); // 두 번째부터는 Gemini를 건너뜀
    assert.equal(hits.filter((h) => h.endsWith('/chat/completions')).length, 2);
    assert.match(c.model, /openrouter:m:free/);
  } finally { globalThis.fetch = orig; }
});

test('대체 모델: 모델 없음(404)이면 다음 모델, 긴 프롬프트는 잘라서 보냄', async () => {
  const orig = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opt) => {
    const b = JSON.parse(opt.body);
    sent.push(b);
    if (b.model === 'gone') return { status: 404, text: async () => 'not found' };
    return okBody('{"events":[]}');
  };
  try {
    const groq = new OpenAICompatible({ name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k', models: ['gone', 'gpt-oss'], maxPromptChars: 100, minIntervalMs: 0 });
    assert.deepEqual(await groq.structured('가'.repeat(500), {}), { events: [] });
    assert.equal(sent[1].model, 'gpt-oss');
    assert.ok(sent[1].messages[1].content.length < 130);
  } finally { globalThis.fetch = orig; }
});

test('OpenRouter 무료 모델 선택: 검증된 대형 모델 우선, 소형·비전 제외', async () => {
  const { rankOpenRouterFree } = await import('../scripts/lib/llm.mjs');
  const ids = rankOpenRouterFree([
    { id: 'particle-ai/particle-1:free', context_length: 1000000 },
    { id: 'liquid/lfm-3-1.7b:free', context_length: 128000 },
    { id: 'nvidia/nemotron-3.5-super-vl:free', context_length: 256000 },
    { id: 'deepseek/deepseek-v3.2:free', context_length: 128000 },
    { id: 'openai/gpt-oss-120b:free', context_length: 128000 },
    { id: 'meta-llama/llama-3.1-8b-instruct:free', context_length: 128000 },
    { id: 'paid/model', context_length: 1000000 },
  ]);
  assert.deepEqual(ids, ['openai/gpt-oss-120b:free', 'deepseek/deepseek-v3.2:free', 'particle-ai/particle-1:free']);
});

test('JSON 검증 실패(400)면 같은 모델로 검증 없이 재시도, 로그의 계정 식별자는 가림', async () => {
  const orig = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opt) => {
    const b = JSON.parse(opt.body);
    sent.push(b);
    if (b.response_format) return { status: 400, text: async () => '{"error":{"message":"Failed to validate JSON in organization `org_01abcdef123456`"}}' };
    return okBody('결과: {"events":[{"title":"x"}],}');
  };
  try {
    const p = new OpenAICompatible({ name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k', models: ['gpt-oss'], minIntervalMs: 0 });
    assert.deepEqual(await p.structured('p', {}), { events: [{ title: 'x' }] });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].model, 'gpt-oss');
    assert.ok(!sent[1].response_format);
    assert.ok(p.notes.every((n) => !n.includes('org_01abcdef123456')));
  } finally { globalThis.fetch = orig; }
});
