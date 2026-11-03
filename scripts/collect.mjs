// 수집 에이전트: 게임/서버별로 무료 검색(구글 뉴스·Bing·DuckDuckGo) + 페이지 읽기 → Gemini 구조화 → 검증 → 병합 → data/events.json 저장
// (GEMINI_GROUNDING=1 이면 Gemini 내장 Google 검색을 사용. 무료 등급에서는 한도가 0인 경우가 많아 기본은 꺼짐)
// 사용법: GEMINI_API_KEY=... node scripts/collect.mjs [게임id ...]
//        MOCK=1 node scripts/collect.mjs   (API 없이 test/fixtures 로 동작 확인)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Gemini, resolveRedirect, extractJson, QuotaExhausted } from './lib/gemini.mjs';
import { normalize, mergeEvents, prune, consolidate, TYPES } from './lib/events.mjs';
import { research as freeResearch } from './lib/search.mjs';
import { fetchDcPosts, fetchDcNameMentions, extractClaims, attachCommunity } from './lib/community.mjs';
import { nameTokens } from './lib/events.mjs';

const root = new URL('..', import.meta.url);
const path = (p) => new URL(p, root);
const readJson = async (p, fb) => { try { return JSON.parse(await readFile(path(p), 'utf8')); } catch { return fb; } };

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    events: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: '한국어 일정 제목. 픽업이면 캐릭터 이름 포함' },
          type: { type: 'STRING', enum: TYPES },
          start: { type: 'STRING', description: 'ISO 8601. 시각을 알면 오프셋 포함 (예: 2026-11-05T11:00:00+09:00), 날짜만 알면 YYYY-MM-DD' },
          end: { type: 'STRING', nullable: true, description: '종료 시각/날짜, 모르면 null' },
          description: { type: 'STRING', description: '1~2문장 요약' },
          confidence: { type: 'NUMBER', description: '0~1. 공식 발표로 날짜까지 확인=0.9 이상, 추정=0.5 이하' },
          isRumor: { type: 'BOOLEAN', description: '근거 없는 루머면 true' },
          basis: { type: 'STRING', enum: ['official', 'community', 'futuresight'], description: 'official=공식 발표, community=기사·위키 정리, futuresight=타 서버 선행 일정 기반 한국 서버 예상(미래시)' },
          isRerun: { type: 'BOOLEAN', description: '픽업이 복각(이전에 나왔던 캐릭터의 재픽업)이면 true, 신규 캐릭터면 false' },
          isMajor: { type: 'BOOLEAN', description: '주년·반주년·페스·대형 콜라보 등 큰 이벤트면 true' },
          sources: {
            type: 'ARRAY',
            items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, url: { type: 'STRING' } }, required: ['url'] },
          },
        },
        required: ['title', 'type', 'start', 'confidence', 'isRumor', 'basis', 'isMajor', 'isRerun', 'sources'],
      },
    },
  },
  required: ['events'],
};

function searchPrompt(game, server, today) {
  return `오늘은 ${today} (한국 시간) 입니다.
구글 검색으로 모바일/PC 게임 "${game.name}" (${server.name} 서버)의 **현재 진행 중이거나 앞으로 예정된** 일정을 조사하세요.
조사 대상: ${game.searchHints}
규칙:
- 공식 공지/공식 SNS/공식 홈페이지를 최우선으로 확인하고, 커뮤니티·위키·기사는 보조로만 사용하세요.
- 각 일정마다 시작/종료 날짜와 시각, 시간대(서버 시간 기준이면 ${server.timezone}, UTC${server.utcOffset}), 근거 URL을 적으세요.
- "${server.name}" 서버가 아닌 다른 서버(예: 다른 국가 서버)의 일정은 섞지 마세요.
- 날짜가 공식 확인되지 않은 유출·추정 정보는 반드시 "루머/추정"이라고 표시하세요.
- 확인할 수 없는 날짜를 지어내지 마세요.
- 이미 30일 이상 지난 일정은 제외하세요.
- 하나의 픽업 기간에 여러 캐릭터가 동시에 있으면 캐릭터별이 아니라 "기간 단위"로 묶어 제목에 이름을 나열하세요.

**답변은 설명 없이 아래 형식의 JSON 하나만** \`\`\`json 코드 블록으로 출력하세요.
{"events":[{"title":"한국어 제목","type":"banner|event|update|maintenance|livestream|other","start":"2026-11-05T11:00:00+09:00 또는 2026-11-05","end":"같은 형식 또는 null","description":"1~2문장 요약","confidence":0.0~1.0,"isRumor":false,"sources":[{"title":"출처 제목","url":"https://..."}]}]}
- type: banner=픽업/가챠, event=게임 내 이벤트, update=버전 업데이트, maintenance=점검, livestream=방송
- 시각을 알면 오프셋 포함 ISO 8601, 날짜만 알면 YYYY-MM-DD. 시작일을 모르는 항목은 넣지 마세요.
- confidence: 공식 발표로 날짜 확인=0.9 이상, 비공식 출처=0.5~0.8, 추정=0.5 미만`;
}

function structPrompt(game, server, research, sources) {
  return `다음은 게임 "${game.name}" (${server.name} 서버, 기본 시간대 UTC${server.utcOffset})의 일정 조사 결과입니다.
이를 JSON으로 구조화하세요.
- type: banner(픽업/가챠), event(게임 내 이벤트), update(버전 업데이트), maintenance(점검), livestream(방송), other
- 하나의 픽업 기간에 여러 캐릭터가 동시에 있으면 캐릭터별이 아니라 "기간 단위"로 묶어 제목에 이름을 나열하세요 (예: "푸리나·라이덴 쇼군 기원").
- 시각이 있으면 오프셋 포함 ISO 8601, 날짜만 있으면 YYYY-MM-DD. 시간대 표기가 없으면 UTC${server.utcOffset} 로 간주.
- 조사 결과에 없는 내용은 추가하지 마세요. 시작일을 모르는 항목은 제외하세요.
- sources에는 해당 일정의 근거 URL을 넣으세요. 아래 참고 출처 목록의 URL을 사용해도 됩니다.

[조사 결과]
${research}

[참고 출처]
${sources.map((s, i) => `${i + 1}. ${s.title} ${s.url}`).join('\n')}`;
}

function extractPrompt(game, server, today, found) {
  const results = found.results.map((r, i) => `[R${i + 1}] ${r.date ? r.date.slice(0, 10) + ' ' : ''}${r.title}${r.site ? ' (' + r.site + ')' : ''}\n${r.snippet}\nURL: ${r.url}`).join('\n\n');
  const pages = found.pages.map((p, i) => `[P${i + 1}] URL: ${p.url}\n${p.text}`).join('\n\n---\n\n');
  return `오늘은 ${today} (한국 시간) 입니다.
아래는 게임 "${game.name}" (${server.name} 서버, 기본 시간대 UTC${server.utcOffset})에 대한 검색 결과와 기사/공지 본문 발췌입니다.
여기서 **현재 진행 중이거나 앞으로 예정된** 일정만 뽑아 JSON으로 정리하세요. 조사 대상: ${game.searchHints}

규칙:
- 반드시 아래 자료에 근거한 일정만 넣으세요. 자료에 없는 일정이나 날짜를 지어내지 마세요. 시작일을 알 수 없으면 제외하세요.
- **한국 서버(${server.name}) 기준 일정만** 다룹니다. 일본·중국 등 다른 서버의 일정을 그대로 넣지 마세요.
${game.futuresight ? `  · 단, 다른 서버(${game.futuresight})의 선행 일정으로 한국 서버 일정을 예상하는 자료(미래시)는 넣되 basis="futuresight", 날짜는 한국 서버 기준 예상 날짜로.\n` : ''}  · **테스트 서버·베타·데이터마이닝 유출, 출처 불분명한 찌라시·루머는 절대 넣지 마세요.**
  · 공식 발표는 basis="official", 기사·위키 정리는 "community". [공식 공지]로 표시된 자료는 공식 발표입니다.
- 픽업은 **캐릭터 배너 단위**로 나누세요. 같은 기간에 서로 다른 캐릭터 배너가 여러 개 열리면 각각 별도 항목으로 (예: "미탸 기원", "푸리나 기원"). 제목에는 픽업 캐릭터 이름을 반드시 포함하고, 복각이면 isRerun=true.
- **픽업(가챠 배너) 일정이 가장 중요합니다.** 픽업 대상 캐릭터 이름과 기간을 최대한 정확히 적으세요.
- 주년·반주년·페스·대형 콜라보 같은 큰 이벤트는 isMajor=true.
- 연도가 생략된 날짜(예: 11월 5일)는 오늘 날짜와 기사 날짜를 기준으로 가장 가까운 연도로 해석하세요.
- 30일 이상 지난 일정은 제외하세요.
- type: banner=픽업/가챠, event=게임 내 이벤트, update=버전 업데이트, maintenance=점검, livestream=방송, other
- 시각을 알면 오프셋 포함 ISO 8601 (예: 2026-11-05T11:00:00+09:00), 날짜만 알면 YYYY-MM-DD. 시간대 표기가 없으면 UTC${server.utcOffset}.
- confidence: 공식 공지/여러 자료로 날짜가 명확=0.85 이상, 자료 하나=0.6~0.8, 추정=0.5 미만.
- sources에는 근거가 된 자료의 URL을 그대로 넣으세요(위 목록의 URL만 사용).

[검색 결과]
${results || '(없음)'}

[본문 발췌]
${pages || '(없음)'}`;
}

async function mockClient() {
  const fixture = JSON.parse(await readFile(path('test/fixtures/mock-response.json'), 'utf8'));
  return {
    model: 'mock',
    calls: 0,
    notes: [],
    async searchGrounded(prompt) {
      const id = Object.keys(fixture).find((k) => prompt.includes(`"${fixture[k].gameName}"`) && prompt.includes(`(${fixture[k].serverName} 서버`));
      return { text: '```json\n' + JSON.stringify({ events: id ? fixture[id].events : [] }) + '\n```', sources: [] };
    },
    async structured(prompt) {
      const id = Object.keys(fixture).find((k) => prompt.includes(`"${fixture[k].gameName}"`) && prompt.includes(`(${fixture[k].serverName} 서버`));
      return { events: id ? fixture[id].events : [] };
    },
  };
}

// GitHub Actions 주석으로 오류를 남겨 실행 요약 화면(및 공개 API)에서 바로 보이게 함
function ghError(title, msg) {
  if (!process.env.GITHUB_ACTIONS) return;
  const clean = String(msg).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, ' ').slice(0, 900);
  console.log(`::error title=${title}::${clean}`);
}

async function main() {
  const { games, trustedDomains = [], preferredDomains = [] } = await readJson('config/games.json', { games: [] });
  for (const g of games) g.trustedDomains = [...trustedDomains, ...(g.trustedDomains || [])];
  const only = process.argv.slice(2);
  const targets = games.filter((g) => g.enabled && (!only.length || only.includes(g.id)));
  const client = process.env.MOCK
    ? await mockClient()
    : new Gemini({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL, lastGood: (await readJson('data/state.json', {})).lastGoodModel });
  if (client.discoverModels) console.log('후보 모델:', (await client.discoverModels()).join(', '));

  const now = new Date();
  const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const existing = (await readJson('data/events.json', { events: [] })).events || [];
  const state = await readJson('data/state.json', { lastCollected: {} });
  const incoming = [];
  const debug = {};
  const log = { startedAt: now.toISOString(), model: client.model, runs: [] };

  // 가장 오래전에 수집한 대상부터: 무료 한도로 중간에 멈춰도 다음 실행에서 나머지를 이어서 수집
  const queue = targets
    .flatMap((game) => game.servers.map((server) => ({ game, server, key: `${game.id}:${server.id}` })))
    .sort((a, b) => (state.lastCollected[a.key] || '').localeCompare(state.lastCollected[b.key] || ''));

  let quotaStop = null;
  for (const { game, server, key } of queue) {
    if (quotaStop) { log.runs.push({ game: game.id, server: server.id, skipped: '무료 한도 소진으로 다음 실행에 수집' }); continue; }
    const run = { game: game.id, server: server.id, found: 0, accepted: 0, rejected: [] };
    try {
      let out;
      let known = []; // 근거로 인정할 URL 목록
      if (process.env.GEMINI_GROUNDING === '1' || process.env.MOCK) {
        const research = await client.searchGrounded(searchPrompt(game, server, today));
        for (const s of research.sources.slice(0, 15)) known.push({ ...s, url: await resolveRedirect(s.url) });
        out = extractJson(research.text);
        if (!out || !Array.isArray(out.events)) {
          run.note = 'JSON 추출 실패 → 구조화 호출 사용';
          out = await client.structured(structPrompt(game, server, research.text, known), SCHEMA);
        }
      } else {
        const found = await freeResearch(server.queries || [`${game.name} 픽업 일정`, `${game.name} 업데이트 이벤트 일정`], {
          officialDomains: game.officialDomains,
          preferredDomains,
          keywords: game.keywords || [game.name],
          excludeKeywords: game.excludeKeywords || [],
          sources: server.sources || [],
          extraUrls: server.fetchUrls || [],
          now,
        });
        run.search = { ...found.stats, results: found.results.length, pages: found.pages.length };
        known = [...found.pages.map((p) => ({ title: p.title, url: p.url })), ...found.results.map((r) => ({ title: r.title, url: r.url }))];
        if (!found.results.length && !found.pages.length) throw new Error('검색 결과가 없습니다 (모든 무료 검색원이 실패)');
        out = await client.structured(extractPrompt(game, server, today, found), SCHEMA);
        // 디버그: AI에 넘긴 자료 요약 (결과가 0건일 때 원인 파악용)
        debug[key] = {
          results: found.results.map((r) => `${r.provider} | ${r.date ? r.date.slice(0, 10) : '-'} | ${r.title} | ${r.url}`.slice(0, 300)),
          pages: found.pages.map((p) => ({ url: p.url, chars: p.text.length, head: p.text.slice(0, 300) })),
          extracted: (out.events || []).map((e) => `${e.type} ${e.start}~${e.end || ''} ${e.title} (${e.basis}, ${e.confidence})`),
        };
      }
      const knownUrls = new Set(known.map((k) => k.url));
      const raws = out.events || [];
      run.found = raws.length;
      for (const raw of raws) {
        raw.sources = await Promise.all((raw.sources || []).filter((s) => s && s.url).map(async (s) => ({ ...s, url: await resolveRedirect(s.url) })));
        if (knownUrls.size && !process.env.MOCK) {
          // 자료에 없던 URL(모델이 지어낸 링크)은 버리고, 제목은 자료의 제목으로 채움
          raw.sources = raw.sources.filter((s) => knownUrls.has(s.url)).map((s) => ({ ...s, title: s.title || known.find((k) => k.url === s.url)?.title || '' }));
        }
        if (!raw.sources.length && known.length) raw.sources = known.slice(0, 2); // 근거가 비면 조사 출처로 대체
        const r = normalize(raw, game, server, now);
        if (r.error) run.rejected.push(`${raw.title}: ${r.error}`);
        else { incoming.push(r.event); run.accepted++; }
      }
      state.lastCollected[key] = now.toISOString();
    } catch (err) {
      run.error = String(err.message || err);
      if (err instanceof QuotaExhausted) {
        quotaStop = run.error;
        console.warn(`[${game.id}/${server.id}] 무료 한도 소진 — 나머지는 다음 실행에서 수집합니다.`);
      } else {
        console.error(`[${game.id}/${server.id}] 실패:`, run.error);
        ghError(`수집 실패 ${game.id}/${server.id}`, run.error);
      }
    }
    if (!run.error) console.log(`[${game.id}/${server.id}] 발견 ${run.found}, 채택 ${run.accepted}, 제외 ${run.rejected.length}`);
    log.runs.push(run);
  }

  // ---- 미래시 교차 확인: 디시 갤러리 언급 수 (AI 없이 코드로만, 미래시가 있는 게임만) ----
  //  유출·찌라시는 다루지 않음. 미래시 일정의 캐릭터 이름이 커뮤니티에서 얼마나 거론되는지만 셈
  if (!process.env.MOCK && process.env.SKIP_COMMUNITY !== '1') {
    log.community = [];
    for (const game of targets) {
      const g = game.dcGallery;
      if (!g || !game.futuresight) continue;
      const entry = { game: game.id, gallery: g.id };
      try {
        const known = [...existing, ...incoming].filter((e) => e.game === game.id && e.type === 'banner');
        const pending = [...new Set(known
          .filter((e) => e.basis === 'futuresight' && new Date(e.start).getTime() > now.getTime() - 2 * 86400000)
          .flatMap((e) => [...nameTokens(e.title)])
          .filter((n) => n.length >= 2 && !n.includes(':')))].slice(0, 6);
        const { posts: fsPosts, errors, searchUrl } = await fetchDcPosts(g, { keywords: ['미래시'], now, maxBodies: 2 });
        const named = pending.length ? await fetchDcNameMentions(g, pending, { now }) : { posts: [], errors: [] };
        const seenNo = new Set();
        const posts = [...fsPosts, ...named.posts].filter((p) => !seenNo.has(p.no) && seenNo.add(p.no));
        const stats = extractClaims(posts, { vocab: pending, now, gameWords: [...(game.keywords || []), game.name] });
        const attached = attachCommunity(incoming.filter((e) => e.basis === 'futuresight'), stats, { game: game.id, now })
          + attachCommunity(existing.filter((e) => e.basis === 'futuresight'), stats, { game: game.id, now });
        Object.assign(entry, { searched: pending, posts: posts.length, attached, errors: [...errors, ...named.errors].slice(0, 3) });
      } catch (e) {
        entry.error = String(e.message || e);
      }
      console.log('[community]', JSON.stringify(entry));
      log.community.push(entry);
    }
  }

  const { events, stats } = mergeEvents(existing, incoming, now.toISOString());
  const final = consolidate(prune(events, now, state.lastCollected)).sort((a, b) => a.start.localeCompare(b.start));
  log.model = client.model;
  log.apiCalls = client.calls;
  log.modelNotes = client.notes;
  log.quotaStop = quotaStop;
  log.stats = stats;
  log.finishedAt = new Date().toISOString();
  console.log('병합 결과:', stats, `총 ${final.length}건`);

  await mkdir(path('data/logs/'), { recursive: true });
  await writeFile(path('data/events.json'), JSON.stringify({ updatedAt: log.finishedAt, events: final }, null, 2) + '\n');
  await writeFile(path('data/logs/last-run.json'), JSON.stringify(log, null, 2) + '\n');
  if (client.lastSuccess) state.lastGoodModel = client.lastSuccess;
  await writeFile(path('data/state.json'), JSON.stringify(state, null, 2) + '\n');
  await writeFile(path('data/logs/research.json'), JSON.stringify(debug, null, 1) + '\n');

  const ok = log.runs.filter((r) => !r.error && !r.skipped).length;
  console.log(`API 호출 ${client.calls}회, 성공 ${ok}/${queue.length}`);
  if (quotaStop) {
    const msg = `무료 한도 소진으로 ${queue.length - ok}개 대상을 다음 실행으로 미뤘습니다. ${quotaStop}`;
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=무료 한도::${msg.replace(/\n/g, ' ').slice(0, 900)}`);
  }
  if (queue.length && ok === 0) {
    ghError('수집 실패', quotaStop ? `한 건도 수집하지 못했습니다(무료 한도). ${quotaStop}` : '모든 수집이 실패했습니다. API 키를 확인하세요.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); ghError('수집 중단', e.message || e); process.exit(1); });
