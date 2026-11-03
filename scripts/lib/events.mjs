// 일정 정규화 · 검증 · 중복 병합 로직 (순수 함수 → 테스트 가능)
import { createHash } from 'node:crypto';

export const TYPES = ['banner', 'event', 'update', 'maintenance', 'livestream', 'other'];
export const BASES = ['official', 'community', 'futuresight', 'datamine', 'rumor'];
// 주년·페스 등 큰 이벤트 판별 (AI 판단 보조)
// 큰 이벤트의 하위 이벤트(교환 코드·출석·무료 지급 등)는 큰 이벤트로 보지 않음
export const MINOR_RE = /(교환\s*코드|쿠폰|출석|무료|지급|미션|보상|챌린지|퀘스트|교환|사전\s*등록|굿즈|팝업\s*스토어|오프라인|부스|설문|공모전|정보\s*사이트|기념\s*방송|특별\s*방송)/;
export const MAJOR_RE = /(\d+\s*주년|하프\s*애니|반주년|anniversary|周年|페스(?!티벌\s*기원)|페스티벌|fes\b|ふぇす|콜라보|collab|발푸르기스)/i;
const DAY = 86400000;

/** 'YYYY-MM-DD' 또는 'YYYY-MM-DDTHH:mm(:ss)' (+offset 선택)을 Date로. offset이 없으면 서버 기본 offset 적용 */
export function parseDate(value, defaultOffset) {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { date: new Date(`${v}T00:00:00${defaultOffset}`), allDay: true };
  m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  let off = m[5] || defaultOffset;
  if (/^[+-]\d{4}$/.test(off)) off = `${off.slice(0, 3)}:${off.slice(3)}`;
  const d = new Date(`${m[1]}T${m[2]}${m[3] || ':00'}${off}`);
  return Number.isNaN(d.getTime()) ? null : { date: d, allDay: false };
}

const normTitle = (t) =>
  String(t || '')
    .toLowerCase()
    .replace(/[\s\-_:·・「」『』\[\]()（）<>《》"'"'!?.,~]/g, '');

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}

export function similarity(a, b) {
  const A = bigrams(normTitle(a));
  const B = bigrams(normTitle(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function hostOf(url) {
  try { const u = new URL(url); return (u.hostname.replace(/^www\./, '') + u.pathname).toLowerCase(); } catch { return ''; }
}

export function isOfficial(url, officialDomains = []) {
  const h = hostOf(url);
  if (!h) return false;
  const host = h.split('/')[0];
  return officialDomains.some((d) => {
    const dd = d.toLowerCase();
    if (dd.includes('/')) return h === dd || h.startsWith(dd + '/'); // 예: x.com/GenshinImpact
    return host === dd || host.endsWith('.' + dd);
  });
}

/** LLM이 뽑은 원시 일정 → 정규화된 일정. 유효하지 않으면 { error } 반환 */
export function normalize(raw, game, server, now = new Date()) {
  const title = String(raw.title || '').trim();
  if (!title) return { error: '제목 없음' };
  const type = TYPES.includes(raw.type) ? raw.type : 'other';
  const s = parseDate(raw.start, server.utcOffset);
  if (!s) return { error: `시작일 해석 불가: ${raw.start}` };
  let e = parseDate(raw.end, server.utcOffset);
  if (e && e.date < s.date) e = null;
  let end = e?.date || null;
  if (end && e.allDay) end = new Date(end.getTime() + DAY); // 종일 일정의 종료일은 다음날 0시(배타적)
  const lastMoment = end || new Date(s.date.getTime() + DAY);
  if (lastMoment < new Date(now.getTime() - 30 * DAY)) return { error: '이미 지난 일정' };
  if (s.date > new Date(now.getTime() + 365 * DAY)) return { error: '1년 이후 일정(신뢰 불가)' };

  // 유출·테스트 서버·찌라시는 다루지 않음 / 미래시는 미래시가 있는 게임(game.futuresight)만
  if (raw.isRumor || raw.basis === 'datamine' || raw.basis === 'rumor') return { error: '유출·찌라시 제외' };
  if (raw.basis === 'futuresight' && !game.futuresight) return { error: '미래시 대상 게임 아님' };
  const sources = (raw.sources || [])
    .filter((x) => x && /^https?:\/\//.test(x.url || ''))
    .map((x) => ({ title: String(x.title || '').slice(0, 200), url: x.url }));
  const official = sources.some((x) => isOfficial(x.url, game.officialDomains));
  const trusted = sources.some((x) => isOfficial(x.url, game.trustedDomains || []));
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
  // 근거 종류: official(공식) / community(기사·커뮤니티) / futuresight(미래시) / datamine(테스트 서버·유출)
  let basis = BASES.includes(raw.basis) ? raw.basis : official ? 'official' : 'community';
  if (raw.isRumor && !['futuresight', 'datamine'].includes(basis)) basis = 'rumor';
  // 확정 조건: 공식 출처 / 신뢰 사이트 + 신뢰도 0.8 이상 / 신뢰도 0.85 이상 + 서로 다른 사이트 2곳 이상
  const domains = new Set(sources.map((x) => { try { return new URL(x.url).hostname.replace(/^www\./, ''); } catch { return x.url; } }));
  let status = 'unverified';
  if (basis === 'futuresight' || basis === 'datamine' || basis === 'rumor') status = 'predicted';
  else if (official || (trusted && confidence >= 0.8) || (confidence >= 0.85 && domains.size >= 2)) status = 'confirmed';
  // 큰 이벤트는 이벤트·업데이트 성격일 때만 (주년 픽업·주년 방송은 일반 픽업/방송으로 취급)
  // 큰 이벤트: 제목에 주년·페스·콜라보 등이 명시된 이벤트·업데이트만 (AI 판단만으로는 지정하지 않음)
  const major = (type === 'event' || type === 'update' || type === 'other') && MAJOR_RE.test(title) && !MINOR_RE.test(title);

  return {
    event: {
      game: game.id,
      server: server.id,
      type,
      title: title.slice(0, 200),
      description: String(raw.description || '').trim().slice(0, 1000),
      start: s.date.toISOString(),
      end: end ? end.toISOString() : null,
      allDay: s.allDay && (!e || e.allDay),
      confidence,
      status,
      basis,
      major,
      rerun: type === 'banner' && (Boolean(raw.isRerun) || /복각|재픽업|rerun/i.test(title)),
      sources,
      ...(raw.community ? { community: raw.community } : {}),
    },
  };
}

export function makeId(ev) {
  const key = `${ev.game}|${ev.server}|${ev.type}|${ev.start.slice(0, 10)}|${normTitle(ev.title)}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/** 같은 일정인지 판단: 같은 게임/서버/종류 + 시작일 ±1일 + 제목 유사 */
const GENERIC = new Set(['픽업', '모집', '전용', '장비', '음동', '모듈', '튜닝', '획득', '보상', '패키지', '코스튬', '특수', '이벤트기원', '배너', '확률', '상승', '스카우트', '선택', '기원', '버전', '이벤트', '워프', '독점', '채널', '튜닝', '가챠', '헤드헌팅', '추출', '복각', '한정', '신규', '업데이트', '기간', '제1기', '제2기', '1기', '2기', '전반', '후반', '하반기', '상반기', '묶음', '광추', '무기', '캐릭터', '오퍼레이터', '에이전트', '공명자', '학생', '인격', '예정', '유출', '베타', '테섭', '미래시', '다음', '이번', '확정', '정보', '일정', '시작', '종료', '안내', '공지', '기념', '스킨', '의상', '수영복', '드레스', '불', '물', '번개', '바람', '얼음', '바위', '풀', '원소', '불꽃', '전기', '에테르', '물리', '빙결', '양자', '허수', '화염', '얼음', '원신', '스타레일', '붕괴', '젠레스', '존', '제로', '블루', '아카이브', '블아', '니케', '승리의', '여신', '우마무스메', '명일방주', '엔드필드', '명조', '림버스', '컴퍼니', '한섭', '일섭', '중섭', '글섭']);
const ONE = new Set(['및', '외', '등', '편', '신', '더', '전', '후', '기', '차', '의', '새', '첫', '각', '총', '약', '중', '탄', '부', '막', '장', '화', '판', '팀', '쪽']);
/** 픽업 제목에서 캐릭터 이름 후보 추출 (「배너 이름」, [말머리], 속성명, 게임명 제외) */
export function nameTokens(title) {
  const t = tokensOf(String(title || '').replace(/「[^」]*」|『[^』]*』|\[[^\]]*\]|【[^】]*】/g, ' '));
  // 괄호를 빼면 이름이 하나도 안 남는 경우(예: '이벤트 헤드헌팅 [지향 헤드헌팅]')는 괄호 안 내용으로
  return t.size ? t : tokensOf(String(title || '').replace(/[「」『』\[\]【】]/g, ' '));
}
function tokensOf(text) {
  return new Set(
    text
      .replace(/\(([^)]*)\)/g, ' $1 ')
      .replace(/\s*:\s*/g, ':') // '마리안 : 퀸' 같은 이름은 하나로
      .split(/[\s·•,、/&+|\-~'"‘’“”!?()]+/)
      .map((t) => t.split(':').filter((x) => x && !GENERIC.has(x)).join(':'))
      .map((t) => t.replace(/(의|과|와|및|이|가|을|를|은|는)$/, (m, _x, i, str) => (str.length > 2 ? '' : m)))
      .filter((t) => (t.length >= 2 || (/^[가-힣]$/.test(t) && !ONE.has(t))) && !GENERIC.has(t) && !/^\d|^[a-z]$/i.test(t) && /[가-힣a-z]/i.test(t))
  );
}

// ---- 이름 표기 차이 흡수 (미탸·미타·미티아 → 같은 이름) ----
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
function syllables(word) {
  return [...word].map((ch) => {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c < 0 || c > 11171) return { raw: ch };
    return { cho: Math.floor(c / 588), jung: Math.floor((c % 588) / 28), jong: c % 28 };
  });
}
/** 이름을 자모열로 정규화: '티아'→'탸'처럼 ㅣ+아/어/오/우 축약을 합침 */
export function normName(word) {
  const sy = syllables(String(word).toLowerCase());
  const out = [];
  const MERGE = { 0: 2, 4: 6, 8: 12, 13: 17 }; // ㅏ→ㅑ, ㅓ→ㅕ, ㅗ→ㅛ, ㅜ→ㅠ
  for (let i = 0; i < sy.length; i++) {
    const a = sy[i], b = sy[i + 1];
    if (a.cho != null && b?.cho === 11 && a.jung === 20 && !a.jong && MERGE[b.jung] != null) {
      out.push({ cho: a.cho, jung: MERGE[b.jung], jong: b.jong }); i++; continue;
    }
    out.push(a);
  }
  const PLAIN = { 2: 0, 3: 1, 6: 4, 7: 5, 12: 8, 17: 13 }; // ㅑ→ㅏ ㅒ→ㅐ ㅕ→ㅓ ㅖ→ㅔ ㅛ→ㅗ ㅠ→ㅜ (표기 흔들림)
  return out.map((x) => (x.raw != null ? x.raw : CHO[x.cho] + JUNG[PLAIN[x.jung] ?? x.jung] + (x.jong || ''))).join('|');
}
function editDistance(a, b) {
  const A = a.split('|'), B = b.split('|');
  const dp = Array.from({ length: A.length + 1 }, (_, i) => [i, ...Array(B.length).fill(0)]);
  for (let j = 1; j <= B.length; j++) dp[0][j] = j;
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++) {
    // 음절 단위 비교, 음절 안에서 모음만 다르면 0.5
    const x = A[i - 1], y = B[j - 1];
    const cost = x === y ? 0 : x[0] === y[0] && x.slice(2) === y.slice(2) ? 0.5 : 1;
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
  }
  return dp[A.length][B.length];
}
/** 두 이름이 같은 캐릭터를 가리키는지 (표기 차이 허용) */
export function sameName(a, b) {
  if (a === b) return true;
  // '홍련:신살' vs '홍련' → 기본 이름으로 비교, 둘 다 변형 이름이면 전체 비교
  if (a.includes(':') !== b.includes(':')) { a = a.split(':')[0]; b = b.split(':')[0]; }
  else if (a.includes(':')) return a.split(':').every((p, i) => sameName(p, b.split(':')[i] || ''));
  if (a === b) return true;
  const x = normName(a), y = normName(b);
  if (x === y) return true;
  const len = Math.max(x.split('|').length, y.split('|').length);
  // 2음절 이름은 정규화 후 완전 일치만, 3음절은 모음 하나 차이까지, 4음절 이상은 한 글자 차이까지
  return len >= 3 && editDistance(x, y) <= (len >= 4 ? 1 : 0.5);
}
function countShared(A, B) {
  let n = 0;
  for (const b of B) if ([...A].some((a) => sameName(a, b))) n++;
  return n;
}

export function isSame(a, b) {
  if (a.game !== b.game || a.server !== b.server) return false;
  const dt = Math.abs(new Date(a.start) - new Date(b.start));
  const sim = similarity(a.title, b.title);
  // 픽업: 같은 캐릭터 이름 2개 이상 겹치고 2주 이내면 같은 픽업 (표기가 달라도)
  // 픽업: 캐릭터 이름(표기 차이 허용)으로 판단
  if (a.type === 'banner' && b.type === 'banner') {
    const A = nameTokens(a.title); const B = nameTokens(b.title);
    const shared = countShared(A, B);
    if (shared >= 2 && dt <= 14 * DAY) return true;
    // 한쪽 캐릭터 구성이 다른 쪽에 포함되고 시작이 비슷하면 같은 픽업 (예: '미탸 기원' ⊂ '미탸·푸리나 기원')
    if (A.size && B.size && shared === Math.min(A.size, B.size) && dt <= 1.5 * DAY) return true;
    if (A.size && B.size && shared === Math.min(A.size, B.size) && (a.status === 'predicted' || b.status === 'predicted') && dt <= 14 * DAY) return true;
    // 종료일이 없거나 미확인인 같은 캐릭터 픽업이 3주 남짓 안에 또 있으면 같은 픽업 (AI가 시작일을 잘못 잡은 경우)
    const loose = !a.end || !b.end || a.status === 'unverified' || b.status === 'unverified';
    if (A.size && B.size && shared === Math.min(A.size, B.size) && loose && dt <= 24 * DAY) return true;
    // 확정 일정과 시작이 같고 캐릭터가 하나라도 겹치는 미확인 픽업은 같은 픽업의 잘못된 표기로 봄
    if (shared >= 1 && dt <= 1.5 * DAY && (a.status === 'unverified') !== (b.status === 'unverified')) return true;
    if (A.size && B.size) return false; // 이름이 다르면 별개 픽업 (같은 날 열리는 서로 다른 배너)
  }
  // 예상(미래시·테섭) 일정은 날짜가 어긋나기 쉬우므로 2주 이내 + 제목 유사하면 같은 픽업으로 봄
  if ((a.status === 'predicted' || b.status === 'predicted') && a.type === b.type && dt <= 14 * DAY && sim >= 0.45) return true;
  if (a.type === b.type && dt <= 1.5 * DAY && sim >= 0.35) return true;
  if (dt <= 1.5 * DAY && sim >= 0.7) return true; // 종류 분류만 다르게 된 경우
  return false;
}

const STATUS_RANK = { rumor: 0, predicted: 0, unverified: 1, confirmed: 2 };

/** 기존 일정 목록에 새로 수집된 일정을 병합. 이력(firstSeen/lastSeen/history) 유지 */
export function mergeEvents(existing, incoming, nowIso = new Date().toISOString()) {
  const list = existing.map((e) => ({ ...e }));
  const stats = { added: 0, updated: 0, unchanged: 0 };
  for (const ev of incoming) {
    const found = list.find((x) => isSame(x, ev));
    if (!found) {
      list.push({ id: makeId(ev), ...ev, firstSeen: nowIso, lastSeen: nowIso, seenCount: 1, history: [] });
      stats.added++;
      continue;
    }
    found.lastSeen = nowIso;
    found.seenCount = (found.seenCount || 1) + 1;
    const urls = new Set(found.sources.map((s) => s.url));
    for (const s of ev.sources) if (!urls.has(s.url)) { found.sources.push(s); urls.add(s.url); }
    found.sources = found.sources.slice(0, 8);

    const better =
      STATUS_RANK[ev.status] > STATUS_RANK[found.status] ||
      (STATUS_RANK[ev.status] === STATUS_RANK[found.status] && ev.confidence >= found.confidence);
    const changed = ev.start !== found.start || ev.end !== found.end;
    if (better) {
      if (changed) {
        found.history = [...(found.history || []), { at: nowIso, start: found.start, end: found.end }].slice(-10);
      }
      const keepTitle = found.type === 'banner' && nameTokens(found.title).size > nameTokens(ev.title).size ? found.title : ev.title;
      for (const k of ['type', 'title', 'start', 'end', 'allDay', 'confidence', 'basis', 'rerun']) found[k] = ev[k];
      found.title = keepTitle; // 캐릭터 이름이 더 많은 제목 유지
      if (ev.description) found.description = ev.description;
      stats.updated++;
    } else {
      if (found.type === 'banner' && nameTokens(ev.title).size > nameTokens(found.title).size) found.title = ev.title;
      // 종료일 정보가 없던 일정에 종료일이 새로 들어오면 보강
      if (!found.end && ev.end) { found.end = ev.end; stats.updated++; } else stats.unchanged++;
    }
    // 여러 차례·여러 출처에서 확인되면 승격
    if (found.status === 'unverified' && found.sources.length >= 3 && found.seenCount >= 2) found.status = 'confirmed';
    if (STATUS_RANK[ev.status] > STATUS_RANK[found.status]) { found.status = ev.status; found.basis = ev.basis; }
    found.major = Boolean(found.major || ev.major);
    if (ev.community) found.community = ev.community;
  }
  return { events: list, stats };
}

/**
 * 일정 정리
 *  - 종료 후 180일 지난 일정 삭제
 *  - 확정이 아닌(미확인·예상) 일정이 그 게임을 다시 수집했는데도 3일 넘게 재확인되지 않으면 삭제 (AI 오추출 자동 정리)
 */
export function prune(events, now = new Date(), lastCollected = {}) {
  return events.filter((e) => {
    if (new Date(e.end || e.start).getTime() <= now.getTime() - 180 * DAY) return false;
    if (e.status === 'confirmed' || e.manual || !e.lastSeen) return true;
    const collected = lastCollected[`${e.game}:${e.server}`];
    const stale = now.getTime() - new Date(e.lastSeen).getTime() > 3 * DAY;
    const started = new Date(e.start).getTime() < now.getTime();
    return !(stale && collected && collected > e.lastSeen && !started);
  });
}

/** data/overrides.json 적용: 숨김, 수정, 수동 추가 */
export function applyOverrides(events, overrides = {}) {
  const hide = new Set(overrides.hide || []);
  const patch = overrides.patch || {};
  const out = events.filter((e) => !hide.has(e.id)).map((e) => (patch[e.id] ? { ...e, ...patch[e.id] } : e));
  for (const add of overrides.add || []) {
    out.push({ status: 'confirmed', confidence: 1, sources: [], allDay: false, end: null, description: '', manual: true, ...add, id: add.id || `manual-${makeId(add)}` });
  }
  return out;
}

/**
 * 확실성 점수(0~100)와 등급
 *  - 근거 종류별 기본 가중치 × AI 신뢰도
 *  - 서로 다른 사이트의 교차 확인, 여러 번 반복 수집되면 가산
 *  - 공식 출처는 최소 90, 일정 전문 사이트는 최소 80
 * 등급: 확정(80+) / 유력(55~79, 달력에 점선으로 표시) / 찌라시(55 미만, 버튼을 눌러야 표시)
 */
export const BASIS_WEIGHT = { official: 1.0, community: 0.8, futuresight: 0.78, datamine: 0.62, rumor: 0.35 };
export function certainty(e, { officialDomains = [], trustedDomains = [] } = {}) {
  if (e.manual) return { score: 100, tier: 'confirmed' };
  const sources = e.sources || [];
  const domains = new Set(sources.map((x) => { try { return new URL(x.url).hostname.replace(/^www\./, ''); } catch { return x.url; } }));
  const basis = e.basis || (e.status === 'rumor' || e.status === 'predicted' ? 'datamine' : 'community');
  const conf = Math.max(0, Math.min(1, Number(e.confidence) || 0));
  let score = (BASIS_WEIGHT[basis] ?? 0.6) * 100 * (0.5 + 0.5 * conf);
  score += Math.min(16, Math.max(0, domains.size - 1) * 8);
  if ((e.seenCount || 1) >= 3) score += 5;
  // 커뮤니티 교차 확인: 서로 다른 작성자가 많이 언급할수록, 개념글일수록 가산 (같은 사람 도배는 1명으로)
  const c = e.community;
  if (c?.authors >= 2) {
    score += Math.min(18, 5 * Math.log2(1 + c.authors)) + Math.min(5, 1.5 * (c.recommended || 0));
    score += Math.min(14, 7 * Math.max(0, (c.sites?.length || 1) - 1)); // 서로 다른 커뮤니티(디시·아카·Reddit)에서 독립적으로 거론
    score += Math.min(6, 3 * (c.reliable || 0)); // Reddit 'Reliable' 플레어
  }
  const predicted = ['futuresight', 'datamine', 'rumor'].includes(basis);
  if (!predicted) {
    if (sources.some((x) => isOfficial(x.url, officialDomains))) score = Math.max(score, 90);
    else if (sources.some((x) => isOfficial(x.url, trustedDomains))) score = Math.max(score, 80);
  } else {
    score = Math.min(score, 79); // 예상 일정은 공식 발표 전까지 '확정'이 될 수 없음
  }
  score = Math.round(Math.max(0, Math.min(100, score)));
  return { score, tier: score >= 80 ? 'confirmed' : score >= 55 ? 'likely' : 'rumor' };
}

const RANK = { rumor: 0, predicted: 0, unverified: 1, confirmed: 2 };
/** 저장된 일정 중 같은 일정끼리 하나로 합침 (확실한 쪽을 대표로, 출처는 합치고, 이름이 많은 제목 유지) */
export function consolidate(events) {
  const kept = [];
  // 확실한 일정부터 기준으로 삼아야 애매한 일정이 엉뚱한 묶음에 붙지 않음
  const ordered = [...events].sort((a, b) => (RANK[b.status] ?? 1) - (RANK[a.status] ?? 1) || (b.confidence || 0) - (a.confidence || 0));
  for (const e of ordered) {
    const k = kept.find((x) => isSame(x, e));
    if (!k) { kept.push({ ...e }); continue; }
    const better = (RANK[e.status] ?? 1) > (RANK[k.status] ?? 1) || ((RANK[e.status] ?? 1) === (RANK[k.status] ?? 1) && (e.confidence || 0) > (k.confidence || 0));
    const win = better ? { ...e } : k;
    const lose = better ? k : e;
    const urls = new Set((win.sources || []).map((s) => s.url));
    win.sources = [...(win.sources || []), ...(lose.sources || []).filter((s) => !urls.has(s.url))].slice(0, 10);
    if (win.type === 'banner' && lose.status !== 'unverified' && nameTokens(lose.title).size > nameTokens(win.title).size) win.title = lose.title;
    if (!win.end && lose.end) win.end = lose.end;
    win.firstSeen = [win.firstSeen, lose.firstSeen].filter(Boolean).sort()[0];
    win.lastSeen = [win.lastSeen, lose.lastSeen].filter(Boolean).sort().pop();
    win.seenCount = (win.seenCount || 1) + (lose.seenCount || 1);
    win.major = Boolean(win.major || lose.major);
    win.rerun = Boolean(win.rerun); // 신규+복각 동시 픽업을 합칠 때 복각 표시가 신규 캐릭터로 번지지 않게 대표 쪽 값 유지
    if (win.community || lose.community) win.community = mergeCommunity(win.community, lose.community);
    kept[kept.indexOf(k)] = win;
  }
  return kept.sort((a, b) => a.start.localeCompare(b.start));
}
function mergeCommunity(a, b) {
  if (!a) return b; if (!b) return a;
  return (a.at || '') >= (b.at || '') ? a : b; // 최신 집계 사용 (같은 글을 두 번 세지 않도록)
}
