import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gemini, extractJson, QuotaExhausted } from '../scripts/lib/gemini.mjs';

const ok = (text) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text }] } }] } });
const quota = (quotaId, retryDelay) => ({
  status: 429,
  body: { error: { code: 429, message: 'You exceeded your current quota', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
    ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
  ] } },
});

function withFetch(responses, fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url).match(/models\/([^:]+)/)?.[1]);
    const r = responses.shift();
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return fn(calls).finally(() => { globalThis.fetch = orig; });
}

test('하루 한도 → 재시도 없이 다음 모델로 전환', () =>
  withFetch([quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), ok('hi')], async (calls) => {
    const g = new Gemini({ apiKey: 'k', minIntervalMs: 0 });
    const r = await g.searchGrounded('q');
    assert.equal(r.text, 'hi');
    assert.deepEqual(calls, ['gemini-flash-latest', 'gemini-flash-lite-latest']);
    assert.equal(g.notes.length, 1);
  }));

test('분당 한도 → retryDelay 만큼 기다린 뒤 같은 모델로 재시도', () =>
  withFetch([quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '0.01s'), ok('hi')], async (calls) => {
    const g = new Gemini({ apiKey: 'k', minIntervalMs: 0 });
    // 테스트 시간 단축: 대기 상한 내 2초 + 0.01초
    const r = await g.searchGrounded('q');
    assert.equal(r.text, 'hi');
    assert.deepEqual(calls, ['gemini-flash-latest', 'gemini-flash-latest']);
  }));

test('모든 모델의 하루 한도 소진 → QuotaExhausted', () =>
  withFetch(Array.from({ length: 4 }, () => quota('PerDay')), async () => {
    const g = new Gemini({ apiKey: 'k', minIntervalMs: 0 });
    await assert.rejects(() => g.searchGrounded('q'), QuotaExhausted);
  }));

test('extractJson: 코드 블록 / 앞뒤 설명 / 끝 쉼표', () => {
  assert.deepEqual(extractJson('설명\n```json\n{"events":[{"a":1}]}\n```\n끝'), { events: [{ a: 1 }] });
  assert.deepEqual(extractJson('결과: {"events":[{"a":1},]} 입니다'), { events: [{ a: 1 }] });
  assert.equal(extractJson('json 없음'), null);
});
