const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const results = [];
  const ok = (name, cond) => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`); };
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 380, height: 560 }, colorScheme: scheme });
    page.on('pageerror', (e) => results.push('PAGEERROR ' + e.message));
    await page.addInitScript(() => {
      const now = Date.now();
      const tasks = [];
      const spaces = [{ id: 's1', name: 'Clients' }, { id: 's2', name: 'Internal' }];
      const names = ['Homepage redesign', 'Logo refresh', 'Brochure layout', 'Website QA', 'Social media kit', 'Invoice prep', 'Team meeting'];
      for (let i = 0; i < 230; i++) tasks.push({
        id: 't' + i, name: names[i % names.length] + ' #' + i, url: 'https://app.clickup.com/t/t' + i,
        status: { status: 'in progress', color: '#4194f6' }, list: { id: 'l' + (i % 3), name: ['Acme Co', 'Beta LLC', 'Ops'][i % 3] },
        folder: { name: 'Active', hidden: i % 2 === 0 }, space: { id: i % 3 === 2 ? 's2' : 's1' },
        assignees: i % 4 === 0 ? [{ id: 99 }] : [{ id: 1 }], date_updated: String(now - i * 1000),
      });
      let current = null; window.__calls = [];
      const settings = { token: 'pk_test', idleMinutes: 10, recents: [], favorites: [], version: '1.0.0' };
      window.tdg = {
        api: async (method, p, body) => {
          window.__calls.push({ method, p, body });
          if (p === '/user') return { ok: true, data: { user: { id: 1, username: 'Chris' } } };
          if (p === '/team') return { ok: true, data: { teams: [{ id: 123, name: 'TDG' }] } };
          if (p.startsWith('/team/123/space')) return { ok: true, data: { spaces } };
          if (p.startsWith('/team/123/task')) { const pg = +p.match(/page=(\d+)/)[1]; const b = tasks.slice(pg * 100, pg * 100 + 100); return { ok: true, data: { tasks: b, last_page: pg * 100 + 100 >= tasks.length } }; }
          if (p.endsWith('/time_entries/current')) return { ok: true, data: { data: current } };
          if (p.endsWith('/time_entries/start')) { const t = tasks.find((x) => x.id === body.tid); current = { id: 'e1', task: { id: t.id, name: t.name }, start: String(Date.now() - 3723000), duration: -1, description: '' }; return { ok: true, data: { data: current } }; }
          if (p.endsWith('/time_entries/stop')) { const c = current; current = null; return { ok: true, data: { data: c } }; }
          if (method === 'POST' && p.endsWith('/time_entries')) return { ok: true, data: { data: { id: 'm1' } } };
          if (method === 'PUT') return { ok: true, data: {} };
          return { ok: false, error: 'unmocked ' + p };
        },
        getSettings: async () => ({ ...settings }),
        setSettings: async (patch) => Object.assign(settings, patch) && { ...settings },
        setTrayTitle: (t) => { window.__tray = t; }, setRunning: () => {}, hide: () => {}, quit: () => {}, openUrl: () => {},
        checkUpdate: async () => ({ available: true, version: 'v1.0.1' }), installUpdate: async () => ({ ok: true }),
        on: (ch, fn) => { (window.__on = window.__on || {})[ch] = fn; },
      };
    });
    await page.goto('file://' + path.resolve(__dirname, '../src/index.html'));
    await page.waitForFunction(() => /tasks/.test(document.getElementById('status').textContent));
    ok(`${scheme}: loaded all pages of tasks`, (await page.textContent('#status')).includes('230'));
    ok(`${scheme}: "Mine" excludes others`, !(await page.textContent('#list')).includes('#0 '));
    await page.screenshot({ path: `test/shot-${scheme}-main.png` });

    await page.fill('#search', 'logo acme');
    const rows = await page.$$eval('.task .t-name', (els) => els.map((e) => e.textContent));
    ok(`${scheme}: multi-word search`, rows.length > 0 && rows.every((r) => r.startsWith('Logo refresh')));
    await page.press('#search', 'Enter');
    await page.waitForFunction(() => document.getElementById('current').classList.contains('running'));
    await page.waitForTimeout(1100);
    ok(`${scheme}: tray shows h:mm`, await page.evaluate(() => window.__tray === '1:02'));
    ok(`${scheme}: card shows task`, (await page.textContent('#curName')).startsWith('Logo refresh'));
    await page.fill('#search', '');
    await page.screenshot({ path: `test/shot-${scheme}-running.png` });

    // switch task stops old first
    await page.fill('#search', 'brochure');
    await page.press('#search', 'Enter');
    await page.waitForFunction(() => document.getElementById('curName').textContent.startsWith('Brochure'));
    const calls = await page.evaluate(() => window.__calls.map((c) => c.p.split('/').pop()).filter((x) => x === 'stop' || x === 'start'));
    ok(`${scheme}: switching stops then starts`, calls.join(',') === 'start,stop,start');

    // idle trim
    await page.evaluate(() => window.__on['idle-returned']({ idleSince: Date.now() - 20 * 60000, now: Date.now() }));
    ok(`${scheme}: idle view shown`, await page.isVisible('#viewIdle'));
    await page.screenshot({ path: `test/shot-${scheme}-idle.png` });
    await page.click('#idleTrimContinue');
    await page.waitForFunction(() => !document.getElementById('viewIdle').offsetParent);
    const put = await page.evaluate(() => window.__calls.find((c) => c.method === 'PUT'));
    ok(`${scheme}: idle trim sets end before now`, put && put.body.end < Date.now() - 19 * 60000);
    ok(`${scheme}: timer restarted after trim`, await page.evaluate(() => document.getElementById('current').classList.contains('running')));

    // manual entry
    await page.click('#stopBtn');
    await page.click('#manualBtn');
    await page.fill('#mTaskSearch', 'website');
    await page.click('#mTaskPick .task');
    await page.fill('#mDuration', '1h 15m');
    ok(`${scheme}: duration hint`, (await page.textContent('#mDurationHint')).includes('1h 15m'));
    await page.fill('#mStart', '09:30');
    await page.screenshot({ path: `test/shot-${scheme}-manual.png` });
    await page.click('#manualForm button[type=submit]');
    const m = await page.evaluate(() => window.__calls.find((c) => c.method === 'POST' && c.p.endsWith('/time_entries')));
    ok(`${scheme}: manual entry duration`, m && m.body.duration === 75 * 60000 && new Date(m.body.start).getHours() === 9 && new Date(m.body.start).getMinutes() === 30);

    // parser
    const pd = await page.evaluate(() => ['1:15', '45m', '1.5h', '2h', '90', '1h15', 'abc'].map(window.__tdgTest.parseDuration));
    ok(`${scheme}: parseDuration`, JSON.stringify(pd) === JSON.stringify([4500000, 2700000, 5400000, 7200000, 5400000, 4500000, 0]));
    await page.click('#settingsBtn');
    await page.screenshot({ path: `test/shot-${scheme}-settings.png` });
    await page.close();
  }
  console.log(results.join('\n'));
  await browser.close();
})();
