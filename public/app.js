'use strict';

/* ---------- константы и настройки по умолчанию ---------- */

const LS_CFG = 'wl.config.v1';
const LS_HIST = 'wl.history.v1';

const ROLE_LABEL = {
  wl: 'Белый список (должны работать)',
  out: 'Вне белого списка (при БС не работают)',
  info: 'Только показать (не влияет на вердикт)',
};
const ROLE_SHORT = { wl: 'БС', out: 'вне БС', info: 'инфо' };
const TYPE_LABEL = { url: 'Сайт', ip: 'IP', doh: 'DoH' };
const VERDICT_LABEL = { wl: 'БС включены', off: 'БС выключены', down: 'нет сети', mixed: 'неясно', none: '—' };
const VERDICT_TEXT = {
  wl: 'Доступны только ресурсы из белого списка.',
  off: 'Внешние ресурсы открываются, интернет полный.',
  down: 'Недоступно всё: и белый список, и внешние ресурсы. Проверьте подключение.',
  mixed: 'Часть ресурсов доступна, часть нет. Возможна точечная блокировка или нестабильная сеть.',
};

const I = (n, t, v) => ({ n, t, v });

function DEFAULTS() {
  return {
    v: 1,
    timeout: 5,
    auto: 0,
    autostart: true,
    dohName: 'example.com',
    groups: [
      {
        name: 'Из белого списка', role: 'wl', items: [
          I('Яндекс', 'url', 'https://ya.ru/'),
          I('Госуслуги', 'url', 'https://www.gosuslugi.ru/'),
          I('VK', 'url', 'https://vk.com/'),
          I('MAX', 'url', 'https://max.ru/'),
          I('Дзен', 'url', 'https://dzen.ru/'),
          I('Сбербанк', 'url', 'https://www.sberbank.ru/'),
          I('Ozon', 'url', 'https://www.ozon.ru/'),
          I('Wildberries', 'url', 'https://www.wildberries.ru/'),
          I('Яндекс DNS 77.88.8.1', 'ip', '77.88.8.1'),
        ],
      },
      {
        name: 'Вне белого списка', role: 'out', items: [
          I('Google', 'url', 'https://www.google.com/'),
          I('Wikipedia', 'url', 'https://www.wikipedia.org/'),
          I('DuckDuckGo', 'url', 'https://duckduckgo.com/'),
          I('Cloudflare', 'url', 'https://www.cloudflare.com/'),
          I('GitHub', 'url', 'https://github.com/'),
          I('Cloudflare DNS 1.1.1.1', 'ip', '1.1.1.1'),
          I('Google DNS 8.8.8.8', 'ip', '8.8.8.8'),
        ],
      },
      {
        name: 'DoH (DNS поверх HTTPS)', role: 'info', items: [
          I('Cloudflare DoH', 'doh', 'https://cloudflare-dns.com/dns-query'),
          I('Google DoH', 'doh', 'https://dns.google/dns-query'),
          I('Яндекс DoH', 'doh', 'https://common.dot.dns.yandex.net/dns-query'),
          I('Quad9 DoH', 'doh', 'https://dns.quad9.net/dns-query'),
        ],
      },
    ],
  };
}

/* ---------- чистые функции (проверяются в node) ---------- */

function num(x, min, max, def) {
  x = Number(x);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : def;
}

function cleanHost(x) {
  const s = String(x == null ? '' : x).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/[\/?#].*$/, '').replace(/\.$/, '');
  const ok = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(s);
  return ok && s.length <= 253 ? s : '';
}

// DNS-запрос типа A в формате RFC 8484 (GET ?dns=base64url)
function dnsQuery(name) {
  const bytes = [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const label of name.split('.')) {
    bytes.push(label.length);
    for (let i = 0; i < label.length; i++) bytes.push(label.charCodeAt(i));
  }
  bytes.push(0, 0, 1, 0, 1);
  return btoa(String.fromCharCode.apply(null, bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.groups)) return null;
  const d = DEFAULTS();
  const cfg = {
    v: 1,
    timeout: num(raw.timeout, 1, 30, d.timeout),
    auto: num(raw.auto, 0, 3600, 0),
    autostart: raw.autostart !== false,
    dohName: cleanHost(raw.dohName) || d.dohName,
    groups: [],
  };
  for (const g of raw.groups.slice(0, 20)) {
    if (!g || typeof g !== 'object') continue;
    const items = [];
    for (const it of (Array.isArray(g.items) ? g.items : []).slice(0, 100)) {
      if (!it || typeof it !== 'object') continue;
      const v = String(it.v == null ? '' : it.v).trim().slice(0, 300);
      const n = String(it.n == null ? '' : it.n).trim().slice(0, 60) || v;
      items.push({ n, t: TYPE_LABEL[it.t] ? it.t : 'url', v });
    }
    cfg.groups.push({
      name: String(g.name == null ? 'Группа' : g.name).slice(0, 60),
      role: ROLE_LABEL[g.role] ? g.role : 'info',
      items,
    });
  }
  return cfg;
}

function computeVerdict(wl, out) {
  const r = (a) => (a.length ? a.filter(Boolean).length / a.length : null);
  const w = r(wl), o = r(out);
  if (w === null || o === null) {
    return { key: 'none', title: 'Недостаточно данных', w, o,
      text: 'Нужен хотя бы один ресурс в группе «Белый список» и в группе «Вне белого списка».' };
  }
  if (w < 0.3 && o < 0.3) {
    return { key: 'down', title: 'Интернета нет', w, o,
      text: 'Недоступно всё: и белый список, и внешние ресурсы. Проверьте подключение.' };
  }
  if (w >= 0.5 && o < 0.3) {
    return { key: 'wl', title: 'Белые списки ВКЛЮЧЕНЫ', w, o,
      text: 'Доступны только ресурсы из белого списка.' };
  }
  if (o >= 0.6 && w >= 0.5) {
    return { key: 'off', title: 'Белые списки ВЫКЛЮЧЕНЫ', w, o,
      text: 'Внешние ресурсы открываются, интернет полный.' };
  }
  return { key: 'mixed', title: 'Неоднозначный результат', w, o,
    text: 'Часть ресурсов доступна, часть нет. Возможна точечная блокировка или нестабильная сеть.' };
}

/* ---------- состояние ---------- */

let cfg = null;
let rows = [];
let running = false;
let autoTimer = null;
let ioMode = null;
let lastVerdict = { key: 'none', title: '', text: '', w: null, o: null };

const $ = (id) => document.getElementById(id);

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  if (props && 'value' in props) e.value = props.value;
  return e;
}

function loadCfg() {
  try {
    const c = sanitize(JSON.parse(localStorage.getItem(LS_CFG)));
    if (c) return c;
  } catch (_) { /* нет сохранённых или битые данные */ }
  return DEFAULTS();
}
function saveCfg() {
  try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (_) { /* хранилище недоступно */ }
}

/* ---------- проверки ---------- */

async function timed(url, init, ms, readBody) {
  const t0 = performance.now();
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, ms);
  try {
    const res = await fetch(url, Object.assign({
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac.signal,
    }, init));
    const buf = readBody ? await res.arrayBuffer() : null;
    return { ok: true, res, buf, ms: Math.round(performance.now() - t0) };
  } catch (_) {
    return { ok: false, timeout: timedOut, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

const bust = (u) => u + (u.includes('?') ? '&' : '?') + '_=' + Date.now();

async function probeUrl(url, ms) {
  const r = await timed(bust(url), { mode: 'no-cors' }, ms);
  return r.ok ? { ok: true, ms: r.ms } : { ok: false, timeout: r.timeout, ms: r.ms };
}

async function probeIp(host, ms) {
  let r = await timed(bust('https://' + host + '/'), { mode: 'no-cors' }, ms);
  if (r.ok) return { ok: true, ms: r.ms };
  // http работает только если сама страница открыта не по https (иначе mixed content)
  if (!r.timeout && location.protocol !== 'https:') {
    const r2 = await timed(bust('http://' + host + '/'), { mode: 'no-cors' }, ms);
    if (r2.ok) return { ok: true, ms: r2.ms, note: 'по http' };
  }
  return { ok: false, timeout: r.timeout, ms: r.ms };
}

async function probeDoh(endpoint, ms) {
  const u = endpoint + (endpoint.includes('?') ? '&' : '?') + 'dns=' + dnsQuery(cfg.dohName);
  const r = await timed(u, { headers: { accept: 'application/dns-message' } }, ms, true);
  if (r.ok) {
    const b = new Uint8Array(r.buf);
    if (r.res.ok && b.length >= 12) {
      const rcode = b[3] & 15, answers = (b[6] << 8) | b[7];
      return rcode === 0 && answers > 0
        ? { ok: true, ms: r.ms, note: 'резолв ок' }
        : { ok: true, warn: true, ms: r.ms, note: 'ответ без записей, rcode ' + rcode };
    }
    return { ok: true, warn: true, ms: r.ms, note: 'HTTP ' + r.res.status };
  }
  if (r.timeout) return { ok: false, timeout: true, ms: r.ms };
  // CORS или сеть: проверяем хотя бы достижимость
  const r2 = await timed(u, { mode: 'no-cors' }, ms);
  if (r2.ok) return { ok: true, ms: r2.ms, note: 'достижим, ответ закрыт CORS' };
  return { ok: false, timeout: r2.timeout, ms: r2.ms };
}

const httpsUrl = (v) => (/^https?:\/\//i.test(v) ? v : 'https://' + v);
const ipHost = (v) => v.replace(/^https?:\/\//i, '').replace(/[\/?#].*$/, '');

function probeItem(it, ms) {
  const v = it.v.trim();
  if (it.t === 'doh') return probeDoh(httpsUrl(v), ms);
  if (it.t === 'ip') return probeIp(ipHost(v), ms);
  return probeUrl(httpsUrl(v), ms);
}

/* ---------- вывод результатов ---------- */

const pct = (x) => (x == null ? null : Math.round(x * 100));
const fmtPct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
const shortVal = (it) => it.v.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
const clampPct = (x) => Number.isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : null;

function toB64Url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return decodeURIComponent(escape(atob(b64)));
}

function buildShareUrl(v) {
  const payload = {
    v: 2,
    k: v.key,
    w: clampPct(v.w == null ? null : v.w * 100),
    o: clampPct(v.o == null ? null : v.o * 100),
    t: Date.now(),
  };
  const url = new URL(location.href);
  url.searchParams.set('r', toB64Url(JSON.stringify(payload)));
  return url.toString();
}

function parseSharedVerdict() {
  const token = new URLSearchParams(location.search).get('r');
  if (!token) return null;
  try {
    const data = JSON.parse(fromB64Url(token));
    if (!data || typeof data !== 'object') return null;
    if (data.v !== 2 && !(!('v' in data) && 'ts' in data)) return null;
    const key = String(data.k || '');
    if (!VERDICT_TEXT[key]) return null;
    const w = Number.isFinite(data.w) ? clampPct(data.w) / 100 : null;
    const o = Number.isFinite(data.o) ? clampPct(data.o) / 100 : null;
    return {
      key,
      title: 'Результат из ссылки: ' + (VERDICT_LABEL[key] || key),
      text: VERDICT_TEXT[key],
      w,
      o,
      shared: true,
    };
  } catch (_) {
    return null;
  }
}

function renderSkeleton() {
  const box = $('results');
  box.replaceChildren();
  rows = [];
  for (const g of cfg.groups) {
    const items = g.items.filter((it) => it.v.trim());
    if (!items.length) continue;
    box.append(h('h2', {}, g.name, h('span', { class: 'role role-' + g.role }, ROLE_SHORT[g.role])));
    for (const it of items) {
      const st = h('div', { class: 's wait' }, 'ожидание');
      box.append(h('div', { class: 'row' },
        h('div', { class: 'rn' }, h('span', { class: 'name' }, it.n || it.v), h('span', { class: 'sub' }, shortVal(it))),
        st));
      rows.push({ item: it, role: g.role, st });
    }
  }
  if (!rows.length) box.append(h('p', { class: 'muted' }, 'Списки пусты. Откройте «Списки и настройки» и добавьте ресурсы.'));
}

function setStatus(el, r, timeoutSec) {
  el.className = 's ' + (r.ok ? (r.warn ? 'warn' : 'ok') : 'bad');
  const main = r.ok ? (r.warn ? 'ответ' : 'OK') + ' · ' + r.ms + ' мс'
    : r.timeout ? 'таймаут · ' + timeoutSec + ' с'
    : 'сбой · ' + r.ms + ' мс';
  el.replaceChildren(main);
  if (r.note) el.append(h('small', {}, r.note));
}

function setVerdict(v) {
  lastVerdict = v;
  const box = $('verdict');
  box.className = 'card v-' + v.key;
  box.replaceChildren(h('b', {}, v.title), h('span', {}, v.text));
  if (v.w != null || v.o != null) {
    box.append(h('div', { class: 'score-grid' },
      h('div', { class: 'score' }, h('small', {}, 'БЕЛЫЙ СПИСОК'), h('strong', {}, fmtPct(v.w))),
      h('div', { class: 'score' }, h('small', {}, 'ВНЕ БС'), h('strong', {}, fmtPct(v.o)))));
  }
  if (v.key !== 'run' && (v.w != null || v.o != null)) {
    box.append(h('div', { class: 'stats' }, 'белый список: ' + fmtPct(v.w) + ' · внешние: ' + fmtPct(v.o)));
  }
  if (v.shared) {
    box.append(h('div', { class: 'shared-note' }, 'Открыт результат по ссылке. Нажмите «Запустить тест», чтобы проверить текущую сеть.'));
  }
  $('share').hidden = v.key === 'none' || v.key === 'run';
}

function shareText(v) {
  let text = 'Результат теста белых списков: ' + v.title + '. ' + v.text;
  if (v.w != null || v.o != null) text += '\nБС: ' + fmtPct(v.w) + ', вне БС: ' + fmtPct(v.o) + '.';
  return text;
}

async function shareResult() {
  if (lastVerdict.key === 'none' || lastVerdict.key === 'run') return;
  const btn = $('share');
  const text = shareText(lastVerdict);
  const url = buildShareUrl(lastVerdict);
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Результат теста белых списков', text, url });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      alert('Не удалось поделиться результатом.');
      return;
    }
  }
  try { await navigator.clipboard.writeText(url); }
  catch (_) {
    const ta = h('textarea', { value: url, readonly: true });
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.textContent = 'Ссылка скопирована';
  setTimeout(() => { btn.textContent = 'Поделиться'; }, 1500);
}

async function run() {
  if (running) return;
  running = true;
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = 'Идёт проверка…';
  $('share').hidden = true;
  $('share').textContent = 'Поделиться';
  try {
    renderSkeleton();
    const sec = cfg.timeout, ms = sec * 1000;
    setVerdict({ key: 'run', title: 'Идёт проверка…', text: 'Таймаут на ресурс: ' + sec + ' с.' });
    const tally = { wl: [], out: [] };
    const queue = rows.slice();
    const worker = async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        const r = await probeItem(row.item, ms);
        setStatus(row.st, r, sec);
        if (tally[row.role]) tally[row.role].push(r.ok);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, rows.length) }, worker));
    const v = computeVerdict(tally.wl, tally.out);
    setVerdict(v);
    pushHistory(v);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Запустить тест';
    running = false;
  }
}

/* ---------- история ---------- */

function loadHist() {
  try {
    const a = JSON.parse(localStorage.getItem(LS_HIST));
    return Array.isArray(a) ? a.slice(0, 30) : [];
  } catch (_) { return []; }
}
function pushHistory(v) {
  if (v.key === 'none') return;
  const a = loadHist();
  a.unshift({ t: Date.now(), k: v.key, w: pct(v.w), o: pct(v.o) });
  try { localStorage.setItem(LS_HIST, JSON.stringify(a.slice(0, 30))); } catch (_) { /* ignore */ }
  renderHistory();
}
function renderHistory() {
  const a = loadHist();
  $('histBox').hidden = !a.length;
  $('hist').replaceChildren(...a.map((e) => h('div', { class: 'h' },
    h('span', {}, new Date(e.t).toLocaleString('ru-RU',
      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })),
    h('span', {}, (VERDICT_LABEL[e.k] || e.k) + ' · БС ' + (e.w == null ? '—' : e.w + '%') + ' / вне ' + (e.o == null ? '—' : e.o + '%')))));
}

/* ---------- редактор списков ---------- */

function changed() {
  saveCfg();
  renderSkeleton();
}

function itemEditor(g, it, gi, ii) {
  return h('div', { class: 'item' },
    h('input', { class: 'iname', value: it.n, placeholder: 'Название', 'aria-label': 'Название',
      oninput: (e) => { it.n = e.target.value; changed(); } }),
    h('select', { class: 'itype', value: it.t, 'aria-label': 'Тип',
      onchange: (e) => { it.t = e.target.value; changed(); } },
    Object.entries(TYPE_LABEL).map(([k, l]) => h('option', { value: k }, l))),
    h('button', { class: 'icon', title: 'Удалить ресурс', 'aria-label': 'Удалить ресурс',
      onclick: () => { g.items.splice(ii, 1); changed(); renderEditor(); } }, '✕'),
    h('input', { class: 'ival', value: it.v, placeholder: 'https://сайт/  ·  1.2.3.4  ·  https://dns/dns-query',
      autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Адрес',
      oninput: (e) => { it.v = e.target.value; changed(); } }));
}

function renderEditor() {
  $('optTimeout').value = cfg.timeout;
  $('optDoh').value = cfg.dohName;
  $('optAuto').value = cfg.auto;
  $('optAutostart').checked = cfg.autostart;
  const box = $('groups');
  box.replaceChildren();
  cfg.groups.forEach((g, gi) => {
    box.append(h('div', { class: 'group' },
      h('div', { class: 'ghead' },
        h('input', { class: 'gname', value: g.name, placeholder: 'Название группы', 'aria-label': 'Название группы',
          oninput: (e) => { g.name = e.target.value; changed(); } }),
        h('select', { class: 'grole', value: g.role, 'aria-label': 'Роль группы',
          onchange: (e) => { g.role = e.target.value; changed(); } },
        Object.entries(ROLE_LABEL).map(([k, l]) => h('option', { value: k }, l))),
        h('button', { class: 'icon', title: 'Удалить группу', 'aria-label': 'Удалить группу',
          onclick: () => {
            if (confirm('Удалить группу «' + g.name + '» вместе с ресурсами?')) {
              cfg.groups.splice(gi, 1); changed(); renderEditor();
            }
          } }, '✕')),
      h('div', { class: 'items' }, g.items.map((it, ii) => itemEditor(g, it, gi, ii))),
      h('button', { class: 'ghost',
        onclick: () => {
          g.items.push({ n: '', t: 'url', v: '' });
          renderEditor();
          const names = $('groups').querySelectorAll('.group')[gi].querySelectorAll('.iname');
          names[names.length - 1].focus();
        } }, '+ Ресурс')));
  });
}

function closeIO() {
  ioMode = null;
  $('ioText').hidden = true;
  $('ioBar').hidden = true;
}

function openIO(mode) {
  ioMode = mode;
  const ta = $('ioText');
  ta.hidden = false;
  $('ioBar').hidden = false;
  $('ioApply').hidden = mode !== 'import';
  $('ioCopy').hidden = mode !== 'export';
  $('ioDl').hidden = mode !== 'export';
  ta.readOnly = mode === 'export';
  ta.placeholder = 'Вставьте сюда JSON из экспорта';
  ta.value = mode === 'export' ? JSON.stringify(cfg, null, 2) : '';
  ta.focus();
}

function applyImport() {
  let c = null;
  try { c = sanitize(JSON.parse($('ioText').value)); } catch (_) { /* ниже сообщим */ }
  if (!c) { alert('Не удалось прочитать JSON. Нужен файл из «Экспорта».'); return; }
  cfg = c;
  saveCfg();
  renderEditor();
  renderSkeleton();
  setAuto();
  closeIO();
}

async function copyIO() {
  const ta = $('ioText'), btn = $('ioCopy');
  try { await navigator.clipboard.writeText(ta.value); }
  catch (_) { ta.select(); document.execCommand('copy'); }
  btn.textContent = 'Скопировано';
  setTimeout(() => { btn.textContent = 'Копировать'; }, 1500);
}

function downloadIO() {
  const blob = new Blob([$('ioText').value], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'whitelist-test-config.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- автоповтор, сеть, service worker ---------- */

function setAuto() {
  clearInterval(autoTimer);
  autoTimer = null;
  if (cfg.auto > 0) {
    autoTimer = setInterval(() => { if (!document.hidden) run(); }, cfg.auto * 1000);
  }
}

function updateChip() {
  const on = navigator.onLine !== false;
  const cached = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  $('net').textContent = (on ? 'сеть есть' : 'нет сети') + ' · ' + (cached ? 'офлайн-кеш вкл' : 'без кеша');
}

function initSW() {
  if (!('serviceWorker' in navigator)) return;
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!secure) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    updateChip();
    if (hadController) $('update').hidden = false;
  });
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

/* ---------- запуск ---------- */

function init() {
  cfg = loadCfg();

  $('run').addEventListener('click', run);
  $('share').addEventListener('click', shareResult);
  $('toggleEdit').addEventListener('click', () => {
    const ed = $('editor');
    ed.hidden = !ed.hidden;
    $('toggleEdit').setAttribute('aria-expanded', String(!ed.hidden));
  });

  $('optTimeout').addEventListener('change', (e) => {
    cfg.timeout = num(e.target.value, 1, 30, cfg.timeout);
    e.target.value = cfg.timeout;
    saveCfg();
  });
  $('optDoh').addEventListener('change', (e) => {
    cfg.dohName = cleanHost(e.target.value) || cfg.dohName;
    e.target.value = cfg.dohName;
    saveCfg();
  });
  $('optAuto').addEventListener('change', (e) => {
    cfg.auto = num(e.target.value, 0, 3600, 0);
    e.target.value = cfg.auto;
    saveCfg();
    setAuto();
  });
  $('optAutostart').addEventListener('change', (e) => {
    cfg.autostart = e.target.checked;
    saveCfg();
  });

  $('addGroup').addEventListener('click', () => {
    cfg.groups.push({ name: 'Новая группа', role: 'info', items: [] });
    changed();
    renderEditor();
  });
  $('exportBtn').addEventListener('click', () => openIO('export'));
  $('importBtn').addEventListener('click', () => openIO('import'));
  $('ioApply').addEventListener('click', applyImport);
  $('ioCopy').addEventListener('click', copyIO);
  $('ioDl').addEventListener('click', downloadIO);
  $('ioClose').addEventListener('click', closeIO);
  $('resetBtn').addEventListener('click', () => {
    if (!confirm('Вернуть списки и настройки по умолчанию?')) return;
    cfg = DEFAULTS();
    saveCfg();
    renderEditor();
    renderSkeleton();
    setAuto();
  });

  $('histClear').addEventListener('click', () => {
    try { localStorage.removeItem(LS_HIST); } catch (_) { /* ignore */ }
    renderHistory();
  });
  $('reload').addEventListener('click', () => location.reload());

  window.addEventListener('online', updateChip);
  window.addEventListener('offline', updateChip);

  renderSkeleton();
  renderEditor();
  renderHistory();
  updateChip();
  setAuto();
  initSW();
  const sharedVerdict = parseSharedVerdict();
  if (sharedVerdict) setVerdict(sharedVerdict);
  else if (cfg.autostart) run();
}

if (typeof document !== 'undefined') {
  init();
} else if (typeof module !== 'undefined') {
  module.exports = { dnsQuery, computeVerdict, sanitize, cleanHost, DEFAULTS };
}
