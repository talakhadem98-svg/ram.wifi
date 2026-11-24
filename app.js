'use strict';
/* NetBoost - فارسی، راست‌به‌چپ. بخش‌ها: وای‌فای و موبایل */

const NB = (window.Capacitor && Capacitor.registerPlugin) ? Capacitor.registerPlugin('NetBoost') : null;
const $ = (s, r) => (r || document).querySelector(s);
const view = $('#view'), tabsEl = $('#tabs'), titleEl = $('#title'), backEl = $('#back');
const ADB_PKG = 'com.nexus.netboost';

const state = { sec: null, tab: null, files: null, apps: null, keep: JSON.parse(localStorage.getItem('keep') || 'null') };

/* ------------------------------------------------------------ helpers */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtB = b => {
  b = Number(b) || 0;
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3800);
}
async function work(text, fn) {
  $('#busyText').textContent = text; $('#busy').hidden = false;
  try { return await fn(); }
  catch (e) { console.error(e); toast('خطا: ' + (e && e.message ? e.message : e)); return null; }
  finally { $('#busy').hidden = true; }
}
const setBusy = t => { $('#busyText').textContent = t; };
function copy(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('کپی شد'), () => toast('کپی نشد'));
}
async function perm(type) {
  const r = await NB.requestPerms({ type });
  if (!r.granted) toast(type === 'wifi' ? 'برای اسکن وای‌فای مجوز Location لازمه' : 'برای دسترسی به فایل‌ها مجوز لازمه');
  return r.granted;
}
function scoreColor(s) { return s >= 75 ? 'var(--ok)' : s >= 50 ? 'var(--warn)' : 'var(--bad)'; }
function ring(v, label) {
  return `<div class="ring" style="--v:${v};--c:${scoreColor(v)}"><div><span><b>${v}</b><small>${esc(label)}</small></span></div></div>`;
}

/* ------------------------------------------------------------ router */
const WIFI_TABS = [['analyze', 'تحلیل'], ['speed', 'تست سرعت'], ['dns', 'DNS'], ['auto', 'خودکار'], ['guide', 'راهنما']];
const PHONE_TABS = [['quick', 'پاکسازی'], ['files', 'فایل‌ها'], ['ram', 'رم و CPU'], ['cache', 'کش'], ['battery', 'باتری']];

function go(sec, tab) {
  state.sec = sec; state.tab = tab || (sec === 'wifi' ? 'analyze' : sec === 'phone' ? 'quick' : null);
  render();
}
backEl.onclick = () => go(null);

function render() {
  window.scrollTo(0, 0);
  if (!state.sec) {
    backEl.hidden = true; tabsEl.hidden = true; titleEl.textContent = 'NetBoost';
    return home();
  }
  backEl.hidden = false; tabsEl.hidden = false;
  const tabs = state.sec === 'wifi' ? WIFI_TABS : PHONE_TABS;
  titleEl.textContent = state.sec === 'wifi' ? 'بوست و پاکسازی وای‌فای' : 'بوست و پاکسازی موبایل';
  tabsEl.innerHTML = tabs.map(t => `<button data-t="${t[0]}" class="${t[0] === state.tab ? 'on' : ''}">${t[1]}</button>`).join('');
  tabsEl.querySelectorAll('button').forEach(b => b.onclick = () => { state.tab = b.dataset.t; render(); });
  const pages = { wifi: { analyze: pAnalyze, speed: pSpeed, dns: pDns, auto: pAuto, guide: pGuide },
                  phone: { quick: pQuick, files: pFiles, ram: pRam, cache: pCache, battery: pBattery } };
  pages[state.sec][state.tab]();
}

function home() {
  view.innerHTML = `
    <div class="hero">
      <button class="door w" id="gw"><strong>بوست و پاکسازی وای‌فای</strong><span>تحلیل سیگنال و شلوغی کانال، تست سرعت و Bufferbloat، بهترین DNS، پایش ساعتی</span></button>
      <button class="door p" id="gp"><strong>بوست و پاکسازی موبایل</strong><span>فایل‌های تکراری و زائد، رم، کش برنامه‌ها، دما و باتری</span></button>
    </div>
    <p class="dim" style="margin-top:18px">هر بخش فقط کارهایی رو انجام میده که اندروید به یه برنامه معمولی اجازه میده؛ جاهایی که لازمه خودت تایید کنی یا تنظیمات سیستم رو باز کنی، صریح گفته شده.</p>`;
  $('#gw').onclick = () => go('wifi'); $('#gp').onclick = () => go('phone');
}

/* ============================================================ WIFI */
const DNS_LIST = [
  { n: 'Cloudflare', ip: ['1.1.1.1', '1.0.0.1'], dot: 'one.one.one.one' },
  { n: 'Google', ip: ['8.8.8.8', '8.8.4.4'], dot: 'dns.google' },
  { n: 'Quad9', ip: ['9.9.9.9', '149.112.112.112'], dot: 'dns.quad9.net' },
  { n: 'شکن', ip: ['178.22.122.100', '185.51.200.2'] },
  { n: 'الکترو', ip: ['78.157.42.100', '78.157.42.101'] },
  { n: 'رادار', ip: ['10.202.10.10', '10.202.10.11'] }
];

function bestChannel(list, is24, info) {
  const cand = is24 ? [1, 6, 11] : [36, 40, 44, 48, 149, 153, 157, 161];
  const pool = list.filter(a => (a.freq < 3000) === is24 && a.bssid !== info.bssid && a.rssi > -90);
  const load = c => pool.reduce((s, a) => {
    const d = Math.abs(a.channel - c);
    const w = is24 ? (d < 5 ? 1 - d / 5 : 0) : (d === 0 ? 1 : 0);
    return s + w * Math.max(0, a.rssi + 100);
  }, 0);
  const loads = cand.map(c => ({ c, l: Math.round(load(c)) }));
  loads.sort((a, b) => a.l - b.l);
  return { best: loads[0], cur: { c: info.channel, l: Math.round(load(info.channel)) }, pool };
}

function analyze(info, list, gw, net) {
  const is24 = info.freq < 3000;
  const tips = []; let score = 100;
  const add = (lvl, txt) => tips.push([lvl, txt]);
  const r = info.rssi;
  if (r <= -80) { score -= 45; add('bad', `سیگنال خیلی ضعیفه (${r} dBm). به مودم نزدیک‌تر شو یا مودم رو بالاتر و بدون مانع بذار.`); }
  else if (r <= -70) { score -= 28; add('warn', `سیگنال متوسط‌ضعیفه (${r} dBm). دیوار و آینه و کابینت سیگنال رو می‌خورن.`); }
  else if (r <= -60) { score -= 10; add('warn', `سیگنال قابل‌قبوله (${r} dBm) ولی بهتر هم میشه.`); }
  else add('ok', `سیگنال عالیه (${r} dBm).`);

  const bc = bestChannel(list, is24, info);
  const others = bc.pool;
  const same = others.filter(a => a.channel === info.channel).length;
  const adj = is24 ? others.filter(a => a.channel !== info.channel && Math.abs(a.channel - info.channel) <= 4).length : 0;
  score -= Math.min(25, same * 6) + Math.min(15, adj * 2);
  if (same + adj > 0) add(same > 2 ? 'bad' : 'warn', `روی کانال ${info.channel} تعداد ${same} شبکه هم‌کانال و ${adj} شبکه هم‌پوشان هست.`);
  else if (list.length) add('ok', `کانال ${info.channel} خلوته.`);
  if (bc.best && bc.best.c !== info.channel && bc.best.l + 10 < bc.cur.l) {
    add('warn', `پیشنهاد: توی پنل مودم کانال ${is24 ? 'رو' : ''} ${bc.best.c} بذار (شلوغی ${bc.best.l} در برابر ${bc.cur.l} فعلی).`);
  }
  if (is24) {
    add('warn', 'پهنای باند 2.4GHz رو روی 20MHz بذار تا هم‌پوشانی کمتر بشه.');
    if (r > -65) add('warn', 'سیگنالت خوبه؛ اگه گوشی پشتیبانی می‌کنه به باند 5GHz وصل شو، معمولاً خلوت‌تر و سریع‌تره.');
  }
  if (gw && gw.avg >= 0) {
    if (gw.avg > 25) { score -= 20; add('bad', `پینگ تا خود مودم ${gw.avg.toFixed(0)}ms ـه؛ مشکل از وای‌فای/تداخله، نه اینترنت.`); }
    else if (gw.avg > 10) { score -= 8; add('warn', `پینگ تا مودم ${gw.avg.toFixed(0)}ms (کمی بالا).`); }
    if (gw.loss > 5) { score -= 15; add('bad', `${gw.loss.toFixed(0)}٪ از بسته‌ها تا مودم گم میشن.`); }
  }
  if (net && net.avg >= 0) {
    if (net.avg > 150) { score -= 12; add('warn', `پینگ اینترنت ${net.avg.toFixed(0)}ms ـه.`); }
    if (gw && gw.avg >= 0 && net.avg - gw.avg > 100) add('warn', 'فاصله پینگ مودم و اینترنت زیاده؛ گلوگاه سمت خط/ISP ـه.');
  } else add('bad', 'پینگ اینترنت جواب نداد (اینترنت قطعه یا ICMP بسته‌ست).');
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, tips, bc, same, adj, is24 };
}

async function pAnalyze() {
  view.innerHTML = `
    <div class="card"><h2>تحلیل سلامت وای‌فای</h2>
    <p class="dim">سیگنال، کانال و شلوغی اطراف، تاخیر تا مودم و اینترنت رو می‌سنجه و کارهای مشخص پیشنهاد میده.</p>
    <button class="big" id="run">شروع تحلیل</button></div><div id="out"></div>`;
  $('#run').onclick = async () => {
    const res = await work('در حال اسکن و سنجش...', async () => {
      if (!await perm('wifi')) return null;
      const info = await NB.wifiInfo();
      if (!info.connected) { toast('به وای‌فای وصل نیستی'); return null; }
      const scanP = NB.wifiScan().catch(() => ({ list: [], err: true }));
      const gwP = (info.gateway && info.gateway !== '0.0.0.0') ? NB.ping({ host: info.gateway, count: 5 }) : Promise.resolve(null);
      const netP = NB.ping({ host: '1.1.1.1', count: 5 });
      const [scan, gw, net] = await Promise.all([scanP, gwP, netP]);
      return { info, scan, gw, net, an: analyze(info, scan.list || [], gw, net) };
    });
    if (!res) return;
    const { info, scan, gw, net, an } = res;
    const verdict = an.score >= 75 ? 'خوب' : an.score >= 50 ? 'متوسط' : 'ضعیف';
    const hidden = /unknown/i.test(info.ssid || '');
    let chart = '';
    if (scan.list && scan.list.length) {
      const chans = an.is24 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] : [...new Set([...an.bc.pool.map(a => a.channel), info.channel, 36, 40, 44, 48, 149, 153, 157, 161])].sort((a, b) => a - b);
      const cnt = c => an.bc.pool.filter(a => a.channel === c).length + (c === info.channel ? 1 : 0);
      const mx = Math.max(1, ...chans.map(cnt));
      chart = `<div class="card"><h2>شلوغی کانال‌ها (${an.is24 ? '2.4GHz' : '5GHz'})</h2>
        <div class="chs">${chans.map(c => `<div class="c ${c === info.channel ? 'me' : ''} ${an.bc.best && c === an.bc.best.c ? 'best' : ''}"><div class="bar" style="height:${Math.round(cnt(c) / mx * 80)}%"></div>${c}</div>`).join('')}</div>
        <p class="dim">سبز: کانال تو • زرد: کانال پیشنهادی • ${scan.list.length} شبکه پیدا شد</p></div>`;
    } else {
      chart = `<div class="card"><h2>اسکن شبکه‌های اطراف</h2><p class="warn">لیستی برنگشت. مطمئن شو سرویس Location (GPS) گوشی روشنه.</p><button class="sm" id="loc">باز کردن تنظیمات Location</button></div>`;
    }
    $('#out').innerHTML = `
      <div class="card">${ring(an.score, verdict)}
        <div class="row"><span>شبکه</span><b>${esc(hidden ? 'نامشخص (Location خاموشه)' : info.ssid)}</b></div>
        <div class="row"><span>باند / کانال</span><b>${an.is24 ? '2.4GHz' : '5GHz'} / ${info.channel}</b></div>
        <div class="row"><span>سیگنال</span><b>${info.rssi} dBm</b></div>
        <div class="row"><span>سرعت لینک</span><b>${info.linkSpeed} Mbps</b></div>
        <div class="row"><span>IP / مودم</span><b>${esc(info.ip)} / ${esc(info.gateway)}</b></div>
        <div class="row"><span>DNS فعلی</span><b>${esc(info.dns1)}</b></div>
        <div class="row"><span>پینگ تا مودم</span><b>${gw && gw.avg >= 0 ? gw.avg.toFixed(1) + ' ms' : '—'}</b></div>
        <div class="row"><span>پینگ اینترنت / جیتر</span><b>${net && net.avg >= 0 ? net.avg.toFixed(0) + ' / ' + net.jitter.toFixed(1) + ' ms' : '—'}</b></div>
      </div>
      <div class="card"><h2>کارهای پیشنهادی</h2><ul class="tips">${an.tips.map(t => `<li class="${t[0]}">${esc(t[1])}</li>`).join('')}</ul></div>
      ${chart}`;
    const l = $('#loc'); if (l) l.onclick = () => NB.openSettings({ type: 'location' });
  };
}

/* ---- speed test */
function grade(ms) { return ms < 20 ? ['A', 'ok'] : ms < 50 ? ['B', 'ok'] : ms < 100 ? ['C', 'warn'] : ms < 200 ? ['D', 'bad'] : ['F', 'bad']; }

async function runDownload(base, seconds, onLoaded) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), seconds * 1000);
  let bytes = 0, t0 = 0, stop = false;
  const loadedPings = [];
  (async () => {
    while (!stop) { const p = await NB.ping({ host: '1.1.1.1', count: 3 }); if (p.avg >= 0 && !stop) loadedPings.push(p.avg); }
  })();
  try {
    const resp = await fetch(base + '/__down?bytes=200000000&r=' + Date.now(), { signal: ctl.signal, cache: 'no-store' });
    const rd = resp.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      if (!t0) t0 = performance.now();
      bytes += value.length;
      if (onLoaded) onLoaded(bytes);
    }
  } catch (e) { if (e.name !== 'AbortError') { stop = true; clearTimeout(timer); throw e; } }
  stop = true; clearTimeout(timer);
  const sec = t0 ? (performance.now() - t0) / 1000 : 0;
  const mbps = sec > 0.5 ? bytes * 8 / 1e6 / sec : 0;
  const lp = loadedPings.length ? loadedPings.reduce((a, b) => a + b, 0) / loadedPings.length : -1;
  return { mbps, loaded: lp };
}

async function runUpload(base) {
  const blob = new Blob([new Uint8Array(3 * 1024 * 1024)]);
  let best = 0;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await fetch(base + '/__up', { method: 'POST', body: blob, cache: 'no-store' });
    const sec = (performance.now() - t) / 1000;
    best = Math.max(best, 3 * 8 / sec);
  }
  return best;
}

function pSpeed() {
  const base = localStorage.getItem('srv') || 'https://speed.cloudflare.com';
  const hist = JSON.parse(localStorage.getItem('speedHist') || '[]');
  view.innerHTML = `
    <div class="card"><h2>تست سرعت و Bufferbloat</h2>
    <p class="dim">پینگ بدون بار، دانلود، آپلود و پینگ زیر بار رو می‌سنجه. اختلاف پینگ زیر بار با پینگ عادی همون «شلوغی خط»ـه.</p>
    <button class="big" id="run">شروع تست (حدود ۳۰ ثانیه)</button>
    <p class="dim">سرور تست:</p><input type="text" id="srv" value="${esc(base)}" dir="ltr">
    <p class="dim">اگه از سرور داخلی/دیگه‌ای که مسیر /__down و /__up رو داره استفاده می‌کنی، آدرسش رو اینجا بذار.</p></div>
    <div id="out"></div>
    <div class="card"><h2>تاریخچه تست‌ها</h2>${hist.length ? hist.slice().reverse().slice(0, 10).map(h => `<div class="row"><span>${new Date(h.t).toLocaleString('fa-IR')}</span><b>↓${h.down.toFixed(0)} ↑${h.up.toFixed(0)} • ${h.idle.toFixed(0)}ms</b></div>`).join('') : '<p class="dim">هنوز تستی نگرفتی.</p>'}</div>`;
  $('#run').onclick = async () => {
    const srv = $('#srv').value.trim().replace(/\/$/, ''); localStorage.setItem('srv', srv);
    const r = await work('پینگ بدون بار...', async () => {
      const idle = await NB.ping({ host: '1.1.1.1', count: 6 });
      setBusy('در حال دانلود و سنجش پینگ زیر بار...');
      const dl = await runDownload(srv, 8, b => setBusy('دانلود... ' + fmtB(b)));
      setBusy('در حال آپلود...');
      let up = 0; try { up = await runUpload(srv); } catch (e) { up = 0; }
      return { idle, dl, up };
    });
    if (!r) return;
    if (!r.dl.mbps) { toast('سرور تست جواب نداد؛ آدرس سرور رو عوض کن یا فیلترشکن رو چک کن'); return; }
    const idleMs = r.idle.avg >= 0 ? r.idle.avg : 0;
    const delta = r.dl.loaded >= 0 ? Math.max(0, r.dl.loaded - idleMs) : -1;
    const g = delta >= 0 ? grade(delta) : ['?', 'warn'];
    $('#out').innerHTML = `<div class="card"><div class="grid2">
      <div class="stat"><b>${r.dl.mbps.toFixed(1)}</b><small>دانلود Mbps</small></div>
      <div class="stat"><b>${r.up ? r.up.toFixed(1) : '—'}</b><small>آپلود Mbps</small></div>
      <div class="stat"><b>${idleMs.toFixed(0)}</b><small>پینگ بدون بار ms</small></div>
      <div class="stat"><b>${r.dl.loaded >= 0 ? r.dl.loaded.toFixed(0) : '—'}</b><small>پینگ زیر بار ms</small></div></div>
      <div class="row"><span>جیتر</span><b>${r.idle.jitter.toFixed(1)} ms</b></div>
      <div class="row"><span>افت بسته</span><b>${r.idle.loss.toFixed(0)}٪</b></div>
      <div class="row"><span>نمره Bufferbloat</span><b class="${g[1]}">${g[0]} ${delta >= 0 ? '(+' + delta.toFixed(0) + 'ms)' : ''}</b></div>
      <p class="dim">${g[0] >= 'C' && g[0] !== '?' ? 'خط زیر بار شلوغ میشه. توی مودم QoS/Smart Queue رو فعال کن و سرعت رو کمی کمتر از سرعت واقعی خط محدود کن.' : 'خط زیر بار خوب جواب میده.'}</p></div>`;
    hist.push({ t: Date.now(), down: r.dl.mbps, up: r.up, idle: idleMs, bloat: delta });
    localStorage.setItem('speedHist', JSON.stringify(hist.slice(-50)));
  };
}

/* ---- DNS */
async function pDns() {
  view.innerHTML = `<div class="card"><h2>بنچمارک DNS</h2>
    <p class="dim">سرعت پاسخ‌گویی چند DNS معروف روی همین شبکه رو می‌سنجه. DNS سریع‌تر یعنی باز شدن سریع‌تر سایت‌ها.</p>
    <button class="big" id="run">شروع بنچمارک</button></div><div id="out"></div>`;
  $('#run').onclick = async () => {
    const res = await work('در حال سنجش DNSها...', async () => {
      const info = await NB.wifiInfo();
      const list = DNS_LIST.map(d => ({ ...d }));
      if (info.dns1 && info.dns1 !== '0.0.0.0') list.push({ n: 'DNS فعلی شبکه', ip: [info.dns1] });
      const r = await NB.dnsBench({ servers: list.map(d => d.ip[0]) });
      list.forEach((d, i) => { d.ms = r.list[i].ms; d.fail = r.list[i].fail; });
      return list;
    });
    if (!res) return;
    res.sort((a, b) => (a.ms < 0) - (b.ms < 0) || a.ms - b.ms);
    const best = res.find(d => d.dot && d.ms >= 0);
    $('#out').innerHTML = `<div class="card"><h2>نتیجه</h2>${res.map(d => `
      <div class="item"><div class="t"><div><b>${esc(d.n)}</b> <span class="dim" dir="ltr">${esc(d.ip.join(' / '))}</span></div>
      <div class="${d.ms < 0 ? 'bad' : d.ms < 40 ? 'ok' : 'warn'}">${d.ms < 0 ? 'جواب نداد' : d.ms.toFixed(0) + ' ms'}${d.fail ? ' • ' + d.fail + ' خطا' : ''}</div></div>
      ${d.dot && d.ms >= 0 ? `<button class="sm" data-dot="${esc(d.dot)}">اعمال</button>` : ''}</div>`).join('')}
      ${best ? `<button class="big" id="auto">تنظیم سریع‌ترین (${esc(best.n)}) به‌صورت Private DNS</button>` : ''}
      <p class="dim">«اعمال» از Private DNS اندروید (DoT) استفاده می‌کنه که فقط برای Cloudflare/Google/Quad9 هست. شکن، الکترو و رادار DoT ندارن؛ آی‌پی‌شون رو دستی توی تنظیمات وای‌فای (DNS 1 و 2، حالت IP استاتیک) بذار.</p>
      <div id="adb"></div></div>`;
    const apply = async host => {
      const r = await NB.setPrivateDns({ host, mode: 'hostname' });
      if (r.ok) toast('Private DNS روی ' + host + ' تنظیم شد');
      else $('#adb').innerHTML = `<p class="warn">اندروید اجازه نمیده برنامه خودش DNS رو عوض کنه، مگه اینکه یه بار این دستور رو با ADB (کامپیوتر یا Wireless debugging) بزنی:</p>
        <code>adb shell pm grant ${ADB_PKG} android.permission.WRITE_SECURE_SETTINGS</code>
        <button class="sm" id="cp">کپی دستور</button>
        <p class="dim">یا دستی: تنظیمات ← اتصالات/شبکه ← Private DNS ← Hostname: <b dir="ltr">${esc(host)}</b></p>`;
      const c = $('#cp'); if (c) c.onclick = () => copy('adb shell pm grant ' + ADB_PKG + ' android.permission.WRITE_SECURE_SETTINGS');
    };
    view.querySelectorAll('[data-dot]').forEach(b => b.onclick = () => apply(b.dataset.dot));
    const a = $('#auto'); if (a) a.onclick = () => apply(best.dot);
  };
}

/* ---- auto monitoring */
async function pAuto() {
  const on = localStorage.getItem('auto') === '1';
  const h = (await NB.getHistory()).list || [];
  const last = h.slice(-24);
  const mx = Math.max(50, ...last.map(x => x.net));
  const byHour = {};
  h.forEach(x => { if (x.net >= 0) { const k = new Date(x.t).getHours(); (byHour[k] = byHour[k] || []).push(x.net); } });
  const hours = Object.keys(byHour).map(k => [Number(k), byHour[k].reduce((a, b) => a + b, 0) / byHour[k].length]).sort((a, b) => b[1] - a[1]);
  view.innerHTML = `
    <div class="card"><h2>پایش خودکار هر یک ساعت</h2>
    <p class="dim">هر ساعت در پس‌زمینه سیگنال، پینگ مودم و پینگ اینترنت ثبت میشه تا ساعت‌های شلوغ و افت خط مشخص بشه. (اندروید ممکنه بسته به باتری‌سازی کمی دیر اجرا کنه؛ برای NetBoost بهینه‌سازی باتری رو بردار.)</p>
    <button class="big ${on ? 'danger' : ''}" id="tg">${on ? 'خاموش کردن پایش' : 'روشن کردن پایش ساعتی'}</button>
    <button class="sm" id="bat">تنظیمات بهینه‌سازی باتری</button></div>
    <div class="card"><h2>پینگ اینترنت (۲۴ ثبت آخر)</h2>
    ${last.length ? `<div class="chs">${last.map(x => `<div class="c"><div class="bar" style="height:${x.net < 0 ? 100 : Math.max(4, Math.round(x.net / mx * 100))}%;background:${x.net < 0 ? 'var(--bad)' : x.net > 150 ? 'var(--warn)' : 'var(--ok)'}"></div></div>`).join('')}</div>` : '<p class="dim">هنوز داده‌ای ثبت نشده.</p>'}
    ${hours.length > 2 ? `<p>شلوغ‌ترین ساعت: <b>${hours[0][0]}:00</b> (میانگین ${hours[0][1].toFixed(0)}ms) • خلوت‌ترین: <b>${hours[hours.length - 1][0]}:00</b> (${hours[hours.length - 1][1].toFixed(0)}ms)</p>` : ''}
    ${h.length ? '<button class="sm" id="clr">پاک کردن تاریخچه</button>' : ''}</div>`;
  $('#tg').onclick = async () => {
    if (!on && !await perm('wifi')) return;
    await NB.scheduleAuto({ enabled: !on, minutes: 60 });
    localStorage.setItem('auto', on ? '0' : '1');
    toast(on ? 'پایش خاموش شد' : 'پایش ساعتی روشن شد'); pAuto();
  };
  $('#bat').onclick = () => NB.openSettings({ type: 'battery' });
  const c = $('#clr'); if (c) c.onclick = async () => { await NB.clearHistory(); pAuto(); };
}

/* ---- guide */
function pGuide() {
  view.innerHTML = `
    <div class="card"><h2>تنظیمات پیشنهادی مودم</h2><ul class="tips">
      <li>2.4GHz: کانال ثابت ۱ یا ۶ یا ۱۱ (نه Auto)، پهنا ۲۰MHz.</li>
      <li>5GHz: کانال خلوت مثل ۳۶ تا ۴۸ یا ۱۴۹ به بالا، پهنا ۴۰ یا ۸۰MHz.</li>
      <li>اسم دو باند رو جدا بذار تا خودت انتخاب کنی چی وصل بشه.</li>
      <li>دو مودم (یوتل و دی‌لینک) رو روی کانال‌های متفاوت بذار تا با هم تداخل نکنن؛ مثلاً یکی ۱ و دیگری ۱۱.</li>
      <li>اگه مودم QoS یا Smart Queue داره، فعالش کن و حدود ۹۰٪ سرعت واقعی خط رو سقف بذار.</li></ul></div>
    <div class="card"><h2>فیلترشکن فقط برای یک شبکه</h2><ul class="tips">
      <li>ساده: فیلترشکن روی موبایل، تبلت به هات‌اسپات موبایل وصل بشه.</li>
      <li>دائمی: یه روتر جدا با OpenWrt یا GL.iNet پشت مودم یوتل، با وای‌فای جداگانه برای دستگاه‌هایی که فیلترشکن می‌خوان. بقیه به وای‌فای عادی.</li>
      <li>مودم دی‌لینک ADSL معمولاً کلاینت VPN نداره؛ فقط به‌عنوان خط دوم استفاده کن.</li></ul></div>
    <div class="card"><h2>مقایسه دو خط</h2><p class="dim">به هر مودم وصل شو، توی «تحلیل» و «تست سرعت» نتیجه رو ببین و مقایسه کن. تست‌ها توی تاریخچه می‌مونن.</p>
    <button class="sm" id="w">انتخاب شبکه وای‌فای</button></div>`;
  $('#w').onclick = () => NB.openSettings({ type: 'wifi' });
}

/* ============================================================ PHONE */
async function loadApps() {
  if (state.apps) return state.apps;
  const r = await NB.listApps({ system: false });
  state.apps = r.list.sort((a, b) => a.name.localeCompare(b.name));
  if (!state.keep) {
    state.keep = state.apps.filter(a => /inputmethod|keyboard|launcher|dialer|telecom|messaging|mms/i.test(a.pkg)).map(a => a.pkg);
    localStorage.setItem('keep', JSON.stringify(state.keep));
  }
  return state.apps;
}
async function killNow() {
  const apps = await loadApps();
  const pk = apps.filter(a => !state.keep.includes(a.pkg)).map(a => a.pkg);
  return NB.killApps({ pkgs: pk });
}

async function pQuick() {
  const d = await NB.deviceInfo();
  const ramUsed = Math.round((1 - d.ramFree / d.ramTotal) * 100), diskUsed = Math.round((1 - d.diskFree / d.diskTotal) * 100);
  view.innerHTML = `
    <div class="card"><h2>پاکسازی یک‌ضربه‌ای</h2>
    <div class="row"><span>رم آزاد</span><b>${fmtB(d.ramFree)} از ${fmtB(d.ramTotal)}</b></div><div class="bar2"><i style="width:${ramUsed}%"></i></div>
    <div class="row"><span>حافظه آزاد</span><b>${fmtB(d.diskFree)} از ${fmtB(d.diskTotal)}</b></div><div class="bar2"><i style="width:${diskUsed}%"></i></div>
    <div class="row"><span>دمای باتری</span><b>${d.temp}°C</b></div>
    <button class="big" id="go">بستن برنامه‌های پس‌زمینه + پاک کردن کش NetBoost</button>
    <p class="dim">برنامه‌های «نگه‌داشتن» رو توی تب «رم و CPU» تنظیم کن. فایل‌ها و کش برنامه‌ها توی تب‌های خودشون هستن چون نیاز به تایید تو دارن.</p></div><div id="out"></div>`;
  $('#go').onclick = async () => {
    const r = await work('در حال پاکسازی...', async () => {
      const k = await killNow(); const c = await NB.cleanSelf();
      return { k, c };
    });
    if (!r) return;
    $('#out').innerHTML = `<div class="card"><h2>انجام شد</h2>
      <div class="row"><span>برنامه‌های بسته‌شده (درخواست)</span><b>${r.k.count}</b></div>
      <div class="row"><span>رم آزادشده</span><b>${fmtB(r.k.freed)}</b></div>
      <div class="row"><span>کش NetBoost</span><b>${fmtB(r.c.freed)}</b></div>
      <p class="dim">بعضی برنامه‌ها خودشون دوباره بالا میان؛ برای اونا «توقف اجباری» از تنظیمات برنامه موثرتره.</p></div>`;
  };
}

/* ---- files */
const thumbQ = []; let thumbBusy = 0;
function loadThumb(img, id, type) {
  thumbQ.push({ img, id, type }); pumpThumbs();
}
function pumpThumbs() {
  while (thumbBusy < 3 && thumbQ.length) {
    const t = thumbQ.shift(); thumbBusy++;
    NB.thumb({ id: t.id, type: t.type }).then(r => { if (r && r.data) t.img.src = r.data; }).catch(() => {}).finally(() => { thumbBusy--; pumpThumbs(); });
  }
}

function pFiles() {
  view.innerHTML = `
    <div class="card"><h2>فایل‌های تکراری و زائد</h2>
    <p class="dim">عکس و ویدیوی تکراری (با مقایسه محتوا، نه فقط اسم)، فایل‌های موقت، APK و اسکرین‌شات‌ها. تیک‌ها دست خودته.</p>
    <button class="big" id="scan">اسکن</button><div id="cap"></div></div><div id="out"></div>`;
  NB.capabilities().then(c => {
    if (!c.allFiles) $('#cap').innerHTML = `<p class="dim">حذف بدون پرسیدن سیستم: اگه «دسترسی به همه فایل‌ها» رو بدی، حذف مستقیم انجام میشه و پوشه‌های خالی هم پیدا میشن. وگرنه اندروید برای هر حذف یه تاییدیه نشون میده.</p><button class="sm" id="af">دادن دسترسی همه فایل‌ها</button>`;
    const a = $('#af'); if (a) a.onclick = () => NB.openSettings({ type: 'allfiles' });
  });
  $('#scan').onclick = async () => {
    const r = await work('در حال اسکن فایل‌ها (ممکنه چند دقیقه طول بکشه)...', async () => {
      if (!await perm('media')) return null;
      return NB.scanMedia();
    });
    if (!r) return;
    state.files = r; renderFiles();
  };
}

function renderFiles() {
  const r = state.files;
  const cats = [];
  const dupItems = [];
  r.groups.forEach((g, gi) => g.forEach((it, i) => dupItems.push({ ...it, g: gi, keep: i === 0 })));
  cats.push({ k: 'dup', t: 'تکراری‌ها', note: 'قدیمی‌ترین نسخه هر گروه نگه داشته میشه', items: dupItems, def: it => !it.keep, bytes: r.dupBytes, group: true });
  cats.push({ k: 'tmp', t: 'فایل‌های موقت و زائد', note: '.tmp .log .bak thumbnails ...', items: r.temps, def: () => true, bytes: r.tempBytes });
  cats.push({ k: 'apk', t: 'فایل‌های APK', note: 'نصب‌کننده‌های قدیمی', items: r.apks, def: () => false, bytes: r.apkBytes });
  cats.push({ k: 'shot', t: 'اسکرین‌شات‌ها و ضبط صفحه', note: 'اختیاری', items: r.shots, def: () => false, bytes: r.shotBytes });
  cats.push({ k: 'big', t: 'ویدیوهای حجیم (بالای ۱۰۰MB)', note: 'اختیاری', items: r.bigs, def: () => false, bytes: r.bigBytes });
  let html = `<div class="card"><p>${r.scanned} فایل بررسی شد. <b id="sel">0 B</b> انتخاب شده.</p><button class="big danger" id="del">حذف موارد تیک‌خورده</button></div>`;
  cats.forEach(c => {
    html += `<div class="card"><h2>${c.t} <span class="tag">${c.items.length} مورد • ${fmtB(c.bytes)}</span></h2><p class="dim">${c.note}</p>`;
    if (!c.items.length) html += '<p class="dim">چیزی پیدا نشد.</p>';
    else {
      html += `<label class="item"><input type="checkbox" data-all="${c.k}"><div class="t">انتخاب همه</div></label>`;
      let lastG = -1;
      c.items.forEach((it, i) => {
        if (c.group && it.g !== lastG) { lastG = it.g; html += `<div class="dim" style="margin-top:8px">گروه ${it.g + 1}</div>`; }
        const media = it.type === 1 || it.type === 3;
        html += `<label class="item"><input type="checkbox" class="cb" data-c="${c.k}" data-i="${i}" ${c.def(it) ? 'checked' : ''}>
          ${media ? `<img data-id="${it.id}" data-type="${it.type}" alt="">` : '<div class="ph"></div>'}
          <div class="t"><div>${esc(it.name)}</div><div class="dim" dir="ltr">${fmtB(it.size)}${it.keep ? ' • نگه داشته میشه' : ''}</div></div></label>`;
      });
    }
    html += '</div>';
  });
  html += `<div class="card"><h2>پوشه‌های خالی</h2><button class="sm" id="ef">اسکن پوشه‌های خالی</button><div id="efo"></div></div>`;
  $('#out').innerHTML = html;
  const map = {}; cats.forEach(c => map[c.k] = c);
  const upd = () => {
    let s = 0;
    view.querySelectorAll('.cb:checked').forEach(cb => { s += map[cb.dataset.c].items[+cb.dataset.i].size; });
    $('#sel').textContent = fmtB(s);
  };
  view.querySelectorAll('.cb').forEach(cb => cb.onchange = upd);
  view.querySelectorAll('[data-all]').forEach(a => a.onchange = () => {
    view.querySelectorAll(`.cb[data-c="${a.dataset.all}"]`).forEach(cb => { cb.checked = a.checked; }); upd();
  });
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { loadThumb(e.target, +e.target.dataset.id, +e.target.dataset.type); io.unobserve(e.target); } }));
  view.querySelectorAll('img[data-id]').forEach(i => io.observe(i));
  upd();
  $('#del').onclick = async () => {
    const sel = [];
    view.querySelectorAll('.cb:checked').forEach(cb => { const it = map[cb.dataset.c].items[+cb.dataset.i]; if (!sel.find(x => x.id === it.id)) sel.push(it); });
    if (!sel.length) return toast('چیزی انتخاب نشده');
    if (!confirm(sel.length + ' فایل حذف بشه؟ این کار قابل بازگشت نیست.')) return;
    const res = await work('در حال حذف...', () => NB.deleteMedia({ ids: sel.map(x => x.id), paths: sel.map(x => x.path), sizes: sel.map(x => x.size) }));
    if (!res) return;
    if (res.cancelled) return toast('حذف لغو شد');
    toast(res.deleted + ' فایل حذف شد • ' + fmtB(res.freed) + ' آزاد شد');
    const gone = new Set(sel.map(x => x.id));
    state.files.groups = state.files.groups.map(g => g.filter(x => !gone.has(x.id))).filter(g => g.length > 1);
    ['temps', 'apks', 'shots', 'bigs'].forEach(k => { state.files[k] = state.files[k].filter(x => !gone.has(x.id)); });
    state.files.dupBytes = 0; state.files.groups.forEach(g => { state.files.dupBytes += g[0].size * (g.length - 1); });
    state.files.tempBytes = state.files.temps.reduce((a, b) => a + b.size, 0);
    state.files.apkBytes = state.files.apks.reduce((a, b) => a + b.size, 0);
    state.files.shotBytes = state.files.shots.reduce((a, b) => a + b.size, 0);
    state.files.bigBytes = state.files.bigs.reduce((a, b) => a + b.size, 0);
    renderFiles();
  };
  $('#ef').onclick = async () => {
    const e = await work('اسکن پوشه‌ها...', () => NB.scanEmptyFolders().catch(() => { toast('اول «دسترسی همه فایل‌ها» رو بده'); return null; }));
    if (!e) return;
    if (!e.list.length) { $('#efo').innerHTML = '<p class="dim">پوشه خالی پیدا نشد.</p>'; return; }
    $('#efo').innerHTML = e.list.map((p, i) => `<label class="item"><input type="checkbox" class="ecb" data-p="${esc(p)}" checked><div class="t"><div dir="ltr">${esc(p.replace('/storage/emulated/0/', ''))}</div></div></label>`).join('') + '<button class="sm danger" id="efd">حذف پوشه‌های تیک‌خورده</button>';
    $('#efd').onclick = async () => {
      const ps = [...view.querySelectorAll('.ecb:checked')].map(c => c.dataset.p);
      const d = await NB.deleteFolders({ paths: ps }); toast(d.deleted + ' پوشه حذف شد'); $('#efo').innerHTML = '';
    };
  };
}

/* ---- RAM / CPU */
async function pRam() {
  const d = await NB.deviceInfo();
  const apps = await loadApps();
  const th = ['عادی', 'کمی گرم', 'گرم', 'خیلی گرم', 'بحرانی', 'اضطراری', 'خاموشی'][d.thermal] || 'نامشخص';
  const ramUsed = Math.round((1 - d.ramFree / d.ramTotal) * 100);
  view.innerHTML = `
    <div class="card"><h2>رم و پردازنده</h2>
    <div class="row"><span>رم</span><b>${fmtB(d.ramFree)} آزاد از ${fmtB(d.ramTotal)}</b></div><div class="bar2"><i style="width:${ramUsed}%"></i></div>
    <div class="row"><span>وضعیت حرارتی</span><b class="${d.thermal >= 3 ? 'bad' : d.thermal === 2 ? 'warn' : 'ok'}">${th}</b></div>
    <div class="row"><span>دمای باتری</span><b>${d.temp}°C</b></div>
    <button class="big" id="cool">آزادسازی رم و خنک‌سازی</button>
    <p class="dim">گوشی رو نمیشه با نرم‌افزار «سرد» کرد؛ تنها کار واقعی، بستن برنامه‌های پرمصرف پس‌زمینه‌ست که فشار CPU رو کم می‌کنه. کنارش: روشنایی کمتر، درآوردن قاب، و قطع شارژ سریع موقع بازی.</p></div>
    <div class="card"><h2>برنامه‌هایی که بسته بشن</h2><p class="dim">تیک = بسته میشه. بدون تیک = نگه داشته میشه.</p>
    ${apps.map(a => `<label class="item"><input type="checkbox" class="ak" data-p="${esc(a.pkg)}" ${state.keep.includes(a.pkg) ? '' : 'checked'}><div class="t"><div>${esc(a.name)}</div><div class="dim" dir="ltr">${esc(a.pkg)}</div></div><button class="sm" data-fs="${esc(a.pkg)}">توقف</button></label>`).join('')}</div>`;
  view.querySelectorAll('.ak').forEach(c => c.onchange = () => {
    const p = c.dataset.p;
    state.keep = state.keep.filter(x => x !== p); if (!c.checked) state.keep.push(p);
    localStorage.setItem('keep', JSON.stringify(state.keep));
  });
  view.querySelectorAll('[data-fs]').forEach(b => b.onclick = e => { e.preventDefault(); NB.openSettings({ type: 'app', pkg: b.dataset.fs }); });
  $('#cool').onclick = async () => {
    const r = await work('در حال بستن برنامه‌ها...', killNow);
    if (r) { toast(fmtB(r.freed) + ' رم آزاد شد'); pRam(); }
  };
}

/* ---- cache */
async function pCache() {
  const caps = await NB.capabilities();
  if (!caps.usageAccess) {
    view.innerHTML = `<div class="card"><h2>کش برنامه‌ها</h2>
      <p>برای دیدن حجم کش هر برنامه، اندروید «دسترسی به آمار استفاده» رو لازم داره.</p>
      <button class="big" id="ua">دادن دسترسی</button><button class="big sec" id="re">بررسی دوباره</button></div>`;
    $('#ua').onclick = () => NB.openSettings({ type: 'usage' }); $('#re').onclick = pCache;
    return;
  }
  view.innerHTML = '<div class="card"><p>در حال محاسبه...</p></div>';
  const r = await NB.appCacheSizes().catch(() => null);
  if (!r) { view.innerHTML = '<div class="card"><p class="bad">محاسبه کش ممکن نشد.</p></div>'; return; }
  r.list.sort((a, b) => b.cache - a.cache);
  view.innerHTML = `
    <div class="card"><h2>کش برنامه‌ها <span class="tag">${fmtB(r.total)}</span></h2>
    <p class="warn">اندروید از ۶ به بعد اجازه نمیده یه برنامه عادی کش برنامه‌های دیگه رو پاک کنه؛ این محدودیت سیستمیه نه ضعف NetBoost. دو راه واقعی داری:</p>
    <p><b>۱) همه کش‌ها یکجا (یک‌بار با ADB):</b></p>
    <code>adb shell pm trim-caches 999G</code><button class="sm" id="cp">کپی دستور</button>
    <p class="dim">از کامپیوتر یا با Wireless debugging گوشی (اندروید ۱۱+) اجرا میشه.</p>
    <p><b>۲) تکی:</b> روی «باز کردن» بزن ← Storage ← Clear cache. برنامه‌ها به ترتیب حجم کش:</p>
    <button class="sm" id="st">تنظیمات حافظه سیستم</button></div>
    <div class="card">${r.list.slice(0, 40).map(a => `<div class="item"><div class="t"><div>${esc(a.name)}</div><div class="dim" dir="ltr">${esc(a.pkg)}</div></div><b dir="ltr">${fmtB(a.cache)}</b><button class="sm" data-p="${esc(a.pkg)}">باز کردن</button></div>`).join('')}</div>`;
  $('#cp').onclick = () => copy('adb shell pm trim-caches 999G');
  $('#st').onclick = () => NB.openSettings({ type: 'storage' });
  view.querySelectorAll('[data-p]').forEach(b => b.onclick = () => NB.openSettings({ type: 'app', pkg: b.dataset.p }));
}

/* ---- battery */
async function pBattery() {
  const d = await NB.deviceInfo();
  const st = { 2: 'در حال شارژ', 3: 'در حال مصرف', 4: 'بدون شارژ', 5: 'پر' }[d.status] || 'نامشخص';
  const hl = { 2: 'خوب', 3: 'داغ شده', 4: 'خراب', 5: 'ولتاژ زیاد', 7: 'سرد' }[d.health] || 'نامشخص';
  const tips = [];
  if (d.temp >= 40) tips.push(['bad', 'باتری داغه؛ شارژ رو قطع کن، قاب رو دربیار و برنامه‌های سنگین رو ببند.']);
  if (d.battery <= 20 && !d.plugged) tips.push(['warn', 'شارژ کمه؛ حالت صرفه‌جویی باتری رو روشن کن.']);
  if (!d.powerSave) tips.push(['warn', 'حالت صرفه‌جویی باتری خاموشه.']);
  tips.push(['ok', 'برای عمر بیشتر باتری: بین ۲۰ تا ۸۰٪ نگهش دار، روشنایی رو خودکار بذار و Always-on display و GPS غیرضروری رو خاموش کن.']);
  view.innerHTML = `
    <div class="card">${ring(d.battery, 'باتری')}
    <div class="row"><span>وضعیت</span><b>${st}</b></div>
    <div class="row"><span>دما</span><b class="${d.temp >= 40 ? 'bad' : 'ok'}">${d.temp}°C</b></div>
    <div class="row"><span>سلامت</span><b>${hl}</b></div>
    <div class="row"><span>ولتاژ</span><b>${d.voltage} mV</b></div>
    <div class="row"><span>صرفه‌جویی</span><b>${d.powerSave ? 'روشن' : 'خاموش'}</b></div></div>
    <div class="card"><h2>پیشنهادها</h2><ul class="tips">${tips.map(t => `<li class="${t[0]}">${esc(t[1])}</li>`).join('')}</ul></div>
    <div class="card"><button class="big" id="k">بستن برنامه‌های پس‌زمینه</button>
    <button class="big sec" id="b">بهینه‌سازی باتری برنامه‌ها</button>
    <button class="big sec" id="s">حالت صرفه‌جویی باتری</button>
    <p class="dim">اندروید اجازه نمیده برنامه‌ای خودش تنظیمات باتری برنامه‌های دیگه رو عوض کنه؛ دکمه‌ها صفحه درست رو برات باز می‌کنن.</p></div>`;
  $('#k').onclick = async () => { const r = await work('در حال بستن...', killNow); if (r) toast(fmtB(r.freed) + ' رم آزاد شد'); };
  $('#b').onclick = () => NB.openSettings({ type: 'battery' });
  $('#s').onclick = () => NB.openSettings({ type: 'batterysaver' });
}

/* ------------------------------------------------------------ boot */
if (!NB) { view.innerHTML = '<div class="card"><p class="bad">این برنامه فقط داخل اپ اندروید کار می‌کنه.</p></div>'; }
else render();
