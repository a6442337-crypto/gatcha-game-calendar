import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDcList, parseDcView, extractClaims, attachCommunity } from '../scripts/lib/community.mjs';

const row = (no, title, uid, rec = 0, recImg = false) => `<tr class="ub-content us-post" data-no="${no}" data-type="icon_txt">
<td class="gall_num">${no}</td><td class="gall_tit ub-word"><a href="/mgallery/board/view/?id=x&amp;no=${no}" view-msg="">${recImg ? '<em class="icon_img icon_recomimg"></em>' : ''}${title}</a><a class="reply_numbox"><span class="reply_num">[3]</span></a></td>
<td class="gall_writer ub-writer" data-nick="ㅇㅇ" data-uid="${uid}" data-ip="" data-loc="list"></td><td class="gall_date" title="2026-11-01 10:00:00">x</td><td class="gall_count">10</td><td class="gall_recommend">${rec}</td></tr>`;

test('parseDcList / parseDcView', () => {
  const html = `<tr class="ub-content us-post" data-no="1" data-type="icon_notice"><td class="gall_tit"><a href="#">공지</a></td></tr>` + row(2, '미래시 마코토 픽업 다음주', 'a1', 12, true);
  const [p] = parseDcList(html);
  assert.equal(p.no, 2);
  assert.equal(p.title, '미래시 마코토 픽업 다음주');
  assert.equal(p.author, 'a1');
  assert.equal(p.recommended, true);
  assert.equal(parseDcView('<div class="write_div" style="x"><p>미래시</p><p>마코토</p></div>'), '미래시 마코토');
});

test('미래시 캐릭터 언급 수를 작성자 기준으로 세어 일정에 붙임', () => {
  const now = new Date('2026-11-03T00:00:00Z');
  const posts = ['a', 'b', 'c', 'a'].map((u) => ({ title: '미래시 보니까 마코토 픽업 온다', author: u, viaSearch: true, date: '2026-11-01 10:00:00' }));
  const stats = extractClaims(posts, { now, vocab: ['마코토'] });
  assert.equal(stats.get('마코토').authors.size, 3); // 같은 사람 글은 1명
  const evs = [{ game: 'bluearchive', type: 'banner', title: '마코토·아코 픽업 모집', basis: 'futuresight' }];
  assert.equal(attachCommunity(evs, stats, { game: 'bluearchive', now }), 1);
  assert.equal(evs[0].community.authors, 3);
});
