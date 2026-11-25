// Gemini가 응답하지 않을 때 쓰는 무료 대체 모델 (OpenAI 호환 API, 2026-11 시험 완료)
//  - OpenRouter ':free' 모델: OPENROUTER_API_KEY (카드 불필요, 하루 50회·분당 20회)
//  - Groq: GROQ_API_KEY (카드 불필요, gpt-oss-120b 기준 분당 8K 토큰·하루 200K 토큰 → 요청을 짧게 자름)
// 순서: Gemini → Groq → OpenRouter. 키가 없는 제공자는 건너뜀.
import { extractJson } from './gemini.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 공개 로그에 계정 식별자가 남지 않도록
const redact = (t) => String(t).replace(/\b(org|user|proj|key)_[A-Za-z0-9]{6,}\b/g, '$1_***');

export class OpenAICompatible {
  constructor({ name, baseUrl, apiKey, models = [], discover, maxPromptChars = 60000, minIntervalMs = 4000, timeoutMs = 90000, maxTries = 4, headers = {} }) {
    this.maxTries = maxTries;
    this.name = name;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.models = models;
    this.discover = discover; // (모델 목록 JSON) → 선호 순서대로 정렬한 모델 id
    this.maxPromptChars = maxPromptChars;
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;
    this.headers = headers;
    this.lastCall = 0;
    this.calls = 0;
    this.notes = [];
    this.discovered = false;
    this.dead = false;
  }

  get model() { return this.models[0] || 'none'; }

  async #discover() {
    if (this.discovered || !this.discover) return;
    this.discovered = true;
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: { authorization: `Bearer ${this.apiKey}`, ...this.headers }, signal: AbortSignal.timeout(15000) });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const found = this.discover(await res.json());
      if (found.length) this.models = [...new Set([...this.models.filter((m) => found.includes(m)), ...found])].slice(0, 8);
      this.notes.push(`${this.name} 후보: ${this.models.join(', ')}`);
    } catch (e) {
      this.notes.push(`${this.name} 모델 목록 조회 실패: ${e.message}`);
    }
  }

  /** 프롬프트 → JSON 객체 (스키마는 프롬프트에 설명으로 포함) */
  async structured(prompt, schema) {
    await this.#discover();
    let text = prompt;
    if (text.length > this.maxPromptChars) text = text.slice(0, this.maxPromptChars) + '\n…(자료 일부 생략)';
    const body = (model, strict = true) => JSON.stringify({
      model,
      temperature: 0,
      ...(strict ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: `반드시 다음 JSON 스키마를 따르는 JSON 객체 하나만 출력하세요. 설명 문장은 쓰지 마세요.\n${JSON.stringify(schema)}` },
        { role: 'user', content: text },
      ],
    });
    for (let attempt = 0; attempt < Math.min(this.maxTries, this.models.length * 2) && this.models.length; attempt++) {
      const wait = this.lastCall + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();
      this.calls++;
      const model = this.model;
      const strict = !this.lenient?.has(model);
      let res, raw;
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, ...this.headers },
          body: body(model, strict),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        raw = await res.text();
      } catch (e) {
        this.notes.push(`${this.name}/${model}: ${e.name === 'TimeoutError' ? '응답 지연' : e.message}`);
        this.models.push(this.models.shift());
        continue;
      }
      if (res.status === 200) {
        let j;
        try { j = JSON.parse(raw); } catch { j = {}; }
        const content = j.choices?.[0]?.message?.content || '';
        const out = extractJson(content);
        if (out) return out;
        this.notes.push(`${this.name}/${model}: JSON 해석 실패`);
        this.models.push(this.models.shift());
        continue;
      }
      this.notes.push(`${this.name}/${model}: HTTP ${res.status} ${redact(raw).slice(0, 120)}`);
      // 엄격한 JSON 검증 실패 → 같은 모델로 검증 없이 한 번 더 (우리 쪽에서 JSON 정리)
      if (res.status === 400 && /validate JSON|json_validate|failed_generation/i.test(raw) && strict) { (this.lenient ||= new Set()).add(model); continue; }
      if (res.status === 401 || res.status === 403) { this.dead = true; break; } // 키 문제
      if (res.status === 429) { await sleep(20000); }
      this.models.push(this.models.shift()); // 404(모델 없음)·413(너무 김)·429·5xx → 다음 모델
    }
    throw new Error(`${this.name}: 사용 가능한 모델이 응답하지 않음`);
  }
}

const STRONG = [/gpt-oss-120b/, /deepseek/, /qwen3?.*(235b|480b|max|coder|next|-plus)/, /qwen/, /llama-(3\.3|4)/, /glm-[45]/, /kimi/, /gemma-[34]/, /mistral-(medium|large|small)/, /hermes/, /gpt-oss/];
export function rankOpenRouterFree(models) {
  const score = (id) => { const i = STRONG.findIndex((r) => r.test(id)); return i < 0 ? 99 : i; };
  return models
    .filter((m) => /:free$/.test(m.id) && (m.context_length || 0) >= 32000)
    .filter((m) => !/(vision|-vl\b|-vl:|image|audio|embed|guard|\b(0\.\d|1|1\.\d|2|3|4|7|8|9)b\b)/i.test(m.id))
    .sort((a, b) => score(a.id) - score(b.id) || (b.context_length || 0) - (a.context_length || 0))
    .map((m) => m.id);
}

/** 환경 변수에 키가 있는 대체 제공자 목록 */
export function fallbackProviders(env = process.env) {
  const out = [];
  const only = (env.FALLBACK_PROVIDERS || '').split(',').filter(Boolean); // 테스트용: 특정 제공자만
  if (env.OPENROUTER_API_KEY) {
    out.push(new OpenAICompatible({
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY,
      headers: { 'x-title': 'subcul-pickup-calendar' },
      models: (env.OPENROUTER_MODELS || 'openai/gpt-oss-120b:free,deepseek/deepseek-chat-v3.1:free,qwen/qwen3-235b-a22b:free').split(','),
      // ':free' 모델 중 검증된 대형 모델 계열을 우선, 소형(≤9B)·비전 전용 모델은 제외
      discover: (j) => rankOpenRouterFree(j.data || []),
      maxPromptChars: 40000,
      minIntervalMs: 4000,
      timeoutMs: 60000,
      maxTries: 3,
    }));
  }
  if (env.GROQ_API_KEY) {
    out.push(new OpenAICompatible({
      name: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: env.GROQ_API_KEY,
      models: (env.GROQ_MODELS || 'openai/gpt-oss-120b,openai/gpt-oss-20b').split(','),
      // 계정에서 실제 쓸 수 있는 텍스트 모델을 조회 (문서상 대체 모델이 없는 경우가 있음)
      discover: (j) => (j.data || []).filter((m) => m.active !== false && !/(whisper|tts|guard|vision|orpheus|prompt-guard|compound)/i.test(m.id)).sort((a, b) => (/gpt-oss-120b/.test(b.id) - /gpt-oss-120b/.test(a.id)) || (/gpt-oss/.test(b.id) - /gpt-oss/.test(a.id)) || (b.context_window || 0) - (a.context_window || 0)).map((m) => m.id),
      maxPromptChars: 5500, // 분당 8K 토큰 한도: 한국어는 글자당 토큰이 많아 넉넉히 줄임
      maxTries: 3,
      minIntervalMs: 65000, // 분당 토큰 한도 회복 대기
    }));
  }
  // 2026-11 시험 결과: Groq는 10개 게임 모두 안정적으로 성공, OpenRouter 무료 모델은 혼잡(429)이 잦아 4/10 → Groq 우선
  const order = { groq: 0, openrouter: 1 };
  out.sort((a, b) => order[a.name] - order[b.name]);
  return only.length ? out.filter((p) => only.includes(p.name)) : out;
}

/**
 * Gemini를 먼저 쓰고, 실패하면 대체 제공자로 넘어가는 클라이언트.
 * collect.mjs가 쓰는 인터페이스(structured, searchGrounded, calls, notes, model, lastSuccess, discoverModels)를 그대로 제공.
 */
export class FallbackClient {
  constructor(primary, fallbacks = []) {
    this.primary = primary;
    this.fallbacks = fallbacks;
    this.primaryDown = process.env.DISABLE_GEMINI === '1'; // Gemini가 연속 실패하면 이번 실행에서는 대체 모델부터 사용 (테스트: DISABLE_GEMINI=1)
    this.primaryFails = 0;
    this.used = new Set();
  }
  get model() { return [...this.used].join('+') || this.primary.model; }
  get calls() { return this.primary.calls + this.fallbacks.reduce((a, f) => a + f.calls, 0); }
  get notes() { return [...this.primary.notes, ...this.fallbacks.flatMap((f) => f.notes)]; }
  get lastSuccess() { return this.primary.lastSuccess; }
  discoverModels() { return this.primary.discoverModels(); }
  searchGrounded(prompt) { return this.primary.searchGrounded(prompt); }

  async structured(prompt, schema) {
    let lastErr;
    if (!this.primaryDown) {
      try {
        const out = await this.primary.structured(prompt, schema);
        this.used.add(`gemini:${this.primary.model}`);
        this.primaryFails = 0;
        return out;
      } catch (e) {
        lastErr = e;
        if (e.constructor?.name === 'TimeBudgetExceeded') throw e;
        this.primaryFails++;
        if (e.constructor?.name === 'QuotaExhausted' || this.primaryFails >= 2) this.primaryDown = true;
        if (!this.fallbacks.length) throw e;
      }
    }
    for (const f of this.fallbacks) {
      if (f.dead) continue;
      try {
        const out = await f.structured(prompt, schema);
        this.used.add(`${f.name}:${f.model}`);
        return out;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('사용 가능한 모델이 없습니다');
  }
}
