'use strict';

/* =========================================================================
   Quest Log — a small, gamified brain-dump / to-do / habit tracker.
   Everything is stored in localStorage on the device. No accounts, no server.
   ========================================================================= */

const APP_VERSION = '5'; // bump together with CACHE in sw.js
const STORAGE_KEY = 'questlog.v1';
const XP_TASK = 10;
const XP_HABIT = 5;
const XP_INBOX_ZERO = 20;
const XP_PER_LEVEL = 100;
const TODAY_SOFT_CAP = 5;
const STALE_DAYS = 7;
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const DEFAULT_LISTS = [
  { id: 'growth', name: 'Life Progress', emoji: '🌱' },
  { id: 'errands', name: 'Errands', emoji: '🛒' },
  { id: 'projects', name: 'Projects', emoji: '🛠' },
  { id: 'other', name: 'Other', emoji: '📌' },
];

/* ---------- helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
const daysAgo = (ms) => Math.floor((Date.now() - ms) / 86400000);

/* ---------- links ---------- */

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

function findLinks(...texts) {
  const out = [];
  for (const t of texts) {
    for (let raw of String(t || '').match(URL_RE) || []) {
      raw = raw.replace(/[.,;:!?)\]}]+$/, ''); // trailing punctuation isn't part of the link
      const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      try {
        const u = new URL(href);
        if (!out.some((l) => l.href === u.href)) out.push({ href: u.href, host: u.hostname.replace(/^www\./, ''), path: u.pathname + u.search });
      } catch (e) { /* not a real URL */ }
    }
  }
  return out;
}

// Escapes text for HTML, swapping long URLs for a short "🔗 site.com" label.
function shortText(text) {
  let html = '';
  let last = 0;
  for (const m of String(text).matchAll(URL_RE)) {
    const link = findLinks(m[0])[0];
    html += esc(text.slice(last, m.index));
    const trailing = (m[0].match(/[.,;:!?)\]}]+$/) || [''])[0];
    html += link ? `<span class="linkchip">🔗 ${esc(link.host)}</span>${esc(trailing)}` : esc(m[0]);
    last = m.index + m[0].length;
  }
  return html + esc(String(text).slice(last));
}

/* ---------- state ---------- */

// Identifies this device so XP earned on each device can be merged during sync.
const DEVICE = (() => {
  try {
    let id = localStorage.getItem('questlog.device');
    if (!id) localStorage.setItem('questlog.device', (id = uid()));
    return id;
  } catch (e) {
    return 'local';
  }
})();

function freshState() {
  return {
    version: 1,
    xp: 0,          // cached total of xpBy
    xpBy: {},       // { deviceId: { xp, at } }
    items: [],      // { id, text, note, list (null = inbox), today (dayKey|null), done, doneAt, createdAt, updatedAt }
    lists: clone(DEFAULT_LISTS),
    habits: [],     // { id, name, emoji, days: [0-6] (empty = every day), log: { dayKey: true }, createdAt, updatedAt }
    deleted: {},    // { 'kind:id': deletedAt } so deletions sync too
    collapsed: {},
    tab: 'today',
    inboxZeroDay: null,
    installHintDismissed: false,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { /* fall through to fresh state */ }
  return freshState();
}

function migrate(data) {
  const s = Object.assign(freshState(), data);
  if (!data.xpBy) s.xpBy = s.xp ? { [DEVICE]: { xp: s.xp, at: Date.now() } } : {};
  return s;
}

let S = load();
let lastInboxCount = null;

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(S));
  } catch (e) {
    toast('⚠️ Could not save');
  }
}

function commit() {
  checkInboxZero();
  stampChanges();
  save();
  render();
  scheduleSync();
}

/* ---------- change tracking (for sync) ---------- */

// Snapshot of every record as of the last commit; anything that differs gets a fresh updatedAt,
// anything that disappeared gets a tombstone in S.deleted.
const SYNCED_KINDS = ['items', 'lists', 'habits'];
let snapshot = new Map();

const recordBody = ({ updatedAt, ...rest }) => JSON.stringify(rest);

function baseline() {
  snapshot = new Map();
  for (const kind of SYNCED_KINDS) for (const r of S[kind]) snapshot.set(`${kind}:${r.id}`, recordBody(r));
}

function stampChanges() {
  const now = Date.now();
  const seen = new Set();
  for (const kind of SYNCED_KINDS) {
    for (const r of S[kind]) {
      const key = `${kind}:${r.id}`;
      const body = recordBody(r);
      seen.add(key);
      if (snapshot.get(key) !== body) {
        r.updatedAt = now;
        snapshot.set(key, body);
      }
    }
  }
  for (const key of [...snapshot.keys()]) {
    if (!seen.has(key)) {
      S.deleted[key] = now;
      snapshot.delete(key);
    }
  }
  const cutoff = now - 90 * 86400000;
  for (const [key, t] of Object.entries(S.deleted)) if (t < cutoff) delete S.deleted[key];
}

/* ---------- derived data ---------- */

const listById = (id) => S.lists.find((l) => l.id === id);
const itemById = (id) => S.items.find((i) => i.id === id);
const habitById = (id) => S.habits.find((h) => h.id === id);
const inboxItems = () => S.items.filter((i) => !i.done && !i.list && !i.today);
const level = () => Math.floor(S.xp / XP_PER_LEVEL) + 1;

const isScheduled = (h, d) => !h.days || h.days.length === 0 || h.days.includes(d.getDay());

function streak(h) {
  let d = new Date();
  if (!h.log[dayKey(d)]) d = addDays(d, -1); // not done *yet* today doesn't break the streak
  let n = 0;
  for (let i = 0; i < 1000; i++) {
    const done = !!h.log[dayKey(d)];
    if (done) n++;
    else if (isScheduled(h, d)) break;
    d = addDays(d, -1);
  }
  return n;
}

function scheduleLabel(h) {
  if (!h.days || h.days.length === 0 || h.days.length === 7) return 'Every day';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const sorted = [...h.days].sort();
  if (sorted.join() === '1,2,3,4,5') return 'Weekdays';
  if (sorted.join() === '0,6') return 'Weekends';
  return sorted.map((d) => names[d]).join(', ');
}

/* ---------- XP + feedback ---------- */

const totalXP = () => Math.max(0, Object.values(S.xpBy).reduce((sum, d) => sum + (d.xp || 0), 0));

function addXP(n, ev) {
  const before = level();
  const mine = S.xpBy[DEVICE] || (S.xpBy[DEVICE] = { xp: 0, at: 0 });
  mine.xp += n;
  mine.at = Date.now();
  S.xp = totalXP();
  if (n > 0) {
    celebrate(ev, n);
    if (level() > before) setTimeout(() => toast(`⭐ Level up! You're level ${level()}`), 300);
  }
}

function checkInboxZero() {
  const count = inboxItems().length;
  const today = dayKey();
  if (lastInboxCount > 0 && count === 0 && S.inboxZeroDay !== today) {
    S.inboxZeroDay = today;
    addXP(XP_INBOX_ZERO);
    setTimeout(() => toast(`📭 Inbox zero! +${XP_INBOX_ZERO} XP`), 350);
  }
  lastInboxCount = count;
}

function celebrate(ev, xp) {
  const x = ev?.clientX ?? window.innerWidth / 2;
  const y = ev?.clientY ?? window.innerHeight / 2;
  const bits = ['✨', '⭐', '🎉', '💜', '✦'];
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('span');
    s.className = 'confetti';
    s.textContent = bits[i % bits.length];
    const angle = (Math.PI * 2 * i) / 10;
    s.style.left = `${x - 8}px`;
    s.style.top = `${y - 10}px`;
    s.style.setProperty('--dx', `${Math.cos(angle) * (40 + Math.random() * 30)}px`);
    s.style.setProperty('--dy', `${Math.sin(angle) * (40 + Math.random() * 30) - 20}px`);
    s.style.setProperty('--rot', `${Math.random() * 360}deg`);
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 850);
  }
  if (xp) {
    const f = document.createElement('span');
    f.className = 'xp-float';
    f.textContent = `+${xp} XP`;
    f.style.left = `${x + 14}px`;
    f.style.top = `${y - 30}px`;
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 950);
  }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

/* ---------- rendering ---------- */

const TITLES = { today: 'Today', inbox: 'Inbox', lists: 'Lists', habits: 'Habits' };

function render() {
  const view = VIEWS[S.tab] ? S.tab : 'today';
  $('#view').innerHTML = VIEWS[view]();
  $('#title').textContent = TITLES[view];
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === view));

  const into = S.xp % XP_PER_LEVEL;
  $('#lvl').textContent = `Lv ${level()}`;
  $('#xpfill').style.width = `${into}%`;
  $('#xp').textContent = `${into} / ${XP_PER_LEVEL} XP`;

  const n = inboxItems().length;
  const badge = $('#inboxBadge');
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : n;
}

function itemRow(i, opts = {}) {
  const meta = [];
  const list = listById(i.list);
  if (opts.showList && list) meta.push(`${list.emoji} ${esc(list.name)}`);
  if (opts.showToday && i.today === dayKey() && !i.done) meta.push('☀️ Today');
  if (i.note) meta.push(findLinks(i.note).length ? '📝 note 🔗' : '📝 note');
  if (opts.showAge && !i.done) {
    const age = daysAgo(i.createdAt);
    if (age >= STALE_DAYS) meta.push(`<span class="stale">${age} days old</span>`);
  }
  return `
    <li class="item ${i.done ? 'done' : ''}">
      <button class="check" data-action="toggle" data-id="${i.id}" aria-label="${i.done ? 'Mark not done' : 'Mark done'}"></button>
      <button class="body" data-action="openItem" data-id="${i.id}">
        <span class="text">${shortText(i.text)}</span>
        ${meta.length ? `<span class="meta">${meta.join(' · ')}</span>` : ''}
      </button>
      ${opts.extra ? opts.extra(i) : ''}
    </li>`;
}

const VIEWS = {
  today() {
    const tk = dayKey();
    const now = new Date();
    const active = S.items.filter((i) => !i.done && i.today === tk);
    const carried = S.items.filter((i) => !i.done && i.today && i.today < tk);
    const doneToday = S.items.filter((i) => i.done && i.doneAt && dayKey(new Date(i.doneAt)) === tk);
    const habits = S.habits.filter((h) => isScheduled(h, now) || h.log[tk]);

    const weekAgo = Date.now() - 7 * 86400000;
    const doneWeek = S.items.filter((i) => i.done && i.doneAt >= weekAgo).length;
    const bestStreak = S.habits.reduce((m, h) => Math.max(m, streak(h)), 0);
    const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

    let html = `<p class="hint" style="margin-top:0">${esc(dateLabel)}</p>
      <div class="stats">
        <div class="card stat"><b>${doneToday.length}</b><small>done today</small></div>
        <div class="card stat"><b>${doneWeek}</b><small>this week</small></div>
        <div class="card stat"><b>${bestStreak}🔥</b><small>best streak</small></div>
      </div>`;

    html += `<div class="section-title">Habits</div>`;
    if (habits.length) {
      html += `<div class="habit-chips">${habits
        .map((h) => `<button class="habit-chip ${h.log[tk] ? 'on' : ''}" data-action="habitToday" data-id="${h.id}">${esc(h.emoji)} ${esc(h.name)}${h.log[tk] ? ' ✓' : ''}</button>`)
        .join('')}</div>`;
    } else {
      html += `<p class="hint">Things like “workout”, “ride bike”, “cook” work best as habits. <button class="link" data-action="tab" data-tab="habits">Add one →</button></p>`;
    }

    if (carried.length) {
      html += `<div class="section-title">From before <button data-action="sendBackAll">Send all back</button></div>
        <p class="hint">Still want these? No guilt either way.</p>
        <ul class="items card">${carried
          .map((i) => itemRow(i, {
            showList: true,
            extra: (it) => `<div class="carry-actions">
              <button class="pill-btn" data-action="keepToday" data-id="${it.id}">Keep</button>
              <button class="pill-btn plain" data-action="sendBack" data-id="${it.id}">Later</button></div>`,
          }))
          .join('')}</ul>`;
    }

    html += `<div class="section-title">Focus <button data-action="pickForToday">+ Pick</button></div>`;
    if (active.length) {
      html += `<ul class="items card">${active.map((i) => itemRow(i, { showList: true })).join('')}</ul>`;
      if (active.length + doneToday.length > TODAY_SOFT_CAP) {
        html += `<p class="hint warn">That's a lot for one day. Which 3 really matter?</p>`;
      }
    } else if (!doneToday.length) {
      html += `<div class="card empty"><span class="big">🎯</span>Nothing picked yet.<br>
        <button class="link" data-action="pickForToday">Choose 1–3 things for today</button></div>`;
    } else {
      html += `<div class="card empty"><span class="big">🏆</span>All clear. Go enjoy your day.</div>`;
    }

    if (doneToday.length) {
      html += `<div class="section-title">Done today</div>
        <ul class="items card">${doneToday.map((i) => itemRow(i)).join('')}</ul>`;
    }
    return html;
  },

  inbox() {
    const items = inboxItems().sort((a, b) => b.createdAt - a.createdAt);
    if (!items.length) {
      return `<div class="card empty" style="margin-top:8px"><span class="big">📭</span>Inbox zero. Nice.<br>
        Tap <b>＋</b> any time to dump a thought here.</div>`;
    }
    return `<p class="hint" style="margin-top:0">Quick-dump zone. Tap an item to send it to <b>Today</b> or a list. Clear it out for +${XP_INBOX_ZERO} XP.</p>
      <ul class="items card">${items.map((i) => itemRow(i, { showAge: true })).join('')}</ul>`;
  },

  lists() {
    let html = '';
    for (const l of S.lists) {
      const items = S.items.filter((i) => i.list === l.id && !i.done).sort((a, b) => a.createdAt - b.createdAt);
      const collapsed = !!S.collapsed[l.id];
      html += `<div class="card list-block ${collapsed ? 'collapsed' : ''}">
        <button class="list-head" data-action="collapse" data-id="${l.id}">
          <span>${esc(l.emoji)}</span><span class="name">${esc(l.name)}</span>
          <span class="count">${items.length}</span><span class="chev">▾</span>
        </button>
        ${collapsed ? '' : `
          ${items.length ? `<ul class="items">${items.map((i) => itemRow(i, { showToday: true, showAge: true })).join('')}</ul>` : ''}
          <div class="list-foot">
            <button data-action="capture" data-dest="${l.id}">+ Add</button>
            <button class="muted" data-action="editList" data-id="${l.id}">Edit list</button>
          </div>`}
      </div>`;
    }
    html += `<button class="wide-btn" data-action="editList">+ New list</button>`;
    return html;
  },

  habits() {
    const today = new Date();
    const tk = dayKey(today);
    let html = '';
    if (!S.habits.length) {
      html += `<div class="card empty" style="margin-top:8px"><span class="big">🔁</span>
        Habits are things you want to do <i>regularly</i>: workouts, cooking, a bike ride.<br>Build streaks, earn XP.</div>`;
    }
    for (const h of S.habits) {
      const days = [];
      for (let k = 6; k >= 0; k--) {
        const d = addDays(today, -k);
        const key = dayKey(d);
        const on = !!h.log[key];
        const sched = isScheduled(h, d);
        const existed = key >= dayKey(new Date(h.createdAt));
        const cls = ['dot', on ? 'on' : '', !sched && !on ? 'off' : '', sched && existed && !on && k > 0 ? 'miss' : '', k === 0 ? 'today' : ''].join(' ');
        days.push(`<div class="day"><button class="${cls}" data-action="habitDay" data-id="${h.id}" data-day="${key}" aria-label="${key}"></button>${WEEKDAYS[d.getDay()]}</div>`);
      }
      const s = streak(h);
      html += `<div class="card habit">
        <div class="habit-head">
          <button class="habit-name" data-action="editHabit" data-id="${h.id}">${esc(h.emoji)} ${esc(h.name)}
            <div class="habit-sub">${scheduleLabel(h)}${h.log[tk] ? ' · done today ✓' : ''}</div></button>
          <span class="streak">${s ? `🔥 ${s}` : ''}</span>
        </div>
        <div class="week">${days.join('')}</div>
      </div>`;
    }
    html += `<button class="wide-btn" data-action="editHabit">+ New habit</button>`;
    return html;
  },
};

/* ---------- bottom sheet ---------- */

function openSheet(html, onMount) {
  const sheet = $('#sheet');
  $('#sheetBody').innerHTML = html;
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
  if (onMount) onMount($('#sheetBody'));
}

function closeSheet() {
  const sheet = $('#sheet');
  sheet.classList.remove('open');
  setTimeout(() => {
    if (!sheet.classList.contains('open')) {
      sheet.hidden = true;
      $('#sheetBody').innerHTML = '';
    }
  }, 220);
}

function destChips(selected) {
  const opts = [{ id: 'inbox', label: '📥 Inbox' }, { id: 'today', label: '☀️ Today' }, ...S.lists.map((l) => ({ id: l.id, label: `${l.emoji} ${l.name}` }))];
  return opts.map((o) => `<button class="chip ${o.id === selected ? 'on' : ''}" data-action="pickDest" data-dest="${o.id}">${esc(o.label)}</button>`).join('');
}

function openCapture(dest) {
  const selected = dest || (S.tab === 'today' ? 'today' : 'inbox');
  openSheet(`
    <h2>Brain dump</h2>
    <textarea id="capText" rows="4" placeholder="Anything on your mind…&#10;One thing per line."></textarea>
    <div id="capShot" class="shot-preview" hidden>
      <img id="capImg" alt="Attached screenshot">
      <button class="shot-remove" data-action="removeShot" aria-label="Remove screenshot">✕</button>
    </div>
    <label class="action shot-btn" id="shotBtn">📷 Add a screenshot
      <input type="file" id="capFile" accept="image/*" hidden>
    </label>
    <div class="chips" id="capDest" data-dest="${selected}">${destChips(selected)}</div>
    <button class="primary" data-action="saveCapture">Add</button>`,
  (root) => $('#capText', root).focus());
  pendingShot = null;
}

function openItem(id) {
  const i = itemById(id);
  if (!i) return;
  const onToday = i.today === dayKey() && !i.done;
  const links = findLinks(i.text, i.note);
  const shortPath = (p) => (p.length > 28 ? `${p.slice(0, 27)}…` : p === '/' ? '' : p);
  openSheet(`
    <h2>${shortText(i.text)}</h2>
    ${i.note ? `<div class="note">${shortText(i.note)}</div>` : ''}
    <div class="actions" style="margin-top:12px">
      ${links.map((l) => `<a class="action link-action" href="${esc(l.href)}" target="_blank" rel="noopener">🔗 Go to link
        <small>${esc(l.host)}${esc(shortPath(l.path))}</small></a>`).join('')}
      ${i.done ? '' : onToday
        ? `<button class="action" data-action="sendBack" data-id="${i.id}">🌙 Not today</button>`
        : `<button class="action" data-action="keepToday" data-id="${i.id}">☀️ Do it today</button>`}
      <button class="action" data-action="editItem" data-id="${i.id}">✏️ Edit / add note</button>
      ${i.done ? '' : `<button class="action" data-action="makeHabit" data-id="${i.id}">🔁 Turn into a habit</button>`}
    </div>
    <h3>Move to</h3>
    <div class="chips">
      <button class="chip ${!i.list ? 'on' : ''}" data-action="moveItem" data-id="${i.id}" data-list="">📥 Inbox</button>
      ${S.lists.map((l) => `<button class="chip ${i.list === l.id ? 'on' : ''}" data-action="moveItem" data-id="${i.id}" data-list="${l.id}">${esc(l.emoji)} ${esc(l.name)}</button>`).join('')}
    </div>
    <button class="danger-btn" data-action="deleteItem" data-id="${i.id}">Delete</button>`);
}

function openEditItem(id) {
  const i = itemById(id);
  if (!i) return;
  openSheet(`
    <h2>Edit</h2>
    <label for="editText">Task</label>
    <input id="editText" value="${esc(i.text)}">
    <label for="editNote">Note</label>
    <textarea id="editNote" rows="5" placeholder="Details, links, tracking numbers…">${esc(i.note || '')}</textarea>
    <button class="primary" data-action="saveItem" data-id="${i.id}">Save</button>`);
}

function openPickForToday() {
  const tk = dayKey();
  const candidates = S.items.filter((i) => !i.done && i.today !== tk);
  if (!candidates.length) {
    openCapture('today');
    return;
  }
  const groups = [{ title: '📥 Inbox', items: candidates.filter((i) => !i.list) }];
  for (const l of S.lists) groups.push({ title: `${l.emoji} ${l.name}`, items: candidates.filter((i) => i.list === l.id) });
  openSheet(`
    <h2>What matters today?</h2>
    <p class="hint" style="margin:0">Pick 1–3. Tap to add.</p>
    ${groups.filter((g) => g.items.length).map((g) => `
      <h3>${esc(g.title)}</h3>
      <div class="chips" style="margin-top:0">${g.items.map((i) => `<button class="chip" data-action="pickToday" data-id="${i.id}">${esc(i.text)}</button>`).join('')}</div>`).join('')}
    <button class="primary" data-action="closeSheet">Done</button>`);
}

function openEditHabit(id) {
  const h = id ? habitById(id) : { name: '', emoji: '💪', days: [] };
  const days = h.days && h.days.length ? h.days : [0, 1, 2, 3, 4, 5, 6];
  openSheet(`
    <h2>${id ? 'Edit habit' : 'New habit'}</h2>
    <div class="row">
      <input id="habitEmoji" class="emoji-input" value="${esc(h.emoji)}" aria-label="Emoji">
      <input id="habitName" value="${esc(h.name)}" placeholder="e.g. Workout after work">
    </div>
    <label>Which days?</label>
    <div class="chips" id="habitDays" style="margin-top:0">
      ${WEEKDAYS.map((d, n) => `<button class="chip ${days.includes(n) ? 'on' : ''}" data-action="toggleDay" data-day="${n}">${d}</button>`).join('')}
    </div>
    <button class="primary" data-action="saveHabit" data-id="${id || ''}">Save</button>
    ${id ? `<button class="danger-btn" data-action="deleteHabit" data-id="${id}">Delete habit</button>` : ''}`,
  (root) => { if (!id) $('#habitName', root).focus(); });
}

function openEditList(id) {
  const l = id ? listById(id) : { name: '', emoji: '📁' };
  openSheet(`
    <h2>${id ? 'Edit list' : 'New list'}</h2>
    <div class="row">
      <input id="listEmoji" class="emoji-input" value="${esc(l.emoji)}" aria-label="Emoji">
      <input id="listName" value="${esc(l.name)}" placeholder="List name">
    </div>
    <button class="primary" data-action="saveList" data-id="${id || ''}">Save</button>
    ${id ? `<button class="danger-btn" data-action="deleteList" data-id="${id}">Delete list (items go to Inbox)</button>` : ''}`,
  (root) => { if (!id) $('#listName', root).focus(); });
}

function openSettings() {
  const total = S.items.filter((i) => i.done).length;
  openSheet(`
    <h2>Settings</h2>
    <p class="hint" style="margin:0 0 12px">Level ${level()} · ${S.xp} XP total · ${total} task${total === 1 ? '' : 's'} completed all-time</p>
    <h3>Sync between devices</h3>
    <div id="syncPanel">${syncPanelHtml()}</div>
    <h3>Reading screenshots</h3>
    <div id="aiPanel">${aiPanelHtml()}</div>
    <h3>Data</h3>
    <div class="actions">
      <button class="action" data-action="openImport">📋 Import from Apple Notes</button>
      <button class="action" data-action="exportData">💾 Back up my data</button>
      <button class="action" data-action="openRestore">♻️ Restore from backup</button>
    </div>
    <p class="hint">A backup is a snapshot file you can keep in iCloud Drive or email to yourself.</p>
    <button class="danger-btn" data-action="resetAll">Erase everything</button>
    <p class="hint" style="text-align:center">Quest Log version ${APP_VERSION}</p>`);
}

/* ---------- Apple Notes import ---------- */

const CHECKBOX_RE = /^[-*•◦▢☐]\s*\[( |x|X)?\]\s*(.*)$|^[☐▢◻︎○]\s*(.*)$/;
const EMOJI_START_RE = /^\p{Extended_Pictographic}/u;
const TRACKING_RE = /^[A-Z]{0,3}\d{9,}[A-Z]{0,3}$/;

function cleanHeader(line) {
  const emoji = (line.match(/^(\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*)/u) || [])[1] || '📁';
  const name = line.replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '').replace(/[:\s]+$/, '');
  const titled = name.toLowerCase().replace(/(^|[\s/(-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
  return { emoji, name: titled };
}

function matchList(header) {
  const h = header.name.toLowerCase();
  if (/daily|to-?do|today|inbox|dump/.test(h)) return { inbox: true };
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nh = norm(h);
  const found = S.lists.find((l) => nh.includes(norm(l.name)));
  if (found) return { id: found.id, emoji: found.emoji, name: found.name };
  return { name: header.name.split(/[:/]/)[0].trim(), emoji: header.emoji };
}

function parseDump(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const nonBlank = lines.filter(Boolean);
  const out = [];
  let section = { inbox: true };
  let tracking = [];
  const flushTracking = () => {
    if (tracking.length) {
      out.push({ text: `📦 Track ${tracking.length} package${tracking.length > 1 ? 's' : ''}`, note: tracking.join('\n'), dest: { inbox: true } });
      tracking = [];
    }
  };

  lines.forEach((line, idx) => {
    if (!line) return;
    if (TRACKING_RE.test(line.replace(/\s/g, ''))) { tracking.push(line); return; }
    flushTracking();

    const box = line.match(CHECKBOX_RE);
    if (box) {
      if (box[1] && box[1].trim()) return; // already checked off
      const t = (box[2] ?? box[3] ?? '').trim();
      if (t) out.push({ text: t, dest: section });
      return;
    }

    const next = lines.slice(idx + 1).find(Boolean) || '';
    const isFirst = line === nonBlank[0];
    if (EMOJI_START_RE.test(line) || (/:$/.test(line) && line.length < 40)) {
      section = matchList(cleanHeader(line));
      return;
    }
    // Title line at the very top ("OCTOBER BRAIN DUMP")
    if (isFirst && line === line.toUpperCase() && EMOJI_START_RE.test(next)) return;
    if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(line)) return; // a bare date like 10/13
    if (line.length <= 1) return;
    // Loose (non-checkbox) jot-downs go to Inbox to be sorted
    out.push({ text: line.replace(/^[-*•]\s*/, ''), dest: { inbox: true } });
  });
  flushTracking();
  return out;
}

let importPreview = [];

function openImport() {
  openSheet(`
    <h2>Import from Notes</h2>
    <p class="hint" style="margin:0 0 10px">Open your note → select all → copy → paste here. Checkboxes and sections get sorted automatically; loose jot-downs land in your Inbox.</p>
    <textarea id="importText" rows="10" placeholder="Paste your note here"></textarea>
    <button class="primary" data-action="previewImport">Preview</button>`,
  (root) => $('#importText', root).focus());
}

function previewImport() {
  const text = $('#importText').value;
  importPreview = parseDump(text);
  if (!importPreview.length) { toast('Nothing to import'); return; }
  const groups = new Map();
  importPreview.forEach((p, n) => {
    const key = p.dest.inbox ? '📥 Inbox' : `${p.dest.emoji} ${p.dest.name}${p.dest.id ? '' : ' (new list)'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  });
  openSheet(`
    <h2>Look right?</h2>
    <p class="hint" style="margin:0">Uncheck anything you don't want. You can move things later.</p>
    ${[...groups].map(([title, idxs]) => `
      <div class="preview-group"><h4>${esc(title)}</h4>
      ${idxs.map((n) => `<label class="preview-item"><input type="checkbox" data-idx="${n}" checked>
        <span>${esc(importPreview[n].text)}${importPreview[n].note ? `<small>${esc(importPreview[n].note.split('\n').length)} lines of notes</small>` : ''}</span></label>`).join('')}
      </div>`).join('')}
    <button class="primary" data-action="doImport">Import ${importPreview.length} items</button>`);
}

function doImport() {
  const picked = [...document.querySelectorAll('#sheetBody input[data-idx]:checked')].map((el) => importPreview[+el.dataset.idx]);
  const now = Date.now();
  for (const p of picked) {
    let listId = null;
    if (!p.dest.inbox) {
      listId = p.dest.id;
      if (!listId) {
        let l = S.lists.find((x) => x.name === p.dest.name);
        if (!l) { l = { id: uid(), name: p.dest.name, emoji: p.dest.emoji }; S.lists.push(l); }
        listId = p.dest.id = l.id;
      }
    }
    S.items.push({ id: uid(), text: p.text, note: p.note || '', list: listId, today: null, done: false, doneAt: null, createdAt: now });
  }
  importPreview = [];
  lastInboxCount = null; // don't award inbox-zero for this
  closeSheet();
  S.tab = 'inbox';
  commit();
  toast(`Imported ${picked.length} items 🎉`);
}

/* ---------- backup ---------- */

async function exportData() {
  const json = JSON.stringify(S, null, 2);
  const name = `questlog-backup-${dayKey()}.json`;
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Quest Log backup' });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(json);
    toast('Backup copied — paste it into a note');
    return;
  } catch (e) { /* fall through to download */ }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name;
  a.click();
}

function openRestore() {
  openSheet(`
    <h2>Restore backup</h2>
    <p class="hint" style="margin:0 0 10px">Choose a backup file, or paste backup text. This replaces what's on this phone.</p>
    <input type="file" id="restoreFile" accept=".json,application/json">
    <label for="restoreText">…or paste</label>
    <textarea id="restoreText" rows="5"></textarea>
    <button class="primary" data-action="doRestore">Restore</button>`);
}

async function doRestore() {
  const file = $('#restoreFile').files[0];
  const text = file ? await file.text() : $('#restoreText').value;
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data.items) || !Array.isArray(data.habits)) throw new Error('bad');
    if (!confirm(`Replace everything${sync.token ? ' (on all synced devices)' : ''} with this backup?`)) return;
    S = migrate(data);
    lastInboxCount = null;
    closeSheet();
    commit();
    toast('Restored ✓');
  } catch (e) {
    toast("That doesn't look like a Quest Log backup");
  }
}

/* ---------- sync (private GitHub gist) ---------- */

const SYNC_KEY = 'questlog.sync';
const GIST_FILE = 'questlog.json';
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Quest%20Log%20sync';

let sync = (() => {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; }
})();
let syncStatus = sync.token ? 'idle' : 'off'; // off | idle | syncing | ok | error
let syncError = '';
let syncing = false;
let syncAgain = false;
let syncTimer;

function saveSync() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) { /* ignore */ }
}

const syncPayload = () => JSON.stringify({ version: 1, items: S.items, lists: S.lists, habits: S.habits, xpBy: S.xpBy, deleted: S.deleted });

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${sync.token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) throw new Error('GitHub rejected the sync key. Reconnect in Settings.');
  if (res.status === 404) throw Object.assign(new Error('Not found'), { notFound: true });
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  return res.json();
}

async function findOrCreateGist() {
  for (let page = 1; page <= 10; page++) {
    const gists = await gh(`/gists?per_page=100&page=${page}`);
    const found = gists.find((g) => g.files && g.files[GIST_FILE]);
    if (found) return found.id;
    if (gists.length < 100) break;
  }
  const created = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({ description: 'Quest Log sync data (used by the Quest Log app)', public: false, files: { [GIST_FILE]: { content: syncPayload() } } }),
  });
  return created.id;
}

async function readRemote() {
  const g = await gh(`/gists/${sync.gistId}`);
  const f = g.files[GIST_FILE];
  if (!f) return null;
  const content = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
  return { content, data: JSON.parse(content) };
}

// Record-by-record merge: newest updatedAt wins, tombstones win over older edits.
function mergeState(remote) {
  stampChanges();
  const deleted = { ...(remote.deleted || {}) };
  for (const [key, t] of Object.entries(S.deleted)) deleted[key] = Math.max(deleted[key] || 0, t);
  for (const kind of SYNCED_KINDS) {
    const byId = new Map();
    for (const r of remote[kind] || []) byId.set(r.id, r);
    for (const r of S[kind]) {
      const theirs = byId.get(r.id);
      if (!theirs || (r.updatedAt || 0) >= (theirs.updatedAt || 0)) byId.set(r.id, r);
    }
    S[kind] = [...byId.values()].filter((r) => !(deleted[`${kind}:${r.id}`] >= (r.updatedAt || 0)));
  }
  S.deleted = deleted;
  const xpBy = { ...(remote.xpBy || {}) };
  for (const [dev, v] of Object.entries(S.xpBy)) if (!xpBy[dev] || v.at >= xpBy[dev].at) xpBy[dev] = v;
  S.xpBy = xpBy;
  S.xp = totalXP();
  baseline();
}

function scheduleSync(delay = 1500) {
  if (!sync.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

async function syncNow() {
  if (!sync.token) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSyncStatus('syncing');
  try {
    if (!sync.gistId) { sync.gistId = await findOrCreateGist(); saveSync(); }
    let remote;
    try {
      remote = await readRemote();
    } catch (e) {
      if (!e.notFound) throw e;
      sync.gistId = await findOrCreateGist(); // gist was deleted; find or make a new one
      saveSync();
      remote = await readRemote();
    }
    const before = syncPayload();
    if (remote) mergeState(remote.data);
    const merged = syncPayload();
    if (merged !== before) {
      lastInboxCount = null; // incoming changes shouldn't trigger the inbox-zero bonus
      save();
      render();
    }
    if (!remote || merged !== remote.content) {
      await gh(`/gists/${sync.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: merged } } }) });
    }
    sync.lastSync = Date.now();
    saveSync();
    setSyncStatus('ok');
  } catch (e) {
    setSyncStatus('error', navigator.onLine === false ? "You're offline. Will sync when you're back." : e.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

function setSyncStatus(status, error = '') {
  syncStatus = status;
  syncError = error;
  const btn = $('#syncBtn');
  btn.hidden = status === 'off';
  btn.textContent = { syncing: '🔄', error: '⚠️' }[status] || '☁️';
  btn.classList.toggle('spin', status === 'syncing');
  const panel = $('#syncPanel');
  if (panel) panel.innerHTML = syncPanelHtml();
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function syncPanelHtml() {
  if (!sync.token) {
    return `
      <p class="hint" style="margin-top:0">Use Quest Log on your phone <i>and</i> PC with the same data. It's saved in a private file in your GitHub account.</p>
      <ol class="steps">
        <li><a class="link" href="${TOKEN_URL}" target="_blank" rel="noopener">Make a sync key on GitHub ↗</a></li>
        <li>Set <b>Expiration</b> to <b>No expiration</b>, scroll down and tap <b>Generate token</b>.</li>
        <li>Copy the key (starts with <code>ghp_</code>) and paste it here:</li>
      </ol>
      <input id="syncToken" placeholder="ghp_…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
      <button class="primary" data-action="connectSync">Connect</button>
      <p class="hint">Then do the same on your other device. Each device can have its own key.</p>`;
  }
  const line = {
    syncing: '🔄 Syncing…',
    error: `⚠️ ${esc(syncError)}`,
  }[syncStatus] || `☁️ Synced${sync.lastSync ? ` · ${ago(sync.lastSync)}` : ''}`;
  return `
    <p class="hint" style="margin-top:0">${line}</p>
    <div class="row">
      <button class="action" data-action="syncNow">🔄 Sync now</button>
      <button class="action" data-action="disconnectSync">Disconnect</button>
    </div>`;
}

/* ---------- screenshot reading ---------- */

// Smart mode: Claude reads the screenshot (needs the person's own Anthropic API key, kept on this device only).
// Basic mode: free on-device text recognition (Tesseract), no key needed.
const AI_KEY_STORAGE = 'questlog.ai';
const AI_MODEL = 'claude-opus-5-5';
const ANTHROPIC_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.1/+esm';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
const KEYS_URL = 'https://console.anthropic.com/settings/keys';
const MAX_IMAGE_EDGE = 1568; // larger images are downscaled by the API anyway

let aiKey = (() => {
  try { return localStorage.getItem(AI_KEY_STORAGE) || ''; } catch (e) { return ''; }
})();
let pendingShot = null; // { dataUrl, base64 } while the brain-dump sheet has a screenshot attached

async function loadScreenshot(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { dataUrl, base64: dataUrl.split(',')[1] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

let anthropicModule;
async function anthropicClient() {
  anthropicModule = anthropicModule || (await import(ANTHROPIC_SDK_URL));
  const Anthropic = anthropicModule.default;
  // The key is the person's own and lives only on their device, so browser use is intended here.
  return new Anthropic({ apiKey: aiKey, dangerouslyAllowBrowser: true });
}

function friendlyAIError(err) {
  const m = anthropicModule || {};
  if (m.AuthenticationError && err instanceof m.AuthenticationError) return 'Your Anthropic key was rejected. Check it in Settings.';
  if (m.PermissionDeniedError && err instanceof m.PermissionDeniedError) return "That Anthropic key isn't allowed to do this.";
  if (m.RateLimitError && err instanceof m.RateLimitError) return 'Claude is busy. Try again in a minute.';
  if (m.APIConnectionError && err instanceof m.APIConnectionError) return "Couldn't reach Claude. Are you online?";
  if (m.APIError && err instanceof m.APIError && /credit|billing/i.test(err.message)) return 'Your Anthropic account is out of credit.';
  return err.message || 'Something went wrong reading that.';
}

const SHOT_SYSTEM = `You turn a screenshot into one entry for a personal to-do and notes app. The person sends a screenshot of something they want to remember or act on, sometimes with a few words of their own about why.

Return JSON with:
- title: a short, specific title (under 60 characters). Phrase it as something to do when that fits, e.g. "Book flight to Phoenix" or "Try the miso salmon recipe". If the person wrote something, build the title around their words.
- note: the details worth keeping from the screenshot, as plain text in short lines: names, dates, times, prices, addresses, phone numbers, order or tracking numbers, codes, steps. No markdown. Skip interface clutter like the status bar, menus and ads. Use an empty string if there is nothing beyond the title.
- list: the id of the list it fits best, or "inbox" if unsure.
- links: full URLs visible in the screenshot (add https:// if it's missing). Empty array if none.`;

async function readScreenshotSmart(shot, details) {
  const client = await anthropicClient();
  const listIds = S.lists.map((l) => l.id);
  const response = await client.beta.messages.create({
    model: AI_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            note: { type: 'string' },
            list: { type: 'string', enum: ['inbox', ...listIds] },
            links: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'note', 'list', 'links'],
          additionalProperties: false,
        },
      },
    },
    system: `${SHOT_SYSTEM}\n\nThe lists are:\n${S.lists.map((l) => `- ${l.id}: ${l.name}`).join('\n')}\n\nToday is ${new Date().toDateString()}.`,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.base64 } },
        { type: 'text', text: details ? `My notes: ${details}` : 'No notes from me, just the screenshot.' },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error("Claude couldn't help with that screenshot.");
  if (response.stop_reason === 'max_tokens') throw new Error('That screenshot was too much to read. Try cropping it.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const result = JSON.parse(text);
  return { ...result, list: result.list === 'inbox' ? null : result.list };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load the text reader. Are you online?"));
    document.head.appendChild(s);
  });
}

async function readScreenshotBasic(shot, details, onProgress) {
  await loadScript(TESSERACT_URL);
  const { data } = await window.Tesseract.recognize(shot.dataUrl, 'eng', {
    logger: (m) => { if (m.status === 'recognizing text') onProgress(Math.round(m.progress * 100)); },
  });
  const lines = data.text.split('\n').map((l) => l.trim())
    .filter((l) => /[A-Za-z0-9]{2,}/.test(l) && !/^\d{1,2}:\d{2}\b.{0,12}$/.test(l)); // drop the status-bar clock
  const firstReal = lines.find((l) => /[A-Za-z]{3,}/.test(l) && l.length > 4);
  const title = details.split('\n')[0].trim() || (firstReal || 'Screenshot note').slice(0, 80);
  const rest = details.split('\n').slice(1).join('\n').trim();
  return { title, note: [rest, lines.join('\n')].filter(Boolean).join('\n\n').slice(0, 4000), list: null, links: [] };
}

function aiPanelHtml() {
  if (aiKey) {
    return `
      <p class="hint" style="margin-top:0">✨ <b>Smart reading is on.</b> Claude picks a title, pulls out the details and links, and files it in the right list. About 2–3¢ per screenshot, billed to your Anthropic account.</p>
      <button class="action" data-action="removeAiKey" style="width:100%">Turn off smart reading</button>`;
  }
  return `
    <p class="hint" style="margin-top:0">Screenshots use <b>basic reading</b> right now: free, it just copies the text off the image.</p>
    <p class="hint">For <b>smart reading</b> (Claude writes a clean title, keeps only the useful details and links, and picks the list), add an Anthropic API key. Costs about 2–3¢ per screenshot.</p>
    <ol class="steps">
      <li><a class="link" href="${KEYS_URL}" target="_blank" rel="noopener">Create a key ↗</a> (sign up and add a few dollars of credit first)</li>
      <li>Paste it here (starts with <code>sk-ant-</code>):</li>
    </ol>
    <input id="aiKeyInput" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
    <button class="primary" data-action="saveAiKey">Turn on smart reading</button>`;
}

function showPendingShot() {
  const wrap = $('#capShot');
  if (!wrap) return;
  wrap.hidden = !pendingShot;
  $('#shotBtn').hidden = !!pendingShot;
  if (pendingShot) $('#capImg').src = pendingShot.dataUrl;
  $('#capText').placeholder = pendingShot ? 'Anything to add? (optional)' : "Anything on your mind…\nOne thing per line.";
}

async function attachScreenshot(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    pendingShot = await loadScreenshot(file);
    showPendingShot();
  } catch (e) {
    toast("Couldn't open that image");
  }
}

async function saveScreenshotCapture(btn) {
  const details = $('#capText').value.trim();
  const destWrap = $('#capDest');
  const dest = destWrap.dataset.dest;
  const userPicked = destWrap.dataset.touched === '1';
  btn.disabled = true;
  btn.textContent = aiKey ? '✨ Reading screenshot…' : '🔍 Reading screenshot…';
  let result;
  try {
    result = aiKey
      ? await readScreenshotSmart(pendingShot, details)
      : await readScreenshotBasic(pendingShot, details, (pct) => { btn.textContent = `🔍 Reading screenshot… ${pct}%`; });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Try again';
    toast(aiKey ? friendlyAIError(e) : e.message);
    return;
  }
  let note = (result.note || '').trim();
  const known = new Set(findLinks(note).map((l) => l.href));
  for (const l of findLinks((result.links || []).join(' '))) if (!known.has(l.href)) note += `${note ? '\n' : ''}${l.href}`;
  const aiList = listById(result.list) ? result.list : null;
  const list = userPicked ? (dest === 'inbox' || dest === 'today' ? null : dest) : aiList;
  const item = {
    id: uid(), text: (result.title || 'Screenshot note').trim(), note,
    list, today: dest === 'today' ? dayKey() : null,
    done: false, doneAt: null, createdAt: Date.now(),
  };
  S.items.push(item);
  pendingShot = null;
  commit();
  openItem(item.id); // show what was made so it can be tweaked
  toast('📸 Saved from screenshot');
}

/* ---------- actions ---------- */

const ACTIONS = {
  tab(el) {
    S.tab = el.dataset.tab;
    closeSheet();
    commit();
    window.scrollTo(0, 0);
  },
  closeSheet,
  settings: openSettings,
  capture: (el) => openCapture(el.dataset.dest),
  pickDest(el) {
    const wrap = $('#capDest');
    wrap.dataset.dest = el.dataset.dest;
    wrap.dataset.touched = '1';
    wrap.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === el));
  },
  removeShot() {
    pendingShot = null;
    $('#capFile').value = '';
    showPendingShot();
  },
  saveCapture(el) {
    if (pendingShot) { saveScreenshotCapture(el || $('[data-action=saveCapture]')); return; }
    const lines = $('#capText').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { closeSheet(); return; }
    const dest = $('#capDest').dataset.dest;
    const now = Date.now();
    lines.forEach((text, n) => S.items.push({
      id: uid(), text, note: '',
      list: dest === 'inbox' || dest === 'today' ? null : dest,
      today: dest === 'today' ? dayKey() : null,
      done: false, doneAt: null, createdAt: now + n,
    }));
    closeSheet();
    commit();
    toast(lines.length > 1 ? `Added ${lines.length} things ✓` : 'Added ✓');
  },

  toggle(el, ev) {
    const i = itemById(el.dataset.id);
    if (!i) return;
    i.done = !i.done;
    i.doneAt = i.done ? Date.now() : null;
    if (i.done) {
      el.classList.add('checked');
      addXP(XP_TASK, ev);
      setTimeout(commit, 350);
    } else {
      addXP(-XP_TASK);
      commit();
    }
  },
  openItem: (el) => openItem(el.dataset.id),
  editItem: (el) => openEditItem(el.dataset.id),
  saveItem(el) {
    const i = itemById(el.dataset.id);
    const text = $('#editText').value.trim();
    if (i && text) { i.text = text; i.note = $('#editNote').value.trim(); }
    closeSheet();
    commit();
  },
  deleteItem(el) {
    S.items = S.items.filter((i) => i.id !== el.dataset.id);
    closeSheet();
    commit();
  },
  moveItem(el) {
    const i = itemById(el.dataset.id);
    if (i) i.list = el.dataset.list || null;
    const l = listById(i?.list);
    closeSheet();
    commit();
    toast(`Moved to ${l ? `${l.emoji} ${l.name}` : '📥 Inbox'}`);
  },
  keepToday(el) {
    const i = itemById(el.dataset.id);
    if (i) i.today = dayKey();
    closeSheet();
    commit();
    if (S.tab !== 'today') toast('☀️ Added to Today');
  },
  sendBack(el) {
    const i = itemById(el.dataset.id);
    if (i) i.today = null;
    closeSheet();
    commit();
  },
  sendBackAll() {
    const tk = dayKey();
    S.items.forEach((i) => { if (!i.done && i.today && i.today < tk) i.today = null; });
    commit();
  },
  pickForToday: openPickForToday,
  pickToday(el) {
    const i = itemById(el.dataset.id);
    if (i) i.today = dayKey();
    el.classList.add('on');
    el.disabled = true;
    save();
    render();
  },
  makeHabit(el) {
    const i = itemById(el.dataset.id);
    if (!i) return;
    S.habits.push({ id: uid(), name: i.text, emoji: '⭐', days: [], log: {}, createdAt: Date.now() });
    S.items = S.items.filter((x) => x.id !== i.id);
    closeSheet();
    commit();
    toast('🔁 Now a daily habit — tweak it in Habits');
  },

  habitToday(el, ev) {
    const h = habitById(el.dataset.id);
    toggleHabitDay(h, dayKey(), ev);
  },
  habitDay(el, ev) {
    const h = habitById(el.dataset.id);
    toggleHabitDay(h, el.dataset.day, ev);
  },
  editHabit: (el) => openEditHabit(el.dataset.id),
  toggleDay: (el) => el.classList.toggle('on'),
  saveHabit(el) {
    const name = $('#habitName').value.trim();
    if (!name) { $('#habitName').focus(); return; }
    const emoji = $('#habitEmoji').value.trim() || '⭐';
    let days = [...document.querySelectorAll('#habitDays .chip.on')].map((c) => +c.dataset.day);
    if (days.length === 7 || days.length === 0) days = [];
    const h = habitById(el.dataset.id);
    if (h) Object.assign(h, { name, emoji, days });
    else S.habits.push({ id: uid(), name, emoji, days, log: {}, createdAt: Date.now() });
    closeSheet();
    commit();
  },
  deleteHabit(el) {
    if (!confirm('Delete this habit and its history?')) return;
    S.habits = S.habits.filter((h) => h.id !== el.dataset.id);
    closeSheet();
    commit();
  },

  collapse(el) {
    S.collapsed[el.dataset.id] = !S.collapsed[el.dataset.id];
    commit();
  },
  editList: (el) => openEditList(el.dataset.id),
  saveList(el) {
    const name = $('#listName').value.trim();
    if (!name) { $('#listName').focus(); return; }
    const emoji = $('#listEmoji').value.trim() || '📁';
    const l = listById(el.dataset.id);
    if (l) Object.assign(l, { name, emoji });
    else S.lists.push({ id: uid(), name, emoji });
    closeSheet();
    commit();
  },
  deleteList(el) {
    const id = el.dataset.id;
    if (!confirm('Delete this list? Its items move to your Inbox.')) return;
    S.items.forEach((i) => { if (i.list === id) i.list = null; });
    S.lists = S.lists.filter((l) => l.id !== id);
    lastInboxCount = null;
    closeSheet();
    commit();
  },

  openImport,
  previewImport,
  doImport,
  exportData,
  openRestore,
  doRestore,
  resetAll() {
    if (!confirm(`Erase all tasks, habits and XP${sync.token ? ' on all synced devices' : ''}? This cannot be undone.`)) return;
    const devices = Object.keys(S.xpBy);
    S = freshState();
    for (const dev of devices) S.xpBy[dev] = { xp: 0, at: Date.now() };
    lastInboxCount = null;
    closeSheet();
    commit();
  },
  async connectSync() {
    const token = $('#syncToken').value.trim();
    if (!token) { $('#syncToken').focus(); return; }
    sync = { token };
    saveSync();
    await syncNow();
    if (syncStatus === 'error') {
      const msg = syncError;
      sync = {};
      saveSync();
      setSyncStatus('off');
      toast(msg.includes('rejected') ? "That key didn't work. Check you copied all of it." : msg);
    } else {
      toast('☁️ Sync is on');
    }
  },
  async saveAiKey(el) {
    const key = $('#aiKeyInput').value.trim();
    if (!key) { $('#aiKeyInput').focus(); return; }
    el.disabled = true;
    el.textContent = 'Checking key…';
    const previous = aiKey;
    aiKey = key;
    try {
      const client = await anthropicClient();
      await client.models.retrieve(AI_MODEL); // free call that proves the key works
      localStorage.setItem(AI_KEY_STORAGE, key);
      $('#aiPanel').innerHTML = aiPanelHtml();
      toast('✨ Smart reading is on');
    } catch (e) {
      aiKey = previous;
      el.disabled = false;
      el.textContent = 'Turn on smart reading';
      toast(friendlyAIError(e));
    }
  },
  removeAiKey() {
    aiKey = '';
    try { localStorage.removeItem(AI_KEY_STORAGE); } catch (e) { /* ignore */ }
    $('#aiPanel').innerHTML = aiPanelHtml();
  },
  syncNow,
  disconnectSync() {
    if (!confirm('Stop syncing on this device? Your data stays here; other devices keep syncing.')) return;
    sync = {};
    saveSync();
    setSyncStatus('off');
  },
  dismissInstall() {
    S.installHintDismissed = true;
    $('#installHint').hidden = true;
    save();
  },
};

function toggleHabitDay(h, key, ev) {
  if (!h) return;
  if (h.log[key]) {
    delete h.log[key];
    addXP(-XP_HABIT);
  } else {
    h.log[key] = true;
    addXP(XP_HABIT, ev);
    const s = streak(h);
    if (key === dayKey() && s > 1 && [3, 7, 14, 21, 30, 50, 100].includes(s)) {
      setTimeout(() => toast(`🔥 ${s}-day streak on ${h.name}!`), 350);
    }
  }
  commit();
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) fn(el, ev);
});

document.addEventListener('change', (ev) => {
  if (ev.target.id === 'capFile') attachScreenshot(ev.target.files[0]);
});

// Pasting an image into the brain dump attaches it as a screenshot
document.addEventListener('paste', (ev) => {
  if (!$('#capText')) return;
  const file = [...(ev.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) {
    ev.preventDefault();
    attachScreenshot(file);
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('#sheet').hidden) closeSheet();
  // Cmd/Ctrl+Enter saves the brain dump
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && $('#capText')) ACTIONS.saveCapture();
  // On a keyboard, "n" opens the brain dump
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if (ev.key === 'n' && !typing && !ev.metaKey && !ev.ctrlKey && $('#sheet').hidden) {
    ev.preventDefault();
    openCapture();
  }
});

// Coming back to the app: re-render (e.g. after midnight) and pull changes from other devices
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  render();
  scheduleSync(0);
});
window.addEventListener('focus', () => scheduleSync(0));
window.addEventListener('online', () => scheduleSync(0));
setInterval(() => { if (!document.hidden) scheduleSync(0); }, 2 * 60 * 1000);

/* ---------- boot ---------- */

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
if (isIOS && !standalone && !S.installHintDismissed) $('#installHint').hidden = false;

lastInboxCount = inboxItems().length;
baseline();
render();
setSyncStatus(syncStatus);
scheduleSync(0);

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // When a new version takes over, reload once so it shows up right away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((reg) => document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); }))
    .catch(() => {});
}
