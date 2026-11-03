// 무료 검색 수집기 (API 키 불필요)
//  - Google 뉴스 RSS : 최근 기사 제목·요약·날짜
//  - Bing RSS        : 일반 웹 검색 결과(실제 URL + 요약)
//  - DuckDuckGo HTML : 일반 웹 검색 결과(실제 URL + 요약)
// 상위 페이지 본문을 직접 내려받아 날짜가 언급된 부분만 추려 LLM에 전달합니다.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+|#39);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

async function get(url, { timeout = 12000, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept, 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.6,ja;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  const type = res.headers.get('content-type') || '';
  const buf = await res.arrayBuffer();
  const body = new TextDecoder('utf-8').decode(buf.slice(0, 2_000_000));
  return { status: res.status, url: res.url, type, body };
}

function safeDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const it = m[0];
    const tag = (t) => (it.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`)) || [])[1] || '';
    items.push({
      title: stripTags(tag('title')),
      url: decodeEntities(tag('link')).trim(),
      snippet: stripTags(decodeEntities(tag('description'))).slice(0, 400),
      date: safeDate(stripTags(tag('pubDate'))),
      site: stripTags(tag('source')),
    });
  }
  return items;
}

export function parseDuckDuckGo(html) {
  const out = [];
  const blocks = html.split(/<div[^>]+class="[^"]*result[ _]/).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let href = decodeEntities(a[1]);
    const ud = href.match(/[?&]uddg=([^&]+)/);
    if (ud) href = decodeURIComponent(ud[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (/duckduckgo\.com\/y\.js/.test(href)) continue; // 광고
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div|td)>/);
    out.push({ title: stripTags(a[2]), url: href, snippet: stripTags(sn?.[1]).slice(0, 400), date: null, site: '' });
  }
  return out;
}

const PROVIDERS = {
  googleNews: async (q) => {
    const r = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:45d')}&hl=ko&gl=KR&ceid=KR:ko`, { accept: 'application/rss+xml,application/xml' });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return parseRss(r.body).slice(0, 15);
  },
  bing: async (q) => {
    const r = await get(`https://www.bing.com/search?format=rss&setlang=ko&cc=KR&q=${encodeURIComponent(q)}`, { accept: 'application/rss+xml,application/xml' });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!/<rss|<channel/.test(r.body)) throw new Error('RSS 아님');
    return parseRss(r.body).slice(0, 10);
  },
  duckduckgo: async (q) => {
    const r = await get(`https://html.duckduckgo.com/html/?kl=kr-kr&q=${encodeURIComponent(q)}`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const res = parseDuckDuckGo(r.body);
    if (!res.length && /anomaly|captcha/i.test(r.body)) throw new Error('봇 차단');
    return res.slice(0, 10);
  },
};

const DATE_RE = /(\d{4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\/\d{1,2}(?!\d)|\d{1,2}月\s*\d{1,2}日)/g;

const DATE_TEST = new RegExp(DATE_RE.source);

/** HTML에서 본문 텍스트를 뽑아 날짜가 언급된 주변 문맥만 추림 */
export function extractRelevantText(html, maxLen = 3500) {
  const og = (html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i) || [])[1] || '';
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const text = stripTags(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|p|div|li|tr|h\d)\b[^>]*>/gi, '\n')
  );
  const windows = [];
  for (const m of text.matchAll(DATE_RE)) {
    const s = Math.max(0, m.index - 220);
    const e = Math.min(text.length, m.index + 260);
    const last = windows[windows.length - 1];
    if (last && s <= last[1]) last[1] = e; else windows.push([s, e]);
  }
  let body = windows.map(([s, e]) => text.slice(s, e)).join(' … ');
  if (!body) body = text.slice(0, 1200);
  return `${title}\n${decodeEntities(og)}\n${body}`.slice(0, maxLen);
}

/**
 * 구글 뉴스 RSS 링크(news.google.com/rss/articles/...)를 실제 기사 주소로 변환.
 * 기사 페이지의 서명값으로 batchexecute 를 호출하는 방식 — 실패하면 null (그 기사는 제목·요약만 사용)
 */
export async function decodeGoogleNews(url) {
  try {
    const id = url.match(/articles\/([^?]+)/)?.[1];
    if (!id) return null;
    const page = await get(`https://news.google.com/articles/${id}`, { timeout: 10000 });
    const sig = page.body.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = page.body.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sig || !ts) return null;
    const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'KR:ko', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sig]);
    const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': UA },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    const m = text.match(/garturlres\\+",\\+"((?:https?:)(?:[^\\"]|\\+u[0-9a-fA-F]{4})+)/);
    return m ? m[1].replace(/\\+u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : null;
  } catch {
    return null;
  }
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

/**
 * 여러 무료 검색원으로 조사.
 * @returns {{ results: Array, pages: Array, stats: object }}
 */
export async function research(queries, { officialDomains = [], preferredDomains = [], keywords = [], excludeKeywords = [], extraUrls = [], sources = [], maxPages = 6, now = new Date() } = {}) {
  const stats = { providers: {}, pagesFetched: 0, pageErrors: 0, irrelevant: 0, newsResolved: 0, official: 0 };
  const kw = keywords.map((k) => k.toLowerCase());
  const ex = excludeKeywords.map((k) => k.toLowerCase());
  const relevant = (r) => {
    const text = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
    if (ex.some((k) => text.includes(k))) return false; // 예: 명일방주 검색에서 '엔드필드' 결과 제외
    return !kw.length || kw.some((k) => text.includes(k));
  };

  // 공식 게시판(네이버 카페 등)을 먼저 읽음 — 검색보다 정확하고 날짜가 확실함
  const official = [];
  for (const src of sources) {
    try {
      const items = await (OFFICIAL_SOURCES[src.type] || (async () => []))(src, now);
      official.push(...items);
      stats.official += items.length;
    } catch (e) {
      (stats.officialErrors ||= []).push(`${src.type}: ${e.message}`.slice(0, 160));
    }
  }
  const all = [];
  for (const q of queries) {
    for (const [name, fn] of Object.entries(PROVIDERS)) {
      const st = (stats.providers[name] ||= { ok: 0, results: 0, errors: [] });
      try {
        const raw = await fn(q);
        const r = raw.filter(relevant); // 게임 이름이 없는 결과(엉뚱한 검색 결과)는 버림
        stats.irrelevant += raw.length - r.length;
        st.ok++; st.results += r.length;
        all.push(...r.map((x) => ({ ...x, provider: name, query: q })));
      } catch (e) {
        st.errors.push(`${q}: ${e.message}`.slice(0, 160));
      }
      await sleep(800);
    }
  }
  // 중복 제거 (URL·제목 기준), 너무 오래된 뉴스 제외
  const seen = new Set();
  const cutoff = now.getTime() - 60 * 86400000;
  const results = all.filter((r) => {
    const k = r.url.replace(/[?#].*$/, '') + '|';
    const t = r.title.replace(/\s+/g, '');
    if (!r.url || seen.has(k) || seen.has(t)) return false;
    if (r.date && new Date(r.date).getTime() < cutoff) return false;
    seen.add(k); seen.add(t);
    return true;
  });

  // 구글 뉴스 리다이렉트 링크 → 실제 기사 주소 (최근 기사 몇 개만)
  const news = results.filter((r) => /news\.google\.com\/rss\/articles\//.test(r.url)).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 6);
  for (const r of news) {
    const real = await decodeGoogleNews(r.url);
    if (real) { r.url = real; stats.newsResolved++; }
  }

  // 본문을 읽을 페이지: 공식 도메인 > 일정 정리 사이트 > 날짜가 보이는 결과 > 최근 기사
  const domainIn = (u, list) => list.some((d) => { const h = hostOf(u); const dd = d.split('/')[0]; return h === dd || h.endsWith('.' + dd); });
  const fetchable = results.filter((r) => !/news\.google\.com/.test(r.url));
  const score = (r) => (domainIn(r.url, officialDomains) ? 10 : 0) + (domainIn(r.url, preferredDomains) ? 8 : 0) + (DATE_TEST.test(r.title + r.snippet) ? 3 : 0) + (r.date ? 1 : 0);
  const toFetch = [...extraUrls.map((url) => ({ url, title: '', provider: 'config' })), ...fetchable.sort((a, b) => score(b) - score(a))].slice(0, maxPages);

  const pages = [];
  for (const r of toFetch) {
    try {
      const p = await get(r.url, { timeout: 10000 });
      if (p.status !== 200 || !/html|xml|text/.test(p.type)) throw new Error(`HTTP ${p.status}`);
      pages.push({ url: p.url, title: r.title, text: extractRelevantText(p.body) });
      stats.pagesFetched++;
    } catch {
      stats.pageErrors++;
    }
  }
  return { results: results.slice(0, 25), pages: [...official, ...pages], stats };
}

// ---- 공식 게시판 ----
const cafeHeaders = { 'user-agent': UA, referer: 'https://cafe.naver.com/', accept: 'application/json' };
async function getJson(url) {
  const res = await fetch(url, { headers: cafeHeaders, signal: AbortSignal.timeout(12000) });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const kstStr = (ts) => new Date(ts + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ');

/** 네이버 카페 게시글 본문 텍스트 (공개 글만, 실패 시 null) */
async function cafeArticleText(cafeId, articleId) {
  try {
    const j = await getJson(`https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/${cafeId}/articles/${articleId}?useCafeId=true&requestFrom=A`);
    const html = j?.result?.article?.contentHtml || '';
    return html ? stripTags(html.replace(/<(br|p|div|li|tr)\b[^>]*>/gi, '\n')).slice(0, 2500) : null;
  } catch {
    return null;
  }
}

export const OFFICIAL_SOURCES = {
  /**
   * 네이버 카페 공식 공지: { type:'naverCafe', cafeId, slug, menuIds:[..], titleFilter:'정규식', maxArticles }
   * 공지 목록 API는 로그인 없이 제목·요약·작성일을 제공 → 최근 60일, 제목 필터에 맞는 글만 사용
   */
  naverCafe: async (src, now) => {
    const lists = [];
    lists.push(getJson(`https://apis.naver.com/cafe-web/cafe-boardlist-api/v1/cafes/${src.cafeId}/notices/menus/${src.menuIds?.[0] || 0}`).catch(() => null));
    for (const m of src.menuIds || []) {
      lists.push(getJson(`https://apis.naver.com/cafe-web/cafe-boardlist-api/v1/cafes/${src.cafeId}/menus/${m}/articles?page=1&pageSize=30&sortBy=TIME&viewType=C`).catch(() => null));
    }
    const seen = new Set();
    const items = [];
    const filter = src.titleFilter ? new RegExp(src.titleFilter, 'i') : null;
    for (const j of await Promise.all(lists)) {
      for (const row of j?.result?.articleList || []) {
        const a = row.item || row;
        if (!a?.articleId || seen.has(a.articleId)) continue;
        seen.add(a.articleId);
        if (a.writeDateTimestamp && now - a.writeDateTimestamp > 60 * 86400000) continue;
        if (filter && !filter.test(a.subject || '')) continue;
        items.push(a);
      }
    }
    items.sort((x, y) => (y.writeDateTimestamp || 0) - (x.writeDateTimestamp || 0));
    const out = [];
    for (const a of items.slice(0, src.maxArticles || 12)) {
      const body = out.length < 6 ? await cafeArticleText(src.cafeId, a.articleId) : null;
      out.push({
        url: `https://cafe.naver.com/${src.slug}/${a.articleId}`,
        title: `[공식 공지] ${a.subject}`,
        text: `[공식 공지 · 작성 ${a.writeDateTimestamp ? kstStr(a.writeDateTimestamp) : '?'} KST] ${a.subject}\n${body || a.summary || ''}`.slice(0, 2500),
        official: true,
      });
    }
    return out;
  },
};
