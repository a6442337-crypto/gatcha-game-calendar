// 참고 사이트 스냅샷: 전체 화면 캡처(데스크톱/모바일), 렌더링된 HTML, 링크 목록, 네트워크 JSON 응답 일부 저장
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const urls = fs.readFileSync('config/snapshot-urls.txt', 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
const out = 'data/refs';
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch();
  for (const url of urls) {
    const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').replace(/_+$/, '');
    for (const [kind, viewport] of [['desktop', { width: 1400, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
      const json = [];
      if (kind === 'desktop') page.on('response', async (r) => {
        try {
          const ct = r.headers()['content-type'] || '';
          if (/json/.test(ct) && json.length < 15) json.push({ url: r.url(), body: (await r.text()).slice(0, 20000) });
        } catch {}
      });
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(2500);
        await page.screenshot({ path: path.join(out, `${slug}.${kind}.png`), fullPage: true });
        if (kind === 'desktop') {
          fs.writeFileSync(path.join(out, `${slug}.html`), (await page.content()).slice(0, 1500000));
          fs.writeFileSync(path.join(out, `${slug}.text.txt`), (await page.innerText('body')).slice(0, 200000));
          const links = await page.$$eval('a[href]', (as) => [...new Set(as.map((a) => a.href))]);
          fs.writeFileSync(path.join(out, `${slug}.links.txt`), links.join('\n'));
          fs.writeFileSync(path.join(out, `${slug}.json-responses.json`), JSON.stringify(json, null, 1));
        }
        console.log('ok', kind, url);
      } catch (e) {
        console.log('fail', kind, url, e.message);
        fs.writeFileSync(path.join(out, `${slug}.${kind}.error.txt`), String(e.message));
      }
      await page.close();
    }
  }
  await browser.close();
})();
