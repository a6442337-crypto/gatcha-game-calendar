// Gemini API 최소 클라이언트 (의존성 없음, Node 20+ 내장 fetch 사용)
// - 무료 등급의 "Google 검색 그라운딩"으로 실제 구글 검색 결과를 기반으로 답변을 받습니다.
// - 무료 한도(429) 처리:
//     · 분당 한도 → 서버가 알려준 시간만큼 기다렸다가 재시도
//     · 하루 한도 → 재시도하지 않고 다음 모델로 전환 (모델마다 한도가 따로 있음)
//     · 모든 모델 소진 → QuotaExhausted 로 수집을 멈추고 그때까지의 결과만 저장
// - 모델이 지원 종료되면(404) 다음 모델로 전환합니다.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

export class QuotaExhausted extends Error {}

function describe429(json) {
  const err = json?.error || {};
  const details = err.details || [];
  const violations = details.flatMap((d) => d.violations || []);
  const quotaInfo = violations.map((v) => [v.quotaId, v.quotaValue !== undefined ? `한도=${v.quotaValue}` : ''].filter(Boolean).join(' ')).join(', ');
  const quotaIds = violations.map((v) => `${v.quotaId || ''} ${v.quotaMetric || ''}`).join(' ');
  const retry = details.find((d) => d.retryDelay)?.retryDelay; // 예: "34s"
  const retryMs = retry ? Math.ceil(parseFloat(retry) * 1000) : null;
  const text = `${quotaIds} ${err.message || ''}`;
  const daily = /PerDay|per day|daily/i.test(text);
  const zero = violations.some((v) => String(v.quotaValue) === '0') || /limit: 0\b/.test(err.message || '');
  return { daily, zero, retryMs, quotaInfo, summary: `${quotaInfo || '한도 정보 없음'} — ${(err.message || '').slice(0, 200)}` };
}

export class Gemini {
  constructor({ apiKey, model, lastGood, minIntervalMs = 13000 }) {
    if (!apiKey) throw new Error('GEMINI_API_KEY 가 설정되지 않았습니다.');
    this.apiKey = apiKey;
    this.preferred = [model, lastGood].filter(Boolean); // 지정 모델 > 지난번에 성공한 모델
    this.models = [...new Set([...this.preferred, ...DEFAULT_MODELS])];
    this.lastSuccess = null;
    this.minIntervalMs = minIntervalMs; // 무료 등급 분당 요청 제한(RPM) 회피용 간격
    this.lastCall = 0;
    this.calls = 0;
    this.notes = []; // 실행 로그에 남길 모델 전환·한도 기록
  }

  get model() { return this.models[0] || 'none'; }

  /** 이 API 키로 실제 사용 가능한 모델을 조회해 후보 목록을 갱신 (지원 종료 모델 자동 제외) */
  async discoverModels() {
    try {
      const names = await listModels(this.apiKey);
      const avail = new Set(names);
      const preferred = this.preferred.filter((m) => avail.has(m));
      const discovered = rankFlashModels(names).filter((m) => !preferred.includes(m));
      if (preferred.length || discovered.length) this.models = [...preferred, ...discovered];
      this.notes.push(`후보 모델: ${this.models.join(', ')}`);
    } catch (e) {
      this.notes.push(`모델 목록 조회 실패: ${e.message}`);
    }
    return this.models;
  }

  #dropModel(reason) {
    const m = this.models.shift();
    this.notes.push(`${m}: ${reason}`);
    console.warn(`[gemini] ${m} 사용 중단 (${reason}) → ${this.models[0] || '남은 모델 없음'}`);
    if (!this.models.length) throw new QuotaExhausted(`사용 가능한 모델이 없습니다. 마지막 사유: ${reason}`);
  }

  async #request(path, body) {
    const wait = this.lastCall + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
    this.calls++;
    let res;
    for (let i = 0; ; i++) {
      try {
        res = await fetch(`${BASE}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });
        break;
      } catch (e) {
        if (i >= 2) throw new Error(`Gemini 접속 실패: ${e.cause?.code || e.message}`);
        await sleep(5000 * (i + 1)); // 일시적인 네트워크 오류(fetch failed) 재시도
      }
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  }

  async generate(body) {
    let minuteRetries = 0;
    let serverRetries = 0;
    for (;;) {
      const { status, json } = await this.#request(`models/${this.model}:generateContent`, body);
      if (status === 200) { this.lastSuccess = this.model; return json; }

      if (status === 429) {
        const q = describe429(json);
        if (q.daily || q.zero || minuteRetries >= 2) {
          this.#dropModel(q.zero ? `무료 한도 0(이 모델/기능은 무료 미지원) — ${q.summary}` : q.daily ? `하루 한도 소진 — ${q.summary}` : `한도 초과 반복 — ${q.summary}`);
          minuteRetries = 0;
          continue;
        }
        minuteRetries++;
        const delay = Math.min(90000, (q.retryMs || 30000) + 2000);
        console.warn(`[gemini] 분당 한도 → ${Math.round(delay / 1000)}s 대기`);
        await sleep(delay);
        continue;
      }
      if (status === 404 || (status === 400 && /model/i.test(JSON.stringify(json).slice(0, 2000)) && !/schema|tool/i.test(JSON.stringify(json).slice(0, 2000)))) {
        this.#dropModel(`모델 사용 불가(${status})`);
        continue;
      }
      if (status >= 500) {
        // 503(접속 폭주) 등: 잠깐 기다렸다 재시도, 반복되면 이 모델을 목록 뒤로 보내고 다른 모델 사용
        serverRetries++;
        if (serverRetries > this.models.length * 2) throw new Error(`Gemini 서버 오류 ${status} 반복: ${JSON.stringify(json).slice(0, 300)}`);
        if (serverRetries % 2 === 0 && this.models.length > 1) {
          this.notes.push(`${this.model}: ${status} 반복 → 다른 모델 우선`);
          this.models.push(this.models.shift());
        } else {
          await sleep(15000);
        }
        continue;
      }
      throw new Error(`Gemini API 오류 ${status} (${this.model}): ${JSON.stringify(json).slice(0, 500)}`);
    }
  }

  /** 구글 검색 그라운딩으로 조사. 텍스트와 출처 목록 반환 */
  async searchGrounded(prompt) {
    const json = await this.generate({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2 },
    });
    const cand = json.candidates?.[0] || {};
    const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
    const chunks = cand.groundingMetadata?.groundingChunks || [];
    const sources = chunks
      .map((c) => c.web)
      .filter(Boolean)
      .map((w) => ({ title: w.title || '', url: w.uri }));
    return { text, sources };
  }

  /** 응답을 JSON 스키마에 맞춰 구조화 (검색 결과 텍스트에서 JSON을 못 뽑았을 때만 사용) */
  async structured(prompt, schema) {
    const json = await this.generate({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
    });
    const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return JSON.parse(text);
  }
}

export async function listModels(apiKey) {
  const out = [];
  let token = '';
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/models?pageSize=1000${token ? `&pageToken=${token}` : ''}`, { headers: { 'x-goog-api-key': apiKey } });
    const json = await res.json();
    if (res.status !== 200) throw new Error(`models.list ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    for (const m of json.models || []) if ((m.supportedGenerationMethods || []).includes('generateContent')) out.push(m.name.replace(/^models\//, ''));
    token = json.nextPageToken;
    if (!token) break;
  }
  return out;
}

/** flash 계열만 골라 최신·정식 버전 우선으로 정렬 (lite는 뒤로) */
export function rankFlashModels(names) {
  const ver = (n) => (/latest/.test(n) ? 0.5 : parseFloat((n.match(/gemini-([\d.]+)/) || [])[1] || '0'));
  return names
    .filter((n) => /^gemini-.*flash/.test(n) && !/(image|tts|live|audio|embedding|thinking|exp|computer|native)/.test(n))
    .sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || ver(b) - ver(a) || (/preview/.test(a) - /preview/.test(b)) || a.localeCompare(b));
}

/** 모델 답변 텍스트에서 JSON 객체를 찾아 파싱 (```json 블록 또는 첫 { ~ 마지막 }) */
export function extractJson(text) {
  if (!text) return null;
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (block) candidates.push(block[1]);
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* 다음 후보 */ }
    try { return JSON.parse(c.replace(/,\s*([}\]])/g, '$1')); } catch { /* 끝의 쉼표 제거 후 재시도 */ }
  }
  return null;
}

/** 그라운딩 출처는 vertexaisearch 리다이렉트 주소이므로 실제 주소로 풀어줍니다. */
export async function resolveRedirect(url) {
  if (!/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect/.test(url)) return url;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return res.headers.get('location') || url;
  } catch {
    return url;
  }
}
