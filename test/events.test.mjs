import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, normalize, mergeEvents, isOfficial, applyOverrides, prune } from '../scripts/lib/events.mjs';
import { buildIcs } from '../scripts/lib/ics.mjs';

const game = { id: 'genshin', officialDomains: ['hoyolab.com', 'x.com/GenshinImpact'] };
const server = { id: 'asia', utcOffset: '+08:00' };
const now = new Date('2026-11-01T00:00:00Z');

test('parseDate: 오프셋 없으면 서버 기본 오프셋', () => {
  assert.equal(parseDate('2026-11-12T11:00', '+08:00').date.toISOString(), '2026-11-12T03:00:00.000Z');
  assert.equal(parseDate('2026-11-12T11:00:00+0900', '+08:00').date.toISOString(), '2026-11-12T02:00:00.000Z');
  assert.equal(parseDate('2026-11-12', '+09:00').allDay, true);
  assert.equal(parseDate('11월 12일', '+09:00'), null);
});

test('isOfficial: 도메인/경로 일치', () => {
  assert.ok(isOfficial('https://www.hoyolab.com/article/1', game.officialDomains));
  assert.ok(isOfficial('https://act.hoyolab.com/x', game.officialDomains));
  assert.ok(isOfficial('https://x.com/GenshinImpact/status/1', game.officialDomains));
  assert.ok(!isOfficial('https://x.com/fanaccount/status/1', game.officialDomains));
  assert.ok(!isOfficial('https://nothoyolab.com/', game.officialDomains));
});

test('normalize: 검증 규칙', () => {
  const ok = normalize({ title: 'A', type: 'banner', start: '2026-11-12T11:00:00+08:00', end: '2026-12-02T14:59:00+08:00', confidence: 0.5, sources: [{ url: 'https://hoyolab.com/a' }] }, game, server, now);
  assert.equal(ok.event.status, 'confirmed'); // 공식 출처
  assert.equal(normalize({ title: 'B', type: 'x', start: '2025-01-01', confidence: 1, sources: [] }, game, server, now).error, '이미 지난 일정');
  assert.equal(normalize({ title: 'C', type: 'event', start: '2028-01-01', confidence: 1, sources: [] }, game, server, now).error, '1년 이후 일정(신뢰 불가)');
  assert.equal(normalize({ title: 'D', type: 'banner', start: '2026-12-01', confidence: 0.9, isRumor: true, sources: [] }, game, server, now).error, '유출·찌라시 제외');
  assert.equal(normalize({ title: 'D', type: 'banner', start: '2026-12-01', confidence: 0.9, basis: 'datamine', sources: [] }, game, server, now).error, '유출·찌라시 제외');
  assert.equal(normalize({ title: 'D', type: 'banner', start: '2026-12-01', confidence: 0.9, basis: 'futuresight', sources: [] }, game, server, now).error, '미래시 대상 게임 아님');
  const fs = normalize({ title: 'D2', type: 'banner', start: '2026-12-01', confidence: 0.4, basis: 'futuresight', sources: [{ url: 'https://hoyolab.com/a' }] }, { ...game, futuresight: '일본 서버' }, server, now);
  assert.equal(fs.event.status, 'predicted'); // 미래시는 공식 도메인이 섞여도 예상
  assert.equal(fs.event.basis, 'futuresight');
  assert.equal(normalize({ title: '6주년 기념 이벤트', type: 'event', start: '2026-11-03', confidence: 0.5, sources: [] }, game, server, now).event.major, true);
  assert.equal(normalize({ title: '블루아카 페스 이벤트', type: 'event', start: '2026-11-03', confidence: 0.5, sources: [] }, game, server, now).event.major, true);
  assert.equal(normalize({ title: '일반 이벤트', type: 'event', start: '2026-11-03', confidence: 0.5, sources: [] }, game, server, now).event.major, false);
  const allDay = normalize({ title: 'E', type: 'event', start: '2026-11-01', end: '2026-11-05', confidence: 0.5, sources: [] }, game, server, now);
  assert.equal(allDay.event.allDay, true);
  assert.equal(allDay.event.end, '2026-11-05T16:00:00.000Z'); // 11/6 00:00 +08:00 (배타적 종료)
  assert.equal(allDay.event.status, 'unverified');
  const oneSite = normalize({ title: 'F', type: 'event', start: '2026-11-03', confidence: 0.95, sources: [{ url: 'https://a.com/1' }] }, game, server, now);
  assert.equal(oneSite.event.status, 'unverified'); // 비공식 출처 1곳뿐이면 신뢰도가 높아도 미확인
  const twoSites = normalize({ title: 'G', type: 'event', start: '2026-11-03', confidence: 0.95, sources: [{ url: 'https://a.com/1' }, { url: 'https://b.com/2' }] }, game, server, now);
  assert.equal(twoSites.event.status, 'confirmed');
});

test('mergeEvents: 표현이 다른 같은 일정은 하나로 병합하고 출처를 합침', () => {
  const a = normalize({ title: '푸리나·나히다 기원', type: 'banner', start: '2026-11-12T11:00:00+08:00', confidence: 0.6, sources: [{ url: 'https://a.com/1' }] }, game, server, now).event;
  const b = normalize({ title: '푸리나, 나히다 기원 (1차)', type: 'banner', start: '2026-11-12T11:00:00+08:00', end: '2026-12-02T14:59:00+08:00', confidence: 0.9, sources: [{ url: 'https://hoyolab.com/x' }] }, game, server, now).event;
  const c = normalize({ title: '6.2 업데이트', type: 'update', start: '2026-11-12T06:00:00+08:00', confidence: 0.9, sources: [] }, game, server, now).event;
  const first = mergeEvents([], [a], '2026-11-01T00:00:00Z');
  assert.equal(first.stats.added, 1);
  const second = mergeEvents(first.events, [b, c], '2026-11-01T12:00:00Z');
  assert.equal(second.events.length, 2);
  const merged = second.events.find((e) => e.type === 'banner');
  assert.equal(merged.sources.length, 2);
  assert.equal(merged.status, 'confirmed');
  assert.equal(merged.end, '2026-12-02T06:59:00.000Z');
  assert.equal(merged.id, first.events[0].id); // id 유지
  assert.equal(merged.seenCount, 2);
});

test('mergeEvents: 일정 변경 시 이력 기록', () => {
  const a = normalize({ title: '정기 점검', type: 'maintenance', start: '2026-11-04T10:00:00+09:00', confidence: 0.9, sources: [] }, game, server, now).event;
  const b = { ...a, start: '2026-11-04T11:00:00.000Z', confidence: 0.95 };
  const r = mergeEvents(mergeEvents([], [a]).events, [b]);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].history.length, 1);
});

test('applyOverrides / prune', () => {
  const ev = [{ id: 'x', start: '2026-11-01T00:00:00Z', end: null, title: 'old' }, { id: 'y', start: '2026-11-01T00:00:00Z', end: null, title: 'y' }];
  const out = applyOverrides(ev, { hide: ['y'], patch: { x: { title: 'new' } }, add: [{ game: 'g', server: 's', type: 'event', title: 'M', start: '2026-11-02T00:00:00Z' }] });
  assert.deepEqual(out.map((e) => e.title), ['new', 'M']);
  assert.equal(prune([{ start: '2025-01-01T00:00:00Z', end: null }], now).length, 0);
});

test('buildIcs: 유효한 형식과 줄 접기', () => {
  const ics = buildIcs(
    [{ id: 'abc', game: 'genshin', server: 'asia', type: 'banner', title: '아주 긴 제목'.repeat(10), start: '2026-11-12T03:00:00.000Z', end: '2026-12-02T06:59:00.000Z', allDay: false, status: 'confirmed', sources: [{ url: 'https://a.com' }], description: '쉼표, 세미콜론;' }],
    { name: '테스트', games: { genshin: { name: '원신' } }, servers: { 'genshin:asia': '아시아' } }
  );
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261112T030000Z/);
  assert.match(ics, /쉼표\\, 세미콜론\\;/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
});

test('mergeEvents: 미래시 예상 픽업이 공식 발표로 확정되면 하나로 합쳐짐', () => {
  const pred = normalize({ title: '호시노(수영복) 픽업 모집', type: 'banner', start: '2026-11-20', confidence: 0.4, basis: 'futuresight', sources: [{ url: 'https://a.com/1' }] }, { ...game, futuresight: '일본 서버' }, server, now).event;
  const off = normalize({ title: '호시노(수영복) 픽업 모집 안내', type: 'banner', start: '2026-11-26T11:00:00+09:00', end: '2026-12-10T10:59:00+09:00', confidence: 0.95, basis: 'official', sources: [{ url: 'https://hoyolab.com/x' }] }, game, server, now).event;
  const r = mergeEvents(mergeEvents([], [pred]).events, [off]);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].status, 'confirmed');
  assert.equal(r.events[0].basis, 'official');
  assert.equal(r.events[0].start, '2026-11-26T02:00:00.000Z');
});

test('isSame: 표기가 다른 같은 픽업(캐릭터 이름 2개 이상 일치) 병합', async () => {
  const { isSame, nameTokens } = await import('../scripts/lib/events.mjs');
  const base = { game: 'nikke', server: 'kr', type: 'banner' };
  assert.ok(isSame({ ...base, title: '마리안 : 퀸, 라푼젤 : 생츄어리, 홍련 : 신살 픽업', start: '2026-10-14T15:00:00Z' }, { ...base, title: '마리안·홍련·라푼젤 픽업 모집', start: '2026-10-23T02:00:00Z' }));
  assert.ok(!isSame({ ...base, title: '피닉스·벨리나 독점 채널', start: '2026-10-20T00:00:00Z' }, { ...base, title: '피닉스·세베리안 독점 채널', start: '2026-10-20T00:00:00Z' }));
  assert.deepEqual([...nameTokens('7.2 버전 제1기 이벤트 기원 (미탸·푸리나)')], ['미탸', '푸리나']);
});

test('major: 픽업·방송은 큰 이벤트로 분류하지 않음', () => {
  assert.equal(normalize({ title: '4주년 기념 픽업', type: 'banner', isMajor: true, start: '2026-11-03', confidence: 0.5, sources: [] }, game, server, now).event.major, false);
  assert.equal(normalize({ title: '4주년 업데이트', type: 'update', isMajor: true, start: '2026-11-03', confidence: 0.5, sources: [] }, game, server, now).event.major, true);
  assert.equal(normalize({ title: '7.2 메인 이벤트', type: 'event', isMajor: true, start: '2026-11-03', confidence: 0.5, sources: [] }, game, server, now).event.major, false);
});

test('prune: 재확인되지 않는 미확인 일정은 정리, 확정은 유지', () => {
  const base = { game: 'g', server: 's', start: '2026-11-20T00:00:00Z', end: null };
  const evs = [
    { ...base, id: 'a', status: 'unverified', lastSeen: '2026-10-25T00:00:00Z' },
    { ...base, id: 'b', status: 'confirmed', lastSeen: '2026-10-25T00:00:00Z' },
    { ...base, id: 'c', status: 'unverified', lastSeen: '2026-10-31T00:00:00Z' },
  ];
  const out = prune(evs, now, { 'g:s': '2026-11-01T00:00:00Z' });
  assert.deepEqual(out.map((e) => e.id), ['b', 'c']);
});

test('certainty: 근거별 가중치와 등급', async () => {
  const { certainty } = await import('../scripts/lib/events.mjs');
  const off = { officialDomains: ['hoyolab.com'], trustedDomains: ['mollulog.net'] };
  assert.equal(certainty({ basis: 'community', confidence: 0.6, sources: [{ url: 'https://hoyolab.com/a' }] }, off).tier, 'confirmed');
  assert.equal(certainty({ basis: 'futuresight', confidence: 0.6, sources: [{ url: 'https://mollulog.net/futures' }] }, off).tier, 'likely');
  assert.equal(certainty({ basis: 'futuresight', confidence: 1, sources: [{ url: 'https://hoyolab.com/a' }, { url: 'https://b.com' }, { url: 'https://c.com' }] }, off).score, 79); // 미래시는 확정 불가
  // 커뮤니티에서 많이 거론되는 미래시는 점수가 오름
  const base = { basis: 'futuresight', confidence: 0.4, sources: [{ url: 'https://a.com' }] };
  assert.ok(certainty({ ...base, community: { authors: 14, sites: ['dcinside'] } }, off).score > certainty(base, off).score);
});

test('normalize: 복각 판별', () => {
  assert.equal(normalize({ title: '[복각] 푸리나 기원', type: 'banner', start: '2026-11-04', confidence: 0.9, sources: [] }, game, server, now).event.rerun, true);
  assert.equal(normalize({ title: '미탸 기원', type: 'banner', isRerun: false, start: '2026-11-04', confidence: 0.9, sources: [] }, game, server, now).event.rerun, false);
});

test('major: 주년 하위 이벤트(교환 코드·무료 지급)는 제외 / 같은 캐릭터 픽업 표기 차이 병합', async () => {
  const { isSame } = await import('../scripts/lib/events.mjs');
  assert.equal(normalize({ title: '4주년 기념 교환 코드 사용 가능 기간', type: 'event', isMajor: true, start: '2026-11-03', confidence: 0.9, sources: [] }, game, server, now).event.major, false);
  assert.equal(normalize({ title: '5주년 페스티벌', type: 'event', isMajor: true, start: '2026-11-03', confidence: 0.9, sources: [] }, game, server, now).event.major, true);
  const b = { game: 'nikke', server: 'kr', type: 'banner', start: '2026-10-28T02:00:00Z' };
  assert.ok(isSame({ ...b, title: '마리안 : 퀸 특수 모집' }, { ...b, title: '마리안 : 퀸 픽업' }));
});

test('중복 픽업: 표기 차이·부분 집합·배너 별칭을 하나로 합침', async () => {
  const { consolidate, sameName } = await import('../scripts/lib/events.mjs');
  const b = { game: 'genshin', server: 'kr', type: 'banner', sources: [] };
  const evs = [
    { ...b, id: '1', status: 'unverified', confidence: 0.7, title: '미탸 기원', start: '2026-11-03T16:00:00Z', end: '2026-11-24T16:00:00Z' },
    { ...b, id: '2', status: 'confirmed', confidence: 0.9, title: '미탸·푸리나 기원 (7.2 제1기)', start: '2026-11-04T03:00:00Z', end: '2026-11-24T10:00:00Z' },
    { ...b, id: '3', status: 'confirmed', confidence: 0.95, title: '[픽업] 원신 - 「규칙 파괴자」 미타(번개)', start: '2026-11-04T03:00:00Z', end: '2026-11-24T10:00:00Z' },
    { ...b, id: '4', status: 'confirmed', confidence: 0.9, title: '자백·린네아 기원', start: '2026-11-24T10:00:00Z', end: '2026-12-15T07:00:00Z' },
  ];
  const out = consolidate(evs);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '미탸·푸리나 기원 (7.2 제1기)'); // 이름이 많은 제목 유지
  assert.equal(out[0].status, 'confirmed');
  assert.ok(sameName('미탸', '미티아'));
  assert.ok(!sameName('히나', '하나'));
});
