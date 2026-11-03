// 커뮤니티(디시인사이드) 미래시 교차 확인 — AI를 쓰지 않고 코드로만 처리 (유출·찌라시는 다루지 않음)
//  - 디시 robots.txt 는 AI 크롤러를 차단하므로, 게시글 내용은 Gemini 등 AI에 보내지 않음
//  - 갤러리 내 키워드 검색(유출·베타·미래시)과 개념글 목록의 제목·작성자·추천수를 읽고,
//    상위 몇 개 글만 본문을 한 번씩 읽어 캐릭터 이름·버전·날짜 언급을 셈
//  - 저장하는 것은 "캐릭터 이름, 예상 시기, 언급 통계"뿐 (글 내용·이미지는 저장하지 않음)
import { nameTokens, sameName } from './events.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = (s) => String(s || '').replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&([a-z]+|#39);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const strip = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function galleryBase(g) {
  const path = g.type === 'board' ? 'board' : g.type === 'mini' ? 'mini/board' : 'mgallery/board';
  return `https://gall.dcinside.com/${path}`;
}

async function getHtml(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://gall.dcinside.com/', 'accept-language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(12000) });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 갤러리 목록 HTML → 게시글 목록 */
export function parseDcList(html) {
  const out = [];
  for (const row of html.match(/<tr class="ub-content us-post[^"]*"[\s\S]*?<\/tr>/g) || []) {
    const type = (row.match(/data-type="([^"]*)"/) || [])[1] || '';
    const no = (row.match(/data-no="(\d+)"/) || [])[1];
    if (!no || /notice|survey|ad/.test(type)) continue;
    const titleHtml = (row.match(/<td class="gall_tit[^"]*">([\s\S]*?)<\/td>/) || [])[1] || '';
    const a = titleHtml.match(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const head = strip((row.match(/<td class="gall_subject">([\s\S]*?)<\/td>/) || [])[1]);
    const w = row.match(/<td class="gall_writer[^"]*" data-nick="([^"]*)" data-uid="([^"]*)" data-ip="([^"]*)"/) || [];
    out.push({
      no: Number(no),
      title: strip(a[2]),
      head,
      author: w[2] || (w[3] ? `ip:${w[3]}` : `nick:${w[1] || '?'}`),
      date: (row.match(/<td class="gall_date" title="([^"]+)"/) || [])[1] || null,
      views: Number(strip((row.match(/<td class="gall_count">([\s\S]*?)<\/td>/) || [])[1])) || 0,
      recommend: Number(strip((row.match(/<td class="gall_recommend">([\s\S]*?)<\/td>/) || [])[1])) || 0,
      comments: Number((titleHtml.match(/reply_num">\[(\d+)/) || [])[1]) || 0,
      recommended: /icon_recomimg|icon_recomtxt/.test(titleHtml), // 개념글
    });
  }
  return out;
}

/** 게시글 본문 HTML → 텍스트 (최대 3000자) */
export function parseDcView(html) {
  const body = (html.match(/<div class="write_div"[^>]*>([\s\S]*?)<\/div>\s*<!--/) || html.match(/<div class="write_div"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
  return strip(body.replace(/<(br|p|div|li)\b[^>]*>/gi, '\n')).slice(0, 3000);
}

/** 갤러리에서 키워드 검색 결과 + 개념글을 모아 최근 글 목록 반환 */
export async function fetchDcPosts(gallery, { keywords = ['유출'], now = new Date(), maxBodies = 3, days = 45 } = {}) {
  const base = galleryBase(gallery);
  const urls = keywords.map((k) => `${base}/lists/?id=${gallery.id}&s_type=search_subject_memo&s_keyword=${encodeURIComponent(k)}`);
  urls.push(`${base}/lists/?id=${gallery.id}&exception_mode=recommend`);
  const posts = new Map();
  const errors = [];
  for (const u of urls) {
    try {
      for (const p of parseDcList(await getHtml(u))) if (!posts.has(p.no)) posts.set(p.no, { ...p, viaSearch: !u.includes('exception_mode') });
    } catch (e) { errors.push(`${u.split('&s_keyword=')[1] || 'recommend'}: ${e.message}`); }
    await sleep(1500);
  }
  const cutoff = now.getTime() - days * DAY;
  const list = [...posts.values()].filter((p) => !p.date || new Date(p.date.replace(' ', 'T') + '+09:00').getTime() >= cutoff);
  // 본문은 추천·댓글이 많은 글 몇 개만 한 번씩 읽음 (서버 부담 최소화)
  const pick = [...list].sort((a, b) => (b.recommend * 3 + b.comments) - (a.recommend * 3 + a.comments)).slice(0, maxBodies);
  for (const p of pick) {
    try { p.body = parseDcView(await getHtml(`${base}/view/?id=${gallery.id}&no=${p.no}`)); } catch (e) { errors.push(`view ${p.no}: ${e.message}`); }
    await sleep(1500);
  }
  return { posts: list, errors, searchUrl: urls[0] };
}

/** 다른 출처에서 나온 이름을 갤러리에서 직접 검색 (교차 확인용) */
export async function fetchDcNameMentions(gallery, names, { now = new Date(), days = 45 } = {}) {
  const base = galleryBase(gallery);
  const out = [];
  const errors = [];
  const cutoff = now.getTime() - days * DAY;
  for (const n of names) {
    try {
      const list = parseDcList(await getHtml(`${base}/lists/?id=${gallery.id}&s_type=search_subject_memo&s_keyword=${encodeURIComponent(n)}`));
      out.push(...list.filter((p) => !p.date || new Date(p.date.replace(' ', 'T') + '+09:00').getTime() >= cutoff).map((p) => ({ ...p, viaSearch: true, searchedName: n })));
    } catch (e) { errors.push(`${n}: ${e.message}`); }
    await sleep(1500);
  }
  return { posts: out, errors };
}

// ---- 코드 기반 주장(claim) 추출 ----
const FS_RE = /(미래시|선행|일섭|중섭|일본\s*서버|중국\s*서버|다음\s*(픽업|배너)|예정)/; // 미래시 관련 글
const STOP = new Set(['스포', '스포일러', '스포주의', '얼여', '수요일', '목요일', '금요일', '토요일', '일요일', '월요일', '화요일', '일주일', '아침', '저녁', '새벽', '근황', '떡상', '떡락', '나눔', '원본', '많이', '아직', '고민', '복귀', '별로', '대체', '드디어', '만우절', '전서버', '재미로', '통계로', '예측', '보는', '무조건', '몰라', '최고점', '선택권', '굿스마일', '신연방', '그녀', '뭐하', '근데', '진짜', '이거', '그럼', '그냥', '이번', '다음', '지금', '오늘', '내일', '언제', '누구', '뭐냐', '뭐임', '이게', '저거', '이건', '그거', '아니', '혹시', '역시', '근본', '정상', '미친', '시발', '씨발', 'ㅋㅋ', 'ㅋㅋㅋ', 'ㅎㅎ', '레전드', '확정', '루머', '떡밥', '찌라시', '카더라', '유출', '유출임', '유출떴다', '베타', '테섭', '미래시', '선행', '일섭', '중섭', '한섭', '글섭', '픽업', '배너', '버전', '캐릭', '캐릭터', '신캐', '복각', '성능', '스킬', '모션', '모델링', '스토리', '이벤트', '업데이트', '가챠', '천장', '확률', '과금', '무과금', '뉴비', '고인물', '갤러', '갤주', '념글', '개념글', '정보', '공식', '방송', '예고', '공개', '출시', '나옴', '나온다', '나왔다', '온다', '옴', '뜸', '떴다', '실화', '정리', '모음', '요약', '후기', '질문', '추천', '사진', '영상', '이미지', '번역', '원문', '출처', '전반', '후반', '하반기', '상반기', '이상', '이하', '정도', '느낌', '생각', '얘기', '소식', '기대', '걱정', '같은데', '같음', '같다']);
const VERBISH = /(다|요|냐|네|음|함|됨|임|듯|거|게|지|고|서|면|도|니|까|냐고|는데|했|하는|하면|해서|인데|이냐|이네|이다|이지|일까|일듯|라고|으로|에서|한테|부터|까지|만|들|님)$/;
const KO_DATE = /(?<![\d.])(\d{1,2})\s*(?:월\s*(\d{1,2})\s*일|\/\s*(\d{1,2})(?![\d/]))/g; // '11월 25일', '11/25' (버전 '7.3'은 제외)
const VERSION = /(\d{1,2}\.\d{1,2})(?!\d)/g;

/**
 * 게시글에서 캐릭터별 언급 통계를 냄
 * @param posts fetchDcPosts 결과
 * @param vocab 이미 알려진 캐릭터 이름(다른 출처에서 수집된 픽업의 이름)
 * @returns Map(name → { authors:Set, posts, recommended, versions:Map, dates:Map, phases:Map, latest })
 */
export function extractClaims(posts, { vocab = [], now = new Date(), gameWords = [] } = {}) {
  const stats = new Map();
  const year = new Date(now.getTime() + 9 * 3600000).getUTCFullYear();
  for (const p of posts) {
    const text = `${p.title} ${p.body || ''}`;
    if (!FS_RE.test(text) && !p.viaSearch) continue;
    const site = p.site || 'dcinside';
    const versions = [...text.matchAll(VERSION)].map((m) => m[1]).filter((v) => Number(v.split('.')[1]) < 10);
    const phase = /(후반|하반|2기|2차|후편)/.test(text) ? 2 : /(전반|상반|1기|1차|전편)/.test(text) ? 1 : null;
    const dates = [];
    for (const m of p.title.matchAll(KO_DATE)) {
      const mo = Number(m[1]), d = Number(m[2] || m[3]);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const pad = (n) => String(n).padStart(2, '0');
      let y = year;
      if (Date.UTC(y, mo - 1, d) < now.getTime() - 60 * DAY) y++; // 이미 한참 지난 날짜면 내년
      dates.push(`${y}-${pad(mo)}-${pad(d)}`);
    }
    // 이름 후보: 제목 토큰(본문은 알려진 이름만) — 동사·형용사형, 흔한 단어, 게임 이름 제외
    // Reddit 등 영어 글은 미리 한국어로 옮긴 이름(p.names)을 사용
    const titleTokens = p.names ? [] : [...nameTokens(p.title)].filter((t) => !STOP.has(t) && !VERBISH.test(t) && !gameWords.some((g) => t.includes(g)) && t.length <= 8);
    const found = new Set([...titleTokens.filter((t) => t.length >= 2), ...(p.names || [])]);
    if (!p.names) for (const v of vocab) if (text.includes(v)) found.add(v);
    for (const raw of found) {
      const name = [...stats.keys()].find((k) => sameName(k, raw)) || raw;
      const s = stats.get(name) || { authors: new Set(), posts: 0, recommended: 0, reliable: 0, sites: new Map(), versions: new Map(), dates: new Map(), phases: new Map(), latest: null, inVocab: vocab.some((v) => sameName(v, raw)) };
      s.authors.add(`${site}:${p.author}`);
      s.posts++;
      const bs = s.sites.get(site) || { posts: 0, authors: new Set() };
      bs.posts++; bs.authors.add(p.author); s.sites.set(site, bs);
      if (p.recommended || p.recommend >= 10) s.recommended++;
      for (const v of versions) s.versions.set(v, (s.versions.get(v) || 0) + 1);
      for (const d of dates) s.dates.set(d, (s.dates.get(d) || 0) + 1);
      if (phase) s.phases.set(phase, (s.phases.get(phase) || 0) + 1);
      if (p.date && (!s.latest || p.date > s.latest)) s.latest = p.date;
      stats.set(name, s);
    }
  }
  return stats;
}


export function communitySummary(s, now = new Date()) {
  const by = {};
  for (const [site, b] of s.sites || []) by[site] = { posts: b.posts, authors: b.authors.size };
  return { posts: s.posts, authors: s.authors.size, recommended: s.recommended, reliable: 0, sites: Object.keys(by), by, at: now.toISOString() };
}

/** 이미 수집된 일정(다른 출처)에 커뮤니티 언급 통계를 붙임 → 교차 확인 가중치 */
export function attachCommunity(events, stats, { game, now = new Date() }) {
  let n = 0;
  for (const e of events) {
    if (e.game !== game || e.type !== 'banner') continue;
    const names = [...nameTokens(e.title)];
    let best = null;
    for (const [k, s] of stats) if (names.some((x) => sameName(x, k)) && (!best || s.authors.size > best.authors.size)) best = s;
    if (!best || best.authors.size < 2) continue;
    e.community = communitySummary(best, now);
    n++;
  }
  return n;
}
