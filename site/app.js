(async function () {
  const TYPE_LABEL = { banner: '픽업', event: '이벤트', update: '업데이트', maintenance: '점검', livestream: '방송', other: '기타' };
  const TIER_LABEL = { confirmed: '확정', likely: '예상' };
  const BASIS_LABEL = { official: '공식 발표', community: '기사·위키 정리', futuresight: '미래시(타 서버 선행 일정)' };
  const DAY = 86400000;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const kstWall = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString();
  const kstDate = (iso) => kstWall(iso).slice(0, 10);
  const kstMidnight = (t) => { const d = new Date(t + 9 * 3600000); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 9 * 3600000; };

  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let data;
  try {
    data = await (await fetch('data.json', { cache: 'no-cache' })).json();
  } catch {
    $('updated').textContent = '데이터를 불러오지 못했습니다.';
    return;
  }
  const games = Object.fromEntries(data.games.map((g) => [g.id, g]));
  const order = Object.fromEntries(data.games.map((g, i) => [g.id, i]));
  const gameName = (e) => games[e.game]?.name || e.game;
  for (const e of data.events) e.tier ||= e.status === 'confirmed' ? 'confirmed' : e.status === 'predicted' ? 'likely' : 'likely';

  const fmt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short' });
  const fmtMD = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' });
  const startT = (e) => new Date(e.start).getTime();
  const endT = (e) => (e.end ? new Date(e.end).getTime() : null);
  const lastDay = (e) => new Date(endT(e) - (e.allDay ? DAY : 0));
  const when = (e) => {
    const f = e.allDay ? fmtDay : fmt;
    return e.end ? `${f.format(new Date(e.start))} ~ ${f.format(lastDay(e))}` : `${f.format(new Date(e.start))} ~ (종료일 미정)`;
  };
  const now = Date.now();
  const dday = (e) => {
    const s = startT(e), en = endT(e);
    if (s > now) { const d = Math.ceil((kstMidnight(s) - kstMidnight(now)) / DAY); return { text: d === 0 ? '오늘 시작' : `D-${d} 시작`, cls: 'soon' }; }
    if (en && en > now) { const d = Math.floor((en - now) / DAY); return { text: d === 0 ? `${Math.max(1, Math.round((en - now) / 3600000))}시간 남음` : `종료 D-${d}`, cls: d <= 2 ? 'urgent' : 'live' }; }
    if (en && en <= now) return { text: '종료', cls: 'ended' };
    return { text: '진행 중', cls: 'live' };
  };
  const kindLabel = (e) => (e.type === 'banner' ? (e.rerun ? '복각' : '픽업') : e.major ? '큰 이벤트' : TYPE_LABEL[e.type] || '기타');

  if (data.updatedAt) {
    const ago = Math.max(0, Math.round((now - new Date(data.updatedAt)) / 3600000));
    $('updated').textContent = `마지막 자동 수집 ${fmt.format(new Date(data.updatedAt))} (${ago ? ago + '시간 전' : '방금'}) · 한국 서버 기준`;
  } else {
    $('updated').textContent = '아직 수집된 일정이 없습니다.';
  }

  // ---- 상태 ----
  const known = store.get('knownGames', []);
  const isMobile = matchMedia('(max-width: 760px)').matches;
  const state = {
    view: store.get('view', isMobile ? 'list' : 'timeline'),
    games: new Set(store.get('games', data.games.map((g) => g.id))),
    likely: store.get('likely', true),
    hideEnded: store.get('hideEnded', true),
    others: store.get('others', false),
    tlOffset: 0,
  };
  for (const g of data.games) if (!known.includes(g.id)) state.games.add(g.id);
  store.set('knownGames', data.games.map((g) => g.id));

  for (const g of data.games) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.games.has(g.id)));
    const dot = el('span', 'dot'); dot.style.background = g.color;
    b.append(dot, g.name);
    b.onclick = () => {
      state.games.has(g.id) ? state.games.delete(g.id) : state.games.add(g.id);
      b.setAttribute('aria-pressed', String(state.games.has(g.id)));
      store.set('games', [...state.games]);
      render();
    };
    $('gameChips').append(b);
  }
  for (const [id, key] of [['showLikely', 'likely'], ['hideEnded', 'hideEnded'], ['showOthers', 'others']]) {
    $(id).checked = state[key];
    $(id).onchange = (ev) => { state[key] = ev.target.checked; store.set(key, state[key]); render(); };
  }
  for (const t of document.querySelectorAll('.tabs [data-view]')) {
    t.onclick = () => { state.view = t.dataset.view; store.set('view', state.view); render(); };
  }

  // ---- 필터 ----
  const tierOk = (e) => e.tier === 'confirmed' || (e.tier === 'likely' && state.likely);
  const base = () => data.events.filter((e) => state.games.has(e.game) && tierOk(e));
  const ended = (e) => endT(e) && endT(e) <= now;
  const focus = (e) => e.type === 'banner' || e.major || state.others; // 타임라인·목록·달력에 올릴 일정

  // ---- 타임라인 ----
  function renderTimeline(list) {
    const root = $('timelineView');
    root.replaceChildren();
    const days = isMobile ? 28 : 42;
    const startDay = kstMidnight(now) - 7 * DAY + state.tlOffset * 14 * DAY;
    const endDay = startDay + days * DAY;

    const nav = el('div', 'tl-nav');
    const prev = el('button', 'btn small', '◀ 2주'); prev.type = 'button'; prev.onclick = () => { state.tlOffset--; render(); };
    const today = el('button', 'btn small', '오늘'); today.type = 'button'; today.onclick = () => { state.tlOffset = 0; render(); };
    const next = el('button', 'btn small', '2주 ▶'); next.type = 'button'; next.onclick = () => { state.tlOffset++; render(); };
    const range = el('span', 'tl-range', `${fmtMD.format(new Date(startDay))} ~ ${fmtMD.format(new Date(endDay - DAY))}`);
    nav.append(prev, today, next, range);
    root.append(nav);

    const scroller = el('div', 'tl-scroll');
    const grid = el('div', 'tl');
    grid.style.setProperty('--days', days);
    scroller.append(grid);
    root.append(scroller);

    // 날짜 머리글
    const head = el('div', 'tl-row tl-head');
    head.append(el('div', 'tl-label', ''));
    const dayCells = el('div', 'tl-track');
    for (let i = 0; i < days; i++) {
      const t = startDay + i * DAY;
      const d = new Date(t + 9 * 3600000);
      const c = el('div', 'tl-day');
      const wd = d.getUTCDay();
      if (wd === 0 || wd === 6) c.classList.add('we');
      if (t === kstMidnight(now)) c.classList.add('today');
      c.innerHTML = `<span class="m">${d.getUTCDate() === 1 || i === 0 ? d.getUTCMonth() + 1 + '월' : ''}</span><b>${d.getUTCDate()}</b><span class="w">${'일월화수목금토'[wd]}</span>`;
      dayCells.append(c);
    }
    head.append(dayCells);
    grid.append(head);

    const inWin = list.filter((e) => focus(e) && startT(e) < endDay && (endT(e) || startT(e) + 5 * DAY) > startDay);
    const byGame = new Map();
    for (const e of inWin) { if (!byGame.has(e.game)) byGame.set(e.game, []); byGame.get(e.game).push(e); }
    const rows = [...byGame.keys()].sort((a, b) => order[a] - order[b]);
    if (!rows.length) { const empty = el('div', 'tl-empty', '이 기간에 표시할 픽업이 없습니다.'); grid.append(empty); }

    const pct = (t) => ((Math.min(Math.max(t, startDay), endDay) - startDay) / (endDay - startDay)) * 100;
    const nowPct = pct(now);
    for (const gid of rows) {
      const evs = byGame.get(gid).sort((a, b) => (b.major - a.major) || startT(a) - startT(b) || a.title.localeCompare(b.title));
      // 겹치지 않게 줄(lane) 배치
      const lanes = [];
      for (const e of evs) {
        const s = startT(e), en = endT(e) || s + 5 * DAY;
        let lane = lanes.findIndex((l) => l <= s);
        if (lane < 0) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = en;
        e._lane = lane;
      }
      const row = el('div', 'tl-row');
      const label = el('div', 'tl-label');
      const dot = el('span', 'dot'); dot.style.background = games[gid]?.color;
      const live = evs.filter((e) => e.type === 'banner' && startT(e) <= now && (!endT(e) || endT(e) > now)).length;
      label.append(dot, el('span', 'gname', games[gid]?.name || gid));
      if (live) label.append(el('span', 'gcount', `진행 ${live}`));
      const track = el('div', 'tl-track lanes');
      track.style.setProperty('--lanes', lanes.length);
      const tline = el('i', 'tl-now'); tline.style.left = nowPct + '%';
      if (now > startDay && now < endDay) track.append(tline);
      for (const e of evs) {
        const s = startT(e), en = endT(e) || s + 5 * DAY;
        const bar = el('button', `tl-bar tier-${e.tier}${e.major ? ' major' : ''}${!endT(e) ? ' open-end' : ''}${ended(e) ? ' is-ended' : ''}${e.type !== 'banner' && !e.major ? ' minor' : ''}`);
        bar.type = 'button';
        bar.style.left = pct(s) + '%';
        const wPct = Math.max(1.2, pct(en) - pct(s));
        bar.style.width = wPct + '%';
        bar.style.top = `calc(${e._lane} * var(--lane-h))`;
        bar.style.setProperty('--c', games[gid]?.color || '#888');
        if (s < startDay) bar.classList.add('clip-l');
        if (en > endDay) bar.classList.add('clip-r');
        const dd = dday(e);
        const k = el('span', `kind ${e.rerun ? 'rerun' : e.type === 'banner' ? 'new' : 'etc'}`, kindLabel(e));
        const t = el('span', 'bt', `${e.major ? '★ ' : ''}${e.title}`);
        // 짧은 막대는 캐릭터 이름이 먼저 보이도록 부가 표시를 줄임
        if (wPct > 7) bar.append(k);
        bar.append(t);
        if (e.tier !== 'confirmed' && wPct > 9) bar.append(el('span', `tierchip ${e.tier}`, TIER_LABEL[e.tier]));
        if ((dd.cls === 'urgent' || dd.cls === 'soon') && wPct > 14) bar.append(el('span', `dd ${dd.cls}`, dd.text));
        bar.title = `${gameName(e)} · ${e.title}\n${when(e)}\n${TIER_LABEL[e.tier]} (${e.score ?? '-'}점)`;
        bar.onclick = () => openEvent(e);
        track.append(bar);
      }
      row.append(label, track);
      grid.append(row);
    }
    // 오늘이 보이도록 스크롤
    requestAnimationFrame(() => {
      const w = grid.scrollWidth;
      if (isMobile && scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft = Math.max(0, (nowPct / 100) * (w - 110) - 60);
    });
  }

  // ---- 카드 목록 ----
  function renderList(list) {
    const root = $('listView');
    root.replaceChildren();
    const items = list.filter((e) => focus(e) && !(state.hideEnded && ended(e)));
    const live = items.filter((e) => startT(e) <= now && !ended(e)).sort((a, b) => (endT(a) || 9e15) - (endT(b) || 9e15));
    const soon = items.filter((e) => startT(e) > now).sort((a, b) => startT(a) - startT(b));
    const past = items.filter(ended).sort((a, b) => endT(b) - endT(a));
    for (const [title, arr] of [['진행 중', live], ['예정', soon], ['종료', past]]) {
      if (!arr.length) continue;
      const sec = el('section', 'card-sec');
      sec.append(el('h2', '', `${title} ${arr.length}`));
      const grid = el('div', 'cards');
      for (const e of arr) grid.append(card(e));
      sec.append(grid);
      root.append(sec);
    }
    if (!root.children.length) root.append(el('p', 'tl-empty panel', '표시할 픽업이 없습니다.'));
  }
  function card(e) {
    const c = el('button', `card tier-${e.tier}${e.major ? ' major' : ''}`);
    c.type = 'button';
    c.style.setProperty('--c', games[e.game]?.color || '#888');
    const top = el('div', 'card-top');
    top.append(el('span', 'gname', gameName(e)), el('span', `kind ${e.rerun ? 'rerun' : e.type === 'banner' ? 'new' : 'etc'}`, kindLabel(e)));
    if (e.tier !== 'confirmed') top.append(el('span', `tierchip ${e.tier}`, `${TIER_LABEL[e.tier]} ${e.score ?? ''}`));
    const dd = dday(e);
    top.append(el('span', `dd ${dd.cls}`, dd.text));
    c.append(top, el('div', 'card-title', `${e.major ? '★ ' : ''}${e.title}`), el('div', 'card-when', when(e)));
    c.onclick = () => openEvent(e);
    return c;
  }

  // ---- 달력 ----
  let calendar;
  function renderCalendar(list) {
    if (!calendar) {
      calendar = new FullCalendar.Calendar($('calendar'), {
        locale: 'ko', timeZone: 'UTC', now: () => kstWall(new Date().toISOString()),
        initialView: 'dayGridMonth',
        headerToolbar: { left: 'prev,next today', center: 'title', right: '' },
        buttonText: { today: '오늘' },
        height: 'auto', dayMaxEvents: isMobile ? 3 : 7, displayEventTime: false, eventDisplay: 'block',
        eventOrder: '-majorRank,typeRank,start,title',
        eventClick: (info) => { info.jsEvent.preventDefault(); openEvent(info.event.extendedProps.raw); },
        eventDidMount: (info) => { const e = info.event.extendedProps.raw; info.el.title = `${gameName(e)} · ${e.title}\n${when(e)}`; },
      });
      calendar.render();
    }
    calendar.removeAllEvents();
    calendar.addEventSource(list.filter(focus).map((e) => {
      const color = games[e.game]?.color || '#888';
      const end = e.end || (e.allDay ? null : new Date(startT(e) + 3600000).toISOString());
      return {
        id: e.id,
        title: `${e.rerun ? '[복각] ' : e.type === 'banner' ? '' : `[${kindLabel(e)}] `}${e.title}${e.tier !== 'confirmed' ? ` (${TIER_LABEL[e.tier]})` : ''}`,
        start: e.allDay ? kstDate(e.start) : kstWall(e.start),
        end: end ? (e.allDay ? kstDate(end) : kstWall(end)) : null,
        allDay: e.allDay, backgroundColor: color, borderColor: color, textColor: '#fff',
        classNames: [`tier-${e.tier}`, e.major ? 'major' : ''].filter(Boolean),
        extendedProps: { raw: e, majorRank: e.major ? 1 : 0, typeRank: e.type === 'banner' ? 0 : 1 },
      };
    }));
    setTimeout(() => calendar.updateSize(), 0);
  }

  // ---- 사이드 ----
  function miniList(node, items, sub) {
    node.replaceChildren();
    if (!items.length) { node.append(el('li', 'empty', '없음')); return; }
    for (const e of items.slice(0, 20)) {
      const li = el('li');
      const bar = el('span', 'bar'); bar.style.background = games[e.game]?.color || '#888';
      const t = el('span', 't');
      const top = el('div', '', `[${gameName(e)}] ${e.major ? '★ ' : ''}${e.title}`);
      if (e.rerun) top.prepend(el('span', 'kind rerun', '복각'));
      if (e.tier !== 'confirmed') top.append(el('span', `tierchip ${e.tier}`, TIER_LABEL[e.tier]));
      t.append(top, el('div', 'd', sub(e)));
      li.append(bar, t);
      li.onclick = () => openEvent(e);
      node.append(li);
    }
  }
  function renderSide(list) {
    const live = (e) => startT(e) <= now && endT(e) && endT(e) > now;
    const upcoming = (e, d) => startT(e) > now && startT(e) - now <= d * DAY;
    const banners = list.filter((e) => e.type === 'banner');
    miniList($('endingSoon'), banners.filter((e) => live(e) && endT(e) - now <= 3 * DAY).sort((a, b) => endT(a) - endT(b)), (e) => `${dday(e).text} · ~${fmt.format(lastDay(e))}`);
    miniList($('startingSoon'), banners.filter((e) => upcoming(e, 14)).sort((a, b) => startT(a) - startT(b)), (e) => `${dday(e).text} · ${when(e)}`);
    miniList($('majorList'), list.filter((e) => e.major && !ended(e) && (live(e) || upcoming(e, 60) || (!e.end && now - startT(e) < 7 * DAY))).sort((a, b) => startT(a) - startT(b)), (e) => `${dday(e).text} · ${when(e)}`);
    miniList($('others'), list.filter((e) => e.type !== 'banner' && !e.major && (live(e) || upcoming(e, 14) || (!e.end && startT(e) <= now && now - startT(e) < 2 * DAY))).sort((a, b) => startT(a) - startT(b)), (e) => `${kindLabel(e)} · ${when(e)}`);
  }

  function render() {
    const list = base();
    for (const t of document.querySelectorAll('.tabs [data-view]')) t.setAttribute('aria-selected', String(t.dataset.view === state.view));
    for (const v of ['timeline', 'list', 'calendar']) $(`${v}View`).hidden = v !== state.view;
    $('hideEnded').closest('label').hidden = state.view !== 'list';
    if (state.view === 'timeline') renderTimeline(list);
    if (state.view === 'list') renderList(list);
    if (state.view === 'calendar') renderCalendar(list);
    renderSide(list);
  }
  render();

  // ---- 상세 ----
  function openEvent(e) {
    $('dGame').textContent = gameName(e);
    $('dGame').style.background = games[e.game]?.color || '#888';
    $('dType').textContent = `${e.major ? '★ ' : ''}${kindLabel(e)}`;
    $('dTitle').textContent = e.title;
    $('dWhen').textContent = `${when(e)} (한국 시간) · ${dday(e).text}`;
    $('dTier').textContent = TIER_LABEL[e.tier] || e.tier;
    $('dTier').className = `tier-name ${e.tier}`;
    $('dScore').textContent = e.manual ? '직접 입력' : `확실성 ${e.score ?? '-'}점`;
    $('dBar').style.width = `${e.score ?? 0}%`;
    $('dBar').className = e.tier;
    const comm = e.community?.authors ? ` · 커뮤니티 작성자 ${e.community.authors}명 언급${e.community.recommended ? `(개념글 ${e.community.recommended})` : ''}` : '';
    $('dBasis').textContent = `근거: ${BASIS_LABEL[e.basis] || '미상'} · 출처 ${e.sources?.length || 0}곳${comm}${e.seenCount > 1 ? ` · ${e.seenCount}회 반복 확인` : ''}`;
    $('dDesc').textContent = (e.basis === 'futuresight' ? '미래시(타 서버 선행 일정)로 예상한 한국 서버 일정입니다. 실제 공지와 다를 수 있습니다. ' : '') + (e.description || '');
    $('dHistory').textContent = e.history?.length ? `일정 변경 이력 ${e.history.length}회 · 최초 수집 ${fmtDay.format(new Date(e.firstSeen))}` : e.firstSeen ? `최초 수집 ${fmtDay.format(new Date(e.firstSeen))}` : '';
    const ul = $('dSources');
    ul.replaceChildren();
    for (const s of e.sources || []) {
      const li = el('li');
      if (s.url) {
        const a = el('a', '', s.title || s.url);
        a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        li.append(a);
      } else li.append(s.title || '출처');
      ul.append(li);
    }
    if (!e.sources?.length) ul.append(el('li', '', '출처 없음'));
    $('eventDialog').showModal();
    $('eventDialog').querySelector('menu button').focus();
  }

  // ---- 구독 ----
  $('subscribeBtn').onclick = () => {
    const baseUrl = new URL('ics/', location.href);
    const ul = $('feeds');
    ul.replaceChildren();
    for (const [id, name] of [['all', '전체 게임'], ...data.games.map((g) => [g.id, g.name])]) {
      const url = new URL(`${id}.ics`, baseUrl).href;
      const li = el('li');
      const code = el('code', '', url);
      const copy = el('button', 'btn small', '복사'); copy.type = 'button';
      copy.onclick = async () => { try { await navigator.clipboard.writeText(url); copy.textContent = '복사됨'; } catch { copy.textContent = '실패'; } };
      const gcal = el('a', 'btn small', '구글 캘린더'); gcal.target = '_blank'; gcal.rel = 'noopener';
      gcal.href = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url.replace(/^https?:/, 'webcal:'))}`;
      const ical = el('a', 'btn small', '애플'); ical.href = url.replace(/^https?:/, 'webcal:');
      li.append(el('b', '', name), code, copy, gcal, ical);
      ul.append(li);
    }
    $('subDialog').showModal();
  };
})();
