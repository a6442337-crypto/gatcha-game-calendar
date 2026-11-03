// 정적 사이트 빌드: site/ + 데이터(수동 수정 반영) + .ics 피드 → _site/
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { applyOverrides, certainty, nameTokens, consolidate, sameName } from './lib/events.mjs';
import { buildIcs } from './lib/ics.mjs';

const root = new URL('..', import.meta.url);
const path = (p) => new URL(p, root);
const readJson = async (p, fb) => { try { return JSON.parse(await readFile(path(p), 'utf8')); } catch { return fb; } };

const { games } = await readJson('config/games.json', { games: [] });
const data = await readJson('data/events.json', { events: [] });
const overrides = await readJson('data/overrides.json', {});
const lastRun = await readJson('data/logs/last-run.json', null);
const { trustedDomains = [] } = await readJson('config/games.json', {});
const scored = consolidate(applyOverrides(data.events || [], overrides)).map((e) => {
  const g = games.find((x) => x.id === e.game) || {};
  return { ...e, ...certainty(e, { officialDomains: g.officialDomains, trustedDomains }) };
});
// 여러 캐릭터를 묶은 픽업(버전 요약 등)이 캐릭터별 픽업으로도 수집돼 있으면 묶음 쪽은 숨김
//  - 2명 묶음: 두 이름 모두 다른 픽업에 있을 때 / 3명 이상: 절반 넘게 다른 픽업에 있을 때
const DAY = 86400000;
const span = (e) => [new Date(e.start).getTime(), e.end ? new Date(e.end).getTime() : new Date(e.start).getTime() + 21 * DAY];
const events = scored.filter((e) => !['datamine', 'rumor'].includes(e.basis) && e.tier !== 'rumor').filter((b) => { // 유출·찌라시·낮은 확실성 정보는 공개하지 않음
  if (b.type !== 'banner' || b.manual) return true;
  const names = [...nameTokens(b.title)];
  if (names.length < 2) return true;
  const [bs, be] = span(b);
  const peers = scored.filter((x) => {
    if (x === b || x.type !== 'banner' || x.game !== b.game) return false;
    const n = nameTokens(x.title).size;
    if (!n || n >= names.length) return false;
    const [xs, xe] = span(x);
    return xs < be && xe > bs && xs >= bs - 1.5 * DAY; // 묶음 기간 안에서 열리는 픽업
  });
  const covered = names.filter((n) => peers.some((x) => [...nameTokens(x.title)].some((m) => sameName(m, n)))).length;
  return names.length === 2 ? covered < 2 : covered / names.length <= 0.5;
});

const gameMap = Object.fromEntries(games.map((g) => [g.id, g]));
const serverMap = {};
for (const g of games) for (const s of g.servers) serverMap[`${g.id}:${s.id}`] = s.name;

await rm(path('_site/'), { recursive: true, force: true });
await cp(path('site/'), path('_site/'), { recursive: true });
await mkdir(path('_site/ics/'), { recursive: true });

const publicGames = games.filter((g) => g.enabled !== false).map(({ id, name, color, servers }) => ({ id, name, color, servers: servers.map(({ id, name }) => ({ id, name })) }));
await writeFile(
  path('_site/data.json'),
  JSON.stringify({
    updatedAt: data.updatedAt || null,
    lastRun: lastRun && { finishedAt: lastRun.finishedAt, model: lastRun.model, errors: lastRun.runs.filter((r) => r.error).map((r) => `${r.game}/${r.server}`) },
    games: publicGames,
    events,
  })
);

// 구독 피드: 픽업 + 큰 이벤트 (예상 일정 포함, 제목에 표시)
const icsEvents = events.filter((e) => e.type === 'banner' || e.major);
await writeFile(path('_site/ics/all.ics'), buildIcs(icsEvents, { name: '서브컬처 게임 일정', games: gameMap, servers: serverMap }));
for (const g of games) {
  const list = icsEvents.filter((e) => e.game === g.id);
  await writeFile(path(`_site/ics/${g.id}.ics`), buildIcs(list, { name: `${g.name} 일정`, games: gameMap, servers: serverMap }));
}
console.log(`빌드 완료: 일정 ${events.length}건, 피드 ${games.length + 1}개`);
