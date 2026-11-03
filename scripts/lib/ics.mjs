// iCalendar(.ics) 생성 — 구글 캘린더/아이폰 캘린더 구독용
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function fold(line) {
  // RFC 5545: 75 옥텟 단위 줄바꿈 (UTF-8 멀티바이트 문자 경계 보존)
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const utc = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function kstDate(iso, addDays = 0) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600000 + addDays * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const TYPE_LABEL = { banner: '픽업', event: '이벤트', update: '업데이트', maintenance: '점검', livestream: '방송', other: '기타' };

export function buildIcs(events, { name, games, servers }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//subcul-calendar//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    'X-WR-TIMEZONE:Asia/Seoul',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  const stamp = utc(new Date().toISOString());
  for (const e of events) {
    const g = games[e.game]?.name || e.game;
    const sv = servers[`${e.game}:${e.server}`];
    const multiServer = (Object.keys(servers).filter((k) => k.startsWith(e.game + ':')).length > 1);
    const prefix = `[${g}${multiServer && sv ? ' ' + sv : ''}]`;
    const BASIS = { futuresight: '미래시', datamine: '테섭' };
    const status = e.tier === 'likely' ? ` (유력${BASIS[e.basis] ? '·' + BASIS[e.basis] : ''})` : e.tier === 'rumor' ? ' (찌라시)' : '';
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.id}@subcul-calendar`);
    lines.push(`DTSTAMP:${stamp}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${kstDate(e.start)}`);
      lines.push(`DTEND;VALUE=DATE:${e.end ? kstDate(e.end) : kstDate(e.start, 1)}`);
    } else {
      lines.push(`DTSTART:${utc(e.start)}`);
      // 기간이 긴 배너/이벤트는 시작~종료 전체를 하나의 일정으로
      lines.push(`DTEND:${utc(e.end || new Date(new Date(e.start).getTime() + 3600000).toISOString())}`);
    }
    const kind = e.type === 'banner' ? (e.rerun ? '복각' : '픽업') : TYPE_LABEL[e.type] || '';
    lines.push(`SUMMARY:${esc(`${e.major ? '★ ' : ''}${prefix} ${kind} · ${e.title}${status}`)}`);
    const desc = [e.description, ...(e.sources || []).map((s) => `출처: ${s.url}`)].filter(Boolean).join('\n');
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    if (e.sources?.[0]?.url) lines.push(`URL:${e.sources[0].url}`);
    lines.push(`CATEGORIES:${esc(g)},${esc(TYPE_LABEL[e.type] || '기타')}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
