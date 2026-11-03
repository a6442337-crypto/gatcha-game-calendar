import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRss, parseDuckDuckGo, extractRelevantText } from '../scripts/lib/search.mjs';

test('parseRss: 구글 뉴스 형식', () => {
  const xml = `<rss><channel><item><title>블루 아카이브, 11월 5일 '호시노' 픽업 시작 - 인벤</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Fri, 30 Oct 2026 03:00:00 GMT</pubDate><description>&lt;a href="x"&gt;블루 아카이브 픽업&lt;/a&gt;</description><source url="https://inven.co.kr">인벤</source></item></channel></rss>`;
  const [it] = parseRss(xml);
  assert.equal(it.title, "블루 아카이브, 11월 5일 '호시노' 픽업 시작 - 인벤");
  assert.equal(it.url, 'https://news.google.com/rss/articles/abc?oc=5');
  assert.equal(it.date, '2026-10-30T03:00:00.000Z');
  assert.equal(it.snippet, '블루 아카이브 픽업');
  assert.equal(it.site, '인벤');
});

test('parseDuckDuckGo: 리다이렉트 URL 해제, 광고 제외', () => {
  const html = `
  <div class="result results_links web-result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;rut=x">원신 <b>6.2</b> 기원</a></h2>
  <a class="result__snippet" href="#">11월 12일부터 <b>푸리나</b> 픽업</a></div>
  <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">광고</a></div>`;
  const r = parseDuckDuckGo(html);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, 'https://example.com/a?b=1');
  assert.equal(r[0].title, '원신 6.2 기원');
  assert.equal(r[0].snippet, '11월 12일부터 푸리나 픽업');
});

test('extractRelevantText: 날짜 주변만 추림, 스크립트 제거', () => {
  const html = `<html><head><title>공지</title><script>var x="11월 1일";</script></head><body><nav>메뉴</nav>
  <p>${'무관한 내용 '.repeat(200)}</p><p>픽업 기간: 2026.11.05 11:00 ~ 11.19 10:59</p></body></html>`;
  const t = extractRelevantText(html);
  assert.match(t, /^공지/);
  assert.match(t, /픽업 기간: 2026\.11\.05/);
  assert.doesNotMatch(t, /var x/);
  assert.ok(t.length < 1200);
});

test('parseRss: 해석 불가능한 날짜는 null', () => {
  const [it] = parseRss('<rss><item><title>a</title><link>https://a.com</link><pubDate>어제</pubDate></item></rss>');
  assert.equal(it.date, null);
});

test('decodeGoogleNews: batchexecute 응답에서 실제 기사 주소 추출', async () => {
  const { decodeGoogleNews } = await import('../scripts/lib/search.mjs');
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opt) => {
    calls.push(String(url));
    if (String(url).includes('/articles/')) {
      return { status: 200, url, headers: { get: () => 'text/html' }, arrayBuffer: async () => new TextEncoder().encode('<div data-n-a-sg="SIG" data-n-a-ts="1700000000"></div>').buffer };
    }
    assert.match(decodeURIComponent(opt.body), /SIG/);
    return { text: async () => ')]}\'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.inven.co.kr/webzine/news/?news=1\\u0026site=x\\",1]",null,null,null,"generic"]]' };
  };
  try {
    assert.equal(await decodeGoogleNews('https://news.google.com/rss/articles/CBMiABC?oc=5'), 'https://www.inven.co.kr/webzine/news/?news=1&site=x');
  } finally { globalThis.fetch = orig; }
});
