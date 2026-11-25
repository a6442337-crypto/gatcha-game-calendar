// 진단: 이 API 키로 쓸 수 있는 모델과 무료 한도를 확인 (모델당 최대 2회 호출)
// 사용법: GEMINI_API_KEY=... node scripts/diagnose.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { listModels, rankFlashModels } from './lib/gemini.mjs';

const key = process.env.GEMINI_API_KEY;
if (!key) { console.log('::error::GEMINI_API_KEY 없음'); process.exit(1); }
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const note = (level, title, msg) => console.log(process.env.GITHUB_ACTIONS ? `::${level} title=${title}::${String(msg).replace(/\n/g, ' ').slice(0, 900)}` : `[${title}] ${msg}`);

async function call(model, grounded) {
  const body = { contents: [{ role: 'user', parts: [{ text: grounded ? '오늘 원신 관련 최신 소식 한 줄' : 'ok 라고만 답해' }] }] };
  if (grounded) body.tools = [{ google_search: {} }];
  const res = await fetch(`${BASE}/models/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  const v = (json.error?.details || []).flatMap((d) => d.violations || []).map((x) => `${x.quotaId}${x.quotaValue !== undefined ? ` 한도=${x.quotaValue}` : ''}`).join(', ');
  return { status: res.status, info: res.status === 200 ? 'OK' : `${v || ''} ${(json.error?.message || '').slice(0, 160)}`.trim() };
}

const report = { at: new Date().toISOString(), models: [], tests: [] };
try {
  const names = await listModels(key);
  report.models = names;
  note('notice', '사용 가능 모델', names.filter((n) => n.startsWith('gemini')).join(', '));
} catch (e) { note('error', '모델 목록 실패', e.message); }

const ranked = rankFlashModels(report.models);
// 일반 모델 상위 4개 + lite 모델 전부 (lite 모델의 Google 검색 무료 여부 확인)
const candidates = [...ranked.filter((m) => !/lite/.test(m)).slice(0, 4), ...ranked.filter((m) => /lite/.test(m))].slice(0, 8);
for (const m of candidates) {
  const plain = await call(m, false);
  await new Promise((r) => setTimeout(r, 4000));
  const grounded = plain.status === 200 ? await call(m, true) : { status: '-', info: '일반 호출 실패로 생략' };
  await new Promise((r) => setTimeout(r, 4000));
  report.tests.push({ model: m, plain, grounded });
  note(plain.status === 200 && grounded.status === 200 ? 'notice' : 'warning', `진단 ${m}`, `일반=${plain.status} ${plain.info} | 검색=${grounded.status} ${grounded.info}`);
}
await mkdir(new URL('../data/logs/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/logs/diagnose.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');

// ---- GitHub Models (Actions 기본 토큰으로 사용 가능한지 확인) ----
if (process.env.GITHUB_TOKEN) {
  const gh = { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' };
  report.githubModels = { catalog: null, tests: [] };
  try {
    const res = await fetch('https://models.github.ai/catalog/models', { headers: gh });
    const body = await res.text();
    let list = [];
    try { list = JSON.parse(body); } catch {}
    report.githubModels.catalog = { status: res.status, count: Array.isArray(list) ? list.length : 0 };
    const ids = Array.isArray(list) ? list.map((m) => `${m.id}${m.rate_limit_tier ? `(${m.rate_limit_tier})` : ''}`) : [];
    note(res.status === 200 ? 'notice' : 'warning', 'GitHub Models 카탈로그', `HTTP ${res.status} · ${ids.join(', ').slice(0, 800) || body.slice(0, 300)}`);
    const want = ['openai/gpt-4.1-mini', 'openai/gpt-4o-mini', 'openai/gpt-4.1', 'meta/llama-3.3-70b-instruct', 'mistral-ai/mistral-medium-2505', 'deepseek/deepseek-v3-0324'];
    const pick = Array.isArray(list) && list.length ? want.filter((w) => list.some((m) => m.id === w)).concat(list.map((m) => m.id).filter((id) => !want.includes(id)).slice(0, 2)).slice(0, 5) : want.slice(0, 2);
    for (const model of pick) {
      const r = await fetch('https://models.github.ai/inference/chat/completions', {
        method: 'POST', headers: gh,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '원신의 주인공 쌍둥이 이름을 한국어로 한 줄로.' }], max_tokens: 50 }),
      });
      const t = await r.text();
      const limits = ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens'].map((h) => `${h.replace('x-ratelimit-', '')}=${r.headers.get(h)}`).join(' ');
      let msg = t.slice(0, 200);
      try { const j = JSON.parse(t); msg = j.choices?.[0]?.message?.content?.slice(0, 80) || j.error?.message?.slice(0, 200) || msg; } catch {}
      report.githubModels.tests.push({ model, status: r.status, msg, limits });
      note(r.status === 200 ? 'notice' : 'warning', `GitHub Models ${model}`, `HTTP ${r.status} · ${msg} · ${limits}`);
      await new Promise((ok) => setTimeout(ok, 4000));
    }
  } catch (e) { note('warning', 'GitHub Models', e.message); }
  await writeFile(new URL('../data/logs/diagnose.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
}
