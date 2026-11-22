/* Pocketwise Budget — a weekly budget tracker.
 * All data lives in this browser (localStorage). Use Settings → Export to back it up. */
'use strict';

// ======================= Storage & state =======================
const STORE_KEY = 'pocketwise.v1';
const PALETTE = ['#6d4dff', '#18b98d', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6', '#8b5cf6', '#f97316', '#64748b', '#84cc16', '#06b6d4'];
const EMOJIS = ['🍔', '🛒', '🚗', '🛍️', '🎬', '💡', '💊', '🔁', '🎁', '📦', '☕', '🍺', '✈️', '🏠', '📱', '💻', '🎮', '👕', '💇', '🐶', '📚', '🏋️', '⛽', '🚌', '🎵', '🍕', '🧾', '💳', '🎓', '👶', '🌱', '🎟️', '🚲', '⌚', '👟', '🎧', '🛋️', '🏖️', '💍', '🚙'];

const DEFAULT_CATEGORIES = [
  ['Food & Dining', '🍔'], ['Groceries', '🛒'], ['Transport', '🚗'], ['Shopping', '🛍️'],
  ['Entertainment', '🎬'], ['Bills & Utilities', '💡'], ['Health', '💊'], ['Subscriptions', '🔁'],
  ['Gifts', '🎁'], ['Other', '📦'],
].map(([name, icon], i) => ({ id: 'c' + (i + 1), name, icon, color: PALETTE[i % PALETTE.length], limit: 0 }));

function freshState() {
  return {
    version: 1,
    settings: { weeklyBudget: 0, currency: 'USD', weekStart: 1, rollover: false, theme: 'system', startDate: null, onboarded: false },
    budgetHistory: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    expenses: [],
    subscriptions: [],
    goals: [],
  };
}

let S = load();
let UI = { view: 'dashboard', actFilter: { q: '', cat: 'all', period: 'month' }, catRange: 'week', lastDeleted: null };

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const base = freshState();
      const data = JSON.parse(raw);
      return { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) } };
    }
  } catch (e) { console.warn('Could not load saved data', e); }
  return freshState();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
  catch (e) { toast('Could not save — storage may be full or blocked'); }
}
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ======================= Helpers =======================
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => toISO(new Date());
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return toISO(d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const sum = (arr, f = (x) => x) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round2 = (n) => Math.round(n * 100) / 100;

function addMonths(s, n, anchorDay) {
  const d = parse(s);
  const day = anchorDay || d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last));
  return toISO(t);
}

let _fmt;
function money(n, opts = {}) {
  if (!_fmt || _fmt.cur !== S.settings.currency) {
    _fmt = {
      cur: S.settings.currency,
      full: new Intl.NumberFormat(undefined, { style: 'currency', currency: S.settings.currency }),
      short: new Intl.NumberFormat(undefined, { style: 'currency', currency: S.settings.currency, maximumFractionDigits: 0 }),
    };
  }
  const v = Number(n) || 0;
  if (opts.short && Math.abs(v) >= 1000) return _fmt.short.format(v);
  return _fmt.full.format(v);
}
function compact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1000) return new Intl.NumberFormat(undefined, { style: 'currency', currency: S.settings.currency, notation: 'compact', maximumFractionDigits: 1 }).format(v);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: S.settings.currency, maximumFractionDigits: 0 }).format(v);
}
const fmtDate = (s, o = { month: 'short', day: 'numeric' }) => parse(s).toLocaleDateString(undefined, o);
function relDay(s) {
  const d = daysBetween(today(), s);
  if (d === 0) return 'Today';
  if (d === -1) return 'Yesterday';
  if (d === 1) return 'Tomorrow';
  if (d > 1 && d < 7) return `In ${d} days`;
  return fmtDate(s, { weekday: 'short', month: 'short', day: 'numeric' });
}

const catById = (id) => S.categories.find((c) => c.id === id) || { id, name: 'Uncategorized', icon: '❔', color: '#94a3b8' };
const otherCat = () => S.categories.find((c) => c.name === 'Other') || S.categories[S.categories.length - 1];
const subsCat = () => S.categories.find((c) => c.name === 'Subscriptions') || otherCat();

// ======================= Budget engine =======================
function weekStartOf(s) {
  const d = parse(s);
  const diff = (d.getDay() - Number(S.settings.weekStart) + 7) % 7;
  d.setDate(d.getDate() - diff);
  return toISO(d);
}
function budgetFor(weekStart) {
  const h = [...S.budgetHistory].sort((a, b) => a.from.localeCompare(b.from));
  if (!h.length) return Number(S.settings.weeklyBudget) || 0;
  let amt = h[0].amount;
  for (const e of h) if (e.from <= weekStart) amt = e.amount;
  return amt;
}
function inRange(date, a, b) { return date >= a && date <= b; }

function firstDate() {
  const dates = [S.settings.startDate, ...S.expenses.map((e) => e.date)].filter(Boolean).sort();
  return dates[0] || today();
}

/** Every week from the first tracked week up to the current week, oldest first. */
function computeWeeks() {
  const cur = weekStartOf(today());
  let ws = weekStartOf(firstDate());
  if (ws > cur) ws = cur;
  const spentBy = {};
  for (const e of S.expenses) { const k = weekStartOf(e.date); spentBy[k] = (spentBy[k] || 0) + e.amount; }
  const setAsideBy = {};
  for (const g of S.goals) for (const c of g.contributions || []) if (c.fromBudget) { const k = weekStartOf(c.date); setAsideBy[k] = (setAsideBy[k] || 0) + c.amount; }
  const weeks = [];
  let prevLeft = 0;
  let guard = 0;
  while (ws <= cur && guard++ < 1500) {
    const budget = budgetFor(ws);
    const spent = round2(spentBy[ws] || 0);
    const setAside = round2(setAsideBy[ws] || 0);
    const carryIn = S.settings.rollover ? prevLeft : 0;
    const available = budget + carryIn;
    const left = round2(available - spent - setAside);
    weeks.push({ start: ws, end: addDays(ws, 6), budget, spent, setAside, carryIn, available, left, current: ws === cur });
    prevLeft = left;
    ws = addDays(ws, 7);
  }
  return weeks;
}

function stats() {
  const weeks = computeWeeks();
  const cw = weeks[weeks.length - 1];
  const done = weeks.slice(0, -1);
  const t = today();
  const lifetime = sum(S.expenses, (e) => e.amount);
  const monthKey = t.slice(0, 7);
  const month = sum(S.expenses.filter((e) => e.date.startsWith(monthKey)), (e) => e.amount);
  const lastMonthKey = addMonths(monthKey + '-01', -1).slice(0, 7);
  const lastMonth = sum(S.expenses.filter((e) => e.date.startsWith(lastMonthKey)), (e) => e.amount);
  const avgWeek = done.length ? sum(done, (w) => w.spent) / done.length : cw.spent;
  const unspent = sum(done, (w) => w.budget - w.spent);
  let streak = 0;
  for (let i = done.length - 1; i >= 0; i--) { if (done[i].spent <= done[i].budget) streak++; else break; }
  const daysLeft = daysBetween(t, cw.end) + 1;
  const daysIn = 7 - daysLeft + 1;
  const perDay = cw.left > 0 ? cw.left / daysLeft : 0;
  const pace = cw.spent / Math.max(1, daysIn) * 7;
  return { weeks, cw, done, lifetime, month, lastMonth, avgWeek, unspent, streak, daysLeft, perDay, pace };
}

function catSpend(from, to) {
  const m = {};
  for (const e of S.expenses) if (inRange(e.date, from, to)) m[e.categoryId] = (m[e.categoryId] || 0) + e.amount;
  return m;
}

// ======================= Subscriptions engine =======================
function advanceSub(sub) {
  if (sub.cycle === 'weekly') sub.nextDate = addDays(sub.nextDate, 7);
  else if (sub.cycle === 'biweekly') sub.nextDate = addDays(sub.nextDate, 14);
  else if (sub.cycle === 'quarterly') sub.nextDate = addMonths(sub.nextDate, 3, sub.anchorDay);
  else if (sub.cycle === 'yearly') sub.nextDate = addMonths(sub.nextDate, 12, sub.anchorDay);
  else sub.nextDate = addMonths(sub.nextDate, 1, sub.anchorDay);
}
function monthlyCost(sub) {
  const a = Number(sub.amount) || 0;
  return { weekly: a * 52 / 12, biweekly: a * 26 / 12, monthly: a, quarterly: a / 3, yearly: a / 12 }[sub.cycle] ?? a;
}
function logSubCharge(sub, date) {
  S.expenses.push({ id: uid(), amount: Number(sub.amount), categoryId: sub.categoryId || subsCat().id, note: sub.name, date, subId: sub.id, createdAt: Date.now() });
}
/** Auto-log any subscription charges that came due since the app was last opened. */
function processSubscriptions() {
  const t = today();
  let n = 0;
  for (const sub of S.subscriptions) {
    if (!sub.active || !sub.autoLog || !sub.nextDate) continue;
    let guard = 0;
    while (sub.nextDate <= t && guard++ < 120) { logSubCharge(sub, sub.nextDate); advanceSub(sub); n++; }
  }
  if (n) { save(); setTimeout(() => toast(`Logged ${n} subscription charge${n > 1 ? 's' : ''}`), 400); }
}

// ======================= Charts (SVG) =======================
function ring(pct, { size = 150, stroke = 14, color = '#fff', track = 'rgba(255,255,255,.22)' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = clamp(pct, 0, 1);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c * p} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})" style="transition:stroke-dasharray .6s"/>
  </svg>`;
}
function donut(segs, { size = 170, stroke = 26, center = '' } = {}) {
  const total = sum(segs, (s) => s.value);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  const gap = segs.length > 1 ? 2 : 0;
  const arcs = total ? segs.map((s) => {
    const len = (s.value / total) * c;
    const a = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${stroke}"
      stroke-dasharray="${Math.max(0, len - gap)} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(s.label)}: ${money(s.value)}</title></circle>`;
    off += len;
    return a;
  }).join('') : '';
  return `<div style="position:relative;width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--bg-2)" stroke-width="${stroke}"/>${arcs}
    </svg>
    <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center">${center}</div>
  </div>`;
}
/** Vertical bar chart. data: [{label, value, target?, highlight?}] */
function bars(data, { height = 190, color = 'var(--accent)', showTarget = true, width = 640 } = {}) {
  const W = width, H = height, padB = 30, padT = 22;
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, showTarget ? d.target || 0 : 0))) * 1.08;
  const n = data.length || 1;
  const slot = W / n;
  const bw = Math.min(42, slot * 0.62);
  const y = (v) => H - padB - (v / max) * (H - padB - padT);
  const out = data.map((d, i) => {
    const x = i * slot + (slot - bw) / 2;
    const over = showTarget && d.target && d.value > d.target;
    const fill = d.highlight ? 'var(--accent-2)' : over ? 'var(--bad)' : color;
    const top = y(d.value);
    const h = Math.max(0, H - padB - top);
    let s = `<rect x="${x}" y="${top}" width="${bw}" height="${h}" rx="6" fill="${fill}" opacity="${d.highlight ? 1 : 0.85}"><title>${esc(d.label)}: ${money(d.value)}${d.target ? ' of ' + money(d.target) : ''}</title></rect>`;
    if (showTarget && d.target) s += `<line x1="${x - 4}" x2="${x + bw + 4}" y1="${y(d.target)}" y2="${y(d.target)}" stroke="var(--text)" stroke-opacity=".45" stroke-width="2" stroke-dasharray="4 3"/>`;
    if (d.value > 0 && n <= 14) s += `<text x="${x + bw / 2}" y="${top - 5}" text-anchor="middle" style="font-size:13px;font-weight:600">${compact(d.value)}</text>`;
    s += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
    return s;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" stroke="var(--border)"/>${out}</svg>`;
}

// ======================= Navigation =======================
const ICON = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  dashboard: ICON('<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>'),
  activity: ICON('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  categories: ICON('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  subscriptions: ICON('<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/>'),
  goals: ICON('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  insights: ICON('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
  settings: ICON('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  more: ICON('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  sun: ICON('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: ICON('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
};
const VIEWS = {
  dashboard: { label: 'Dashboard', ico: ICONS.dashboard, render: renderDashboard },
  activity: { label: 'Activity', ico: ICONS.activity, render: renderActivity },
  categories: { label: 'Categories', ico: ICONS.categories, render: renderCategories },
  subscriptions: { label: 'Subscriptions', ico: ICONS.subscriptions, render: renderSubscriptions },
  goals: { label: 'Wishlist & Goals', ico: ICONS.goals, render: renderGoals },
  insights: { label: 'Insights', ico: ICONS.insights, render: renderInsights },
  settings: { label: 'Settings', ico: ICONS.settings, render: renderSettings },
  more: { label: 'More', ico: ICONS.more, render: renderMore, hidden: true },
};
const MOBILE_NAV = [['dashboard', 'Home'], ['activity', 'Activity'], ['subscriptions', 'Subs'], ['goals', 'Goals'], ['more', 'More']];

function renderNav() {
  $('#nav').innerHTML = Object.entries(VIEWS).filter(([, v]) => !v.hidden)
    .map(([k, v]) => `<a href="#${k}" class="${UI.view === k ? 'active' : ''}"><span class="ico">${v.ico}</span>${v.label}</a>`).join('');
  const moreViews = ['categories', 'insights', 'settings', 'more'];
  $('#bottom-nav').innerHTML = MOBILE_NAV.map(([k, label]) => {
    const active = UI.view === k || (k === 'more' && moreViews.includes(UI.view));
    return `<a href="#${k}" class="${active ? 'active' : ''}"><span class="ico">${VIEWS[k].ico}</span>${label}</a>`;
  }).join('');
}

function render() {
  const v = VIEWS[UI.view] || VIEWS.dashboard;
  renderNav();
  $('#view-title').textContent = v.label;
  $('#view-sub').textContent = '';
  $('#view').innerHTML = v.render();
}

function route() {
  const h = location.hash.slice(1) || 'dashboard';
  UI.view = VIEWS[h] ? h : 'dashboard';
  render();
  window.scrollTo(0, 0);
}

// ======================= Views =======================
function expenseRow(e, { showDate = false } = {}) {
  const c = catById(e.categoryId);
  const refund = e.amount < 0;
  const sub = [c.name, showDate ? relDay(e.date) : '', e.subId ? 'Subscription' : ''].filter(Boolean).join(' · ');
  return `<div class="row clickable" data-action="edit-expense" data-id="${e.id}">
    <div class="avatar" style="background:${c.color}22">${c.icon}</div>
    <div class="grow"><div class="title">${esc(e.note || c.name)}</div><div class="sub">${esc(sub)}</div></div>
    <div class="amt num ${refund ? 'good' : ''}">${refund ? '+' : '−'}${money(Math.abs(e.amount))}</div>
  </div>`;
}

function emptyState(ico, text, btn = '') {
  return `<div class="empty"><div class="e-ico">${ico}</div><div>${text}</div>${btn ? `<div style="margin-top:14px">${btn}</div>` : ''}</div>`;
}

function renderDashboard() {
  const st = stats();
  const { cw } = st;
  const pct = cw.available > 0 ? (cw.spent + cw.setAside) / cw.available : (cw.spent > 0 ? 1 : 0);
  const over = cw.left < 0;
  $('#view-sub').textContent = `Week of ${fmtDate(cw.start)} – ${fmtDate(cw.end)}`;

  const cs = catSpend(cw.start, cw.end);
  const catRows = S.categories
    .map((c) => ({ c, spent: cs[c.id] || 0 }))
    .filter((x) => x.spent > 0 || x.c.limit > 0)
    .sort((a, b) => b.spent - a.spent);

  const recent = [...S.expenses].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 6);
  const upcoming = S.subscriptions.filter((s) => s.active && s.nextDate && daysBetween(today(), s.nextDate) <= 14)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate)).slice(0, 5);
  const last8 = st.weeks.slice(-8).map((w) => ({ label: fmtDate(w.start, { month: 'numeric', day: 'numeric' }), value: w.spent, target: w.budget, highlight: w.current }));
  const lmDelta = st.lastMonth ? (st.month - st.lastMonth) / st.lastMonth : 0;

  return `
  <div class="grid" style="gap:16px">
    <div class="card hero">
      <div class="ring-wrap">${ring(pct, { color: over ? '#ffd3d5' : '#fff' })}
        <div class="ring-center"><div><b>${Math.round(pct * 100)}%</b><span>used</span></div></div>
      </div>
      <div style="position:relative;z-index:1">
        <div class="muted" style="font-weight:600">${over ? 'Over budget by' : 'Left to spend this week'}</div>
        <div class="big num">${money(Math.abs(cw.left))}</div>
        <div class="muted" style="margin-top:4px">${over ? 'Try to hold off on non-essentials until next week.' :
          `That's <b style="color:#fff">${money(st.perDay)}/day</b> for the next ${st.daysLeft} day${st.daysLeft > 1 ? 's' : ''}.`}</div>
        <div class="chips">
          <span class="chip">Spent ${money(cw.spent)}</span>
          <span class="chip">Budget ${money(cw.budget)}</span>
          ${cw.carryIn ? `<span class="chip">Rolled over ${cw.carryIn > 0 ? '+' : ''}${money(cw.carryIn)}</span>` : ''}
          ${cw.setAside ? `<span class="chip">Saved to goals ${money(cw.setAside)}</span>` : ''}
          <span class="chip">Pace ${money(st.pace)}/wk</span>
        </div>
      </div>
    </div>

    <div class="grid g-4">
      <div class="card stat"><div class="label">💸 Lifetime spent</div><div class="value num">${money(st.lifetime, { short: true })}</div><div class="foot">${S.expenses.length} transactions since ${fmtDate(firstDate(), { month: 'short', year: 'numeric' })}</div></div>
      <div class="card stat"><div class="label">📅 This month</div><div class="value num">${money(st.month, { short: true })}</div><div class="foot">${st.lastMonth ? `<span class="${lmDelta > 0 ? 'bad' : 'good'}">${lmDelta > 0 ? '▲' : '▼'} ${Math.abs(Math.round(lmDelta * 100))}%</span> vs last month` : 'No data for last month'}</div></div>
      <div class="card stat"><div class="label">📊 Avg per week</div><div class="value num">${money(st.avgWeek, { short: true })}</div><div class="foot">over ${Math.max(1, st.done.length)} week${st.done.length === 1 ? '' : 's'}</div></div>
      <div class="card stat"><div class="label">🔥 Under-budget streak</div><div class="value num">${st.streak} wk${st.streak === 1 ? '' : 's'}</div><div class="foot">${st.unspent >= 0 ? `<span class="good">${money(st.unspent, { short: true })}</span> unspent all-time` : `<span class="bad">${money(-st.unspent, { short: true })}</span> over all-time`}</div></div>
    </div>

    <div class="grid g-2">
      <div class="card">
        <h3>This week by category <a class="btn sm" href="#categories">Manage</a></h3>
        ${catRows.length ? `<div class="list">${catRows.map(({ c, spent }) => {
          const lim = c.limit || 0;
          const p = lim ? spent / lim : (cw.spent ? spent / cw.spent : 0);
          const col = lim && spent > lim ? 'var(--bad)' : lim && spent > lim * 0.8 ? 'var(--warn)' : c.color;
          return `<div style="padding:9px 0">
            <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:14px">
              <span>${c.icon} <b style="font-weight:600">${esc(c.name)}</b></span>
              <span class="num">${money(spent)}${lim ? ` <span class="muted">/ ${money(lim)}</span>` : ''}</span>
            </div>
            <div class="bar"><i style="width:${clamp(p, 0, 1) * 100}%;background:${col}"></i></div>
          </div>`;
        }).join('')}</div>` : emptyState('🌤️', 'No spending yet this week.')}
      </div>

      <div class="card">
        <h3>Recent activity <a class="btn sm" href="#activity">See all</a></h3>
        ${recent.length ? `<div class="list">${recent.map((e) => expenseRow(e, { showDate: true })).join('')}</div>` :
          emptyState('🧾', 'Nothing logged yet.', '<button class="btn primary" data-action="add-expense">Add your first expense</button>')}
      </div>
    </div>

    <div class="grid g-3">
      <div class="card span-2">
        <h3>Last 8 weeks <span class="muted">dashed line = budget</span></h3>
        ${bars(last8, { width: 560 })}
      </div>
      <div class="card">
        <h3>Upcoming bills <a class="btn sm" href="#subscriptions">All</a></h3>
        ${upcoming.length ? `<div class="list">${upcoming.map((s) => {
          const c = catById(s.categoryId);
          return `<div class="row"><div class="avatar" style="background:${c.color}22">${s.icon || c.icon}</div>
            <div class="grow"><div class="title">${esc(s.name)}</div><div class="sub">${relDay(s.nextDate)}</div></div>
            <div class="amt num">${money(s.amount)}</div></div>`;
        }).join('')}</div>` : emptyState('📭', 'No bills in the next 2 weeks.')}
      </div>
    </div>

    ${S.goals.length ? `<div class="card"><h3>Goals <a class="btn sm" href="#goals">All goals</a></h3>
      <div class="grid g-3">${S.goals.slice(0, 3).map((g) => {
        const p = g.price ? g.saved / g.price : 0;
        return `<div><div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px"><span>${g.icon || '★'} <b>${esc(g.name)}</b></span><span class="num muted">${Math.round(p * 100)}%</span></div>
          <div class="bar"><i style="width:${clamp(p, 0, 1) * 100}%;background:var(--grad)"></i></div>
          <div class="small muted" style="margin-top:6px">${money(g.saved)} of ${money(g.price)}</div></div>`;
      }).join('')}</div></div>` : ''}
  </div>`;
}

function periodRange(p) {
  const t = today();
  if (p === 'week') { const s = weekStartOf(t); return [s, addDays(s, 6)]; }
  if (p === 'lastweek') { const s = addDays(weekStartOf(t), -7); return [s, addDays(s, 6)]; }
  if (p === 'month') return [t.slice(0, 8) + '01', t.slice(0, 8) + '31'];
  if (p === 'lastmonth') { const s = addMonths(t.slice(0, 8) + '01', -1); return [s, s.slice(0, 8) + '31']; }
  if (p === 'year') return [t.slice(0, 4) + '-01-01', t.slice(0, 4) + '-12-31'];
  return ['0000-01-01', '9999-12-31'];
}
const PERIODS = [['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'This year'], ['all', 'All time']];

function filteredExpenses() {
  const f = UI.actFilter;
  const [a, b] = periodRange(f.period);
  const q = f.q.trim().toLowerCase();
  return S.expenses.filter((e) => inRange(e.date, a, b) && (f.cat === 'all' || e.categoryId === f.cat) &&
    (!q || (e.note || '').toLowerCase().includes(q) || catById(e.categoryId).name.toLowerCase().includes(q) || String(e.amount).includes(q)))
    .sort((x, y) => y.date.localeCompare(x.date) || y.createdAt - x.createdAt);
}

function renderActivity() {
  const f = UI.actFilter;
  const list = filteredExpenses();
  const total = sum(list, (e) => e.amount);
  const byDay = {};
  for (const e of list) (byDay[e.date] = byDay[e.date] || []).push(e);
  $('#view-sub').textContent = `${list.length} transaction${list.length === 1 ? '' : 's'} · ${money(total)} total`;
  return `
  <div class="card">
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search notes, categories, amounts…" value="${esc(f.q)}" data-input="act-q" />
      <select class="input" style="width:auto" data-change="act-period">${PERIODS.map(([k, l]) => `<option value="${k}" ${f.period === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn" data-action="export-csv">⇩ CSV</button>
    </div>
    <div class="chips-scroll" style="margin-bottom:8px">
      <button class="chip ${f.cat === 'all' ? 'sel' : ''}" data-action="act-cat" data-id="all">All</button>
      ${S.categories.map((c) => `<button class="chip ${f.cat === c.id ? 'sel' : ''}" data-action="act-cat" data-id="${c.id}">${c.icon} ${esc(c.name)}</button>`).join('')}
    </div>
    <div id="act-list">${activityList(byDay)}</div>
  </div>`;
}
function activityList(byDay) {
  const days = Object.keys(byDay).sort().reverse();
  if (!days.length) return emptyState('🔍', 'No transactions match.');
  return days.map((d) => `<div class="day-head"><span>${relDay(d)}</span><span class="num">${money(sum(byDay[d], (e) => e.amount))}</span></div>
    <div class="list">${byDay[d].map((e) => expenseRow(e)).join('')}</div>`).join('');
}

function renderCategories() {
  const [ws, we] = periodRange('week');
  const [ms, me] = periodRange('month');
  const wk = catSpend(ws, we), mo = catSpend(ms, me), all = catSpend('0000-01-01', '9999-12-31');
  const counts = {};
  for (const e of S.expenses) counts[e.categoryId] = (counts[e.categoryId] || 0) + 1;
  const totalLimits = sum(S.categories, (c) => c.limit);
  $('#view-sub').textContent = `${S.categories.length} categories${totalLimits ? ` · ${money(totalLimits)} in weekly limits` : ''}`;
  return `
  <div class="toolbar"><div style="flex:1" class="muted small">Tap a category to rename it, change its icon or set a weekly spending limit.</div>
    <button class="btn primary" data-action="add-category">+ New category</button></div>
  <div class="grid g-3">${S.categories.map((c) => {
    const spent = wk[c.id] || 0;
    const p = c.limit ? spent / c.limit : 0;
    return `<div class="card row clickable" style="display:block;border-bottom:1px solid var(--border)" data-action="edit-category" data-id="${c.id}">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
        <div class="avatar" style="background:${c.color}22">${c.icon}</div>
        <div class="grow"><div class="title">${esc(c.name)}</div><div class="sub">${counts[c.id] || 0} transactions</div></div>
      </div>
      <div class="kv"><span>This week</span><b class="num">${money(spent)}${c.limit ? ` / ${money(c.limit)}` : ''}</b></div>
      ${c.limit ? `<div class="bar" style="margin:6px 0"><i style="width:${clamp(p, 0, 1) * 100}%;background:${p > 1 ? 'var(--bad)' : p > 0.8 ? 'var(--warn)' : c.color}"></i></div>` : ''}
      <div class="kv"><span>This month</span><span class="num">${money(mo[c.id] || 0)}</span></div>
      <div class="kv"><span>Lifetime</span><span class="num">${money(all[c.id] || 0)}</span></div>
    </div>`;
  }).join('')}</div>`;
}

const CYCLES = [['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']];
function renderSubscriptions() {
  const active = S.subscriptions.filter((s) => s.active);
  const monthly = sum(active, monthlyCost);
  const paid = sum(S.expenses.filter((e) => e.subId), (e) => e.amount);
  const list = [...S.subscriptions].sort((a, b) => (b.active - a.active) || (a.nextDate || '').localeCompare(b.nextDate || ''));
  const next = active.filter((s) => s.nextDate).sort((a, b) => a.nextDate.localeCompare(b.nextDate))[0];
  const weeklyShare = S.settings.weeklyBudget ? (monthly * 12 / 52) / S.settings.weeklyBudget : 0;
  $('#view-sub').textContent = `${active.length} active`;
  return `
  <div class="grid g-4" style="margin-bottom:16px">
    <div class="card stat"><div class="label">Per month</div><div class="value num">${money(monthly)}</div><div class="foot">${money(monthly * 12 / 52)}/week equivalent</div></div>
    <div class="card stat"><div class="label">Per year</div><div class="value num">${money(monthly * 12, { short: true })}</div><div class="foot">if nothing changes</div></div>
    <div class="card stat"><div class="label">Share of weekly budget</div><div class="value num ${weeklyShare > 0.3 ? 'warn' : ''}">${Math.round(weeklyShare * 100)}%</div><div class="foot">eaten by subscriptions</div></div>
    <div class="card stat"><div class="label">Paid to date</div><div class="value num">${money(paid, { short: true })}</div><div class="foot">${next ? `Next: ${esc(next.name)} ${relDay(next.nextDate).toLowerCase()}` : 'Nothing scheduled'}</div></div>
  </div>
  <div class="card">
    <h3>Your subscriptions <button class="btn primary sm" data-action="add-sub">+ Add subscription</button></h3>
    ${list.length ? `<div class="list">${list.map((s) => {
      const c = catById(s.categoryId);
      const due = s.nextDate ? daysBetween(today(), s.nextDate) : null;
      return `<div class="row clickable" data-action="edit-sub" data-id="${s.id}" style="${s.active ? '' : 'opacity:.55'}">
        <div class="avatar" style="background:${c.color}22">${s.icon || c.icon}</div>
        <div class="grow"><div class="title">${esc(s.name)}</div>
          <div class="sub">${CYCLES.find((x) => x[0] === s.cycle)?.[1] || s.cycle} · ${s.active ? (s.nextDate ? `next ${relDay(s.nextDate).toLowerCase()}` : 'no date') : 'paused'}${s.autoLog && s.active ? ' · auto-logs' : ''}</div></div>
        ${s.active && due !== null && due <= 3 ? `<span class="chip" style="color:var(--warn)">Due soon</span>` : ''}
        <div style="text-align:right"><div class="amt num">${money(s.amount)}</div><div class="sub small">${money(monthlyCost(s))}/mo</div></div>
      </div>`;
    }).join('')}</div>` : emptyState('🔁', 'Track Netflix, Spotify, gym, phone bill… and see what they really cost you per year.', '<button class="btn primary" data-action="add-sub">Add a subscription</button>')}
  </div>`;
}

function goalMath(g) {
  const remaining = Math.max(0, g.price - g.saved);
  const contribs = g.contributions || [];
  const t = today();
  let perWeek = null, weeksLeft = null;
  if (g.targetDate) {
    weeksLeft = Math.max(0, daysBetween(t, g.targetDate) / 7);
    perWeek = weeksLeft > 0 ? remaining / weeksLeft : remaining;
  }
  // Recent saving rate: contributions over the last 8 weeks.
  const since = addDays(t, -56);
  const recent = sum(contribs.filter((c) => c.date >= since), (c) => c.amount);
  const first = contribs.length ? contribs.map((c) => c.date).sort()[0] : t;
  const spanWeeks = clamp(daysBetween(first < since ? since : first, t) / 7, 1, 8);
  const rate = recent / spanWeeks;
  const eta = rate > 0 && remaining > 0 ? addDays(t, Math.ceil((remaining / rate) * 7)) : null;
  return { remaining, perWeek, weeksLeft, rate, eta };
}

function renderGoals() {
  const totalNeed = sum(S.goals, (g) => Math.max(0, g.price - g.saved));
  const totalSaved = sum(S.goals, (g) => g.saved);
  const st = stats();
  $('#view-sub').textContent = S.goals.length ? `${money(totalSaved)} saved · ${money(totalNeed)} to go` : 'Things you want, and how to get there';
  const wantsPerWeek = sum(S.goals.map(goalMath), (m) => m.perWeek || 0);
  return `
  ${S.goals.length ? `<div class="grid g-3" style="margin-bottom:16px">
    <div class="card stat"><div class="label">Total saved</div><div class="value num">${money(totalSaved)}</div><div class="foot">across ${S.goals.length} goal${S.goals.length > 1 ? 's' : ''}</div></div>
    <div class="card stat"><div class="label">Still needed</div><div class="value num">${money(totalNeed)}</div><div class="foot">${S.goals.filter((g) => g.saved >= g.price).length} goal(s) fully funded</div></div>
    <div class="card stat"><div class="label">Needed per week</div><div class="value num ${wantsPerWeek > Math.max(0, st.cw.budget - st.avgWeek) ? 'warn' : ''}">${money(wantsPerWeek)}</div><div class="foot">to hit every target date · you usually leave ${money(Math.max(0, st.cw.budget - st.avgWeek))}/wk unspent</div></div>
  </div>` : ''}
  <div class="toolbar"><div style="flex:1"></div><button class="btn primary" data-action="add-goal">+ New goal</button></div>
  ${S.goals.length ? `<div class="grid g-3">${S.goals.map((g) => {
    const m = goalMath(g);
    const p = g.price ? g.saved / g.price : 0;
    const done = g.saved >= g.price;
    return `<div class="card goal-card">
      <div class="goal-top"><div class="avatar" style="background:var(--accent-soft)">${g.icon || '★'}</div>
        <div class="grow"><div class="title" style="font-weight:700">${esc(g.name)}</div><div class="sub muted small">${g.targetDate ? `by ${fmtDate(g.targetDate, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'No deadline'}</div></div>
        <button class="icon-btn" data-action="edit-goal" data-id="${g.id}" aria-label="Edit">✎</button></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="goal-amt num">${money(g.saved)}</span><span class="muted num">of ${money(g.price)}</span></div>
      <div class="bar"><i style="width:${clamp(p, 0, 1) * 100}%"></i></div>
      ${done ? `<div class="good" style="font-weight:700;margin:8px 0">🎉 Fully funded — go get it!</div>` : `
        <div class="kv"><span>Remaining</span><b class="num">${money(m.remaining)}</b></div>
        ${m.perWeek !== null ? `<div class="kv"><span>Save per week</span><b class="num">${money(m.perWeek)}</b></div>
        <div class="kv"><span>Save per day</span><span class="num">${money(m.perWeek / 7)}</span></div>
        <div class="kv"><span>Weeks left</span><span class="num">${Math.ceil(m.weeksLeft)}</span></div>` : ''}
        <div class="kv"><span>Your pace</span><span class="num">${m.rate > 0 ? `${money(m.rate)}/wk → ${fmtDate(m.eta, { month: 'short', year: 'numeric' })}` : 'not started'}</span></div>`}
      <div class="form-actions" style="margin-top:12px">
        ${g.saved > 0 ? `<button class="btn sm" data-action="withdraw-goal" data-id="${g.id}">− Withdraw</button>` : ''}
        <button class="btn primary sm" data-action="contribute-goal" data-id="${g.id}">+ Add savings</button>
      </div>
    </div>`;
  }).join('')}</div>` : `<div class="card">${emptyState('🎯', 'Add something you want — a trip, new shoes, an emergency fund — and see exactly how much to put away each week.', '<button class="btn primary" data-action="add-goal">Create a goal</button>')}</div>`}`;
}

function renderInsights() {
  const st = stats();
  const range = UI.catRange;
  const [a, b] = periodRange(range);
  const cs = catSpend(a, b);
  const segs = S.categories.map((c) => ({ label: `${c.icon} ${c.name}`, value: cs[c.id] || 0, color: c.color })).filter((s) => s.value > 0).sort((x, y) => y.value - x.value);
  const segTotal = sum(segs, (s) => s.value);

  const weeks12 = st.weeks.slice(-12).map((w) => ({ label: fmtDate(w.start, { month: 'numeric', day: 'numeric' }), value: w.spent, target: w.budget, highlight: w.current }));

  // Monthly totals, last 6 months
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const k = addMonths(today().slice(0, 8) + '01', -i).slice(0, 7);
    months.push({ label: parse(k + '-01').toLocaleDateString(undefined, { month: 'short' }), value: sum(S.expenses.filter((e) => e.date.startsWith(k)), (e) => e.amount), highlight: i === 0 });
  }

  // Day-of-week averages
  const dowNames = [...Array(7)].map((_, i) => new Date(2024, 0, 7 + ((i + Number(S.settings.weekStart)) % 7)).toLocaleDateString(undefined, { weekday: 'short' }));
  const dowTot = Array(7).fill(0);
  for (const e of S.expenses) dowTot[(parse(e.date).getDay() - Number(S.settings.weekStart) + 7) % 7] += e.amount;
  const nWeeks = Math.max(1, st.weeks.length);
  const dow = dowTot.map((v, i) => ({ label: dowNames[i], value: v / nWeeks }));
  const topDow = dow.reduce((m, d, i) => (d.value > dow[m].value ? i : m), 0);

  // Top places / notes
  const notes = {};
  for (const e of S.expenses) if (e.note && e.amount > 0) { const k = e.note.trim().toLowerCase(); notes[k] = notes[k] || { name: e.note.trim(), total: 0, n: 0 }; notes[k].total += e.amount; notes[k].n++; }
  const topNotes = Object.values(notes).sort((x, y) => y.total - x.total).slice(0, 6);

  // Heatmap: last 5 weeks of daily spending
  const hmStart = addDays(weekStartOf(today()), -28);
  const daily = {};
  for (const e of S.expenses) if (e.date >= hmStart) daily[e.date] = (daily[e.date] || 0) + e.amount;
  const hmMax = Math.max(1, ...Object.values(daily));

  // Written insights
  const tips = [];
  const cw = st.cw, lw = st.weeks[st.weeks.length - 2];
  if (cw.spent > 0 && st.pace > cw.budget && cw.budget) tips.push(['⚠️', `At this pace you'll spend about <b>${money(st.pace)}</b> this week — ${money(st.pace - cw.budget)} over budget.`]);
  else if (cw.budget && cw.spent > 0) tips.push(['✅', `You're on pace to finish the week around <b>${money(st.pace)}</b>, under your ${money(cw.budget)} budget.`]);
  if (lw) {
    const [ls, le] = [lw.start, lw.end];
    const lcs = catSpend(ls, le), ccs = catSpend(cw.start, cw.end);
    let best = null;
    for (const c of S.categories) { const d = (ccs[c.id] || 0) - (lcs[c.id] || 0); if (!best || Math.abs(d) > Math.abs(best.d)) best = { c, d }; }
    if (best && Math.abs(best.d) >= 1) tips.push([best.d > 0 ? '📈' : '📉', `${best.c.icon} ${esc(best.c.name)} is <b>${best.d > 0 ? 'up' : 'down'} ${money(Math.abs(best.d))}</b> compared with last week.`]);
  }
  if (segs[0] && segTotal) tips.push(['🏷️', `${esc(segs[0].label)} is your biggest category (${PERIODS.find((p) => p[0] === range)[1].toLowerCase()}) at <b>${Math.round(segs[0].value / segTotal * 100)}%</b> of spending.`]);
  if (dow[topDow].value > 0) tips.push(['📆', `<b>${dowNames[topDow]}</b> is your most expensive day, averaging ${money(dow[topDow].value)}.`]);
  const subMonthly = sum(S.subscriptions.filter((s) => s.active), monthlyCost);
  if (subMonthly) tips.push(['🔁', `Subscriptions cost you <b>${money(subMonthly * 12)}</b> a year. Cancelling one ${money(subMonthly / Math.max(1, S.subscriptions.filter((s) => s.active).length))}/mo service saves about ${money(subMonthly / Math.max(1, S.subscriptions.filter((s) => s.active).length) * 12)}/yr.`]);
  const biggest = [...S.expenses].filter((e) => e.date >= periodRange('month')[0]).sort((x, y) => y.amount - x.amount)[0];
  if (biggest) tips.push(['💥', `Biggest purchase this month: <b>${esc(biggest.note || catById(biggest.categoryId).name)}</b> for ${money(biggest.amount)} (${relDay(biggest.date).toLowerCase()}).`]);
  if (st.unspent > 0 && st.done.length) tips.push(['💰', `You've left <b>${money(st.unspent)}</b> of your budget unspent overall — consider moving some into a goal.`]);

  return `
  <div class="grid g-2" style="margin-bottom:16px">
    <div class="card">
      <h3>Insights</h3>
      ${tips.length ? tips.map(([i, t]) => `<div class="insight"><div class="i-ico">${i}</div><div>${t}</div></div>`).join('') : emptyState('🧠', 'Log a few expenses and insights will show up here.')}
    </div>
    <div class="card">
      <h3>Where it goes
        <select class="input" style="width:auto;padding:6px 10px" data-change="cat-range">${PERIODS.map(([k, l]) => `<option value="${k}" ${range === k ? 'selected' : ''}>${l}</option>`).join('')}</select></h3>
      ${segs.length ? `<div class="donut-layout">${donut(segs, { center: `<div><div class="muted small">Total</div><b class="num" style="font-size:18px">${compact(segTotal)}</b></div>` })}
        <div class="legend">${segs.map((s) => `<div class="li"><span class="dot" style="background:${s.color}"></span><span class="grow">${esc(s.label)}</span><b class="num">${money(s.value)}</b><span class="muted num small" style="width:36px;text-align:right">${Math.round(s.value / segTotal * 100)}%</span></div>`).join('')}</div></div>`
        : emptyState('🍩', 'No spending in this period.')}
    </div>
  </div>
  <div class="grid g-2" style="margin-bottom:16px">
    <div class="card"><h3>Weekly spending <span class="muted">last 12 weeks</span></h3>${bars(weeks12)}</div>
    <div class="card"><h3>Monthly spending <span class="muted">last 6 months</span></h3>${bars(months, { showTarget: false })}</div>
  </div>
  <div class="grid g-3">
    <div class="card"><h3>Average by weekday</h3>${bars(dow.map((d, i) => ({ ...d, highlight: i === topDow && d.value > 0 })), { showTarget: false, height: 200, width: 400 })}</div>
    <div class="card"><h3>Daily heatmap <span class="muted">last 5 weeks</span></h3>
      <div class="heat">${dowNames.map((d) => `<div class="dow">${d.slice(0, 2)}</div>`).join('')}
      ${[...Array(35)].map((_, i) => {
        const d = addDays(hmStart, i);
        const v = daily[d] || 0;
        const future = d > today();
        return `<div class="cell" title="${fmtDate(d)}: ${money(v)}" style="${future ? 'opacity:.3' : v ? `background:color-mix(in srgb, var(--accent) ${Math.round(20 + 80 * v / hmMax)}%, transparent)` : ''}${d === today() ? ';outline:2px solid var(--text)' : ''}"></div>`;
      }).join('')}</div>
      <div class="small muted" style="margin-top:10px">Darker = more spent that day.</div></div>
    <div class="card"><h3>Top places & items</h3>
      ${topNotes.length ? `<div class="list">${topNotes.map((n) => `<div class="row"><div class="grow"><div class="title">${esc(n.name)}</div><div class="sub">${n.n} time${n.n > 1 ? 's' : ''}</div></div><div class="amt num">${money(n.total)}</div></div>`).join('')}</div>`
        : emptyState('📍', 'Add notes like “Starbucks” to your expenses to see where you spend most.')}
    </div>
  </div>`;
}

function renderMore() {
  const items = [['categories', 'Categories', 'Organise spending and set per-category limits'], ['insights', 'Insights', 'Charts, trends and spending patterns'], ['settings', 'Settings', 'Weekly budget, currency, backup & restore']];
  return `<div class="card"><div class="list">${items.map(([k, l, d]) => `<a class="row clickable" href="#${k}" style="text-decoration:none;color:inherit">
    <div class="avatar" style="background:var(--accent-soft);color:var(--accent)">${VIEWS[k].ico}</div>
    <div class="grow"><div class="title">${l}</div><div class="sub">${d}</div></div><span class="muted">›</span></a>`).join('')}</div></div>`;
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'ILS', 'JPY', 'INR', 'CHF', 'MXN', 'BRL', 'ZAR', 'NZD', 'SGD'];
function renderSettings() {
  const s = S.settings;
  const days = [...Array(7)].map((_, i) => new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'long' }));
  const hist = [...S.budgetHistory].sort((a, b) => b.from.localeCompare(a.from));
  return `
  <div class="grid g-2">
    <div class="card">
      <h3>Budget</h3>
      <form data-form="settings">
        <div class="field"><label>Weekly budget</label><input class="input num" name="weeklyBudget" type="number" step="0.01" min="0" inputmode="decimal" value="${s.weeklyBudget || ''}" required /></div>
        <div class="row-2">
          <div class="field"><label>Week starts on</label><select class="input" name="weekStart">${days.map((d, i) => `<option value="${i}" ${Number(s.weekStart) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
          <div class="field"><label>Currency</label><select class="input" name="currency">${CURRENCIES.map((c) => `<option ${s.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        </div>
        <label class="toggle"><span><b>Roll over leftovers</b><br><span class="small muted">Unspent money (or overspending) carries into next week.</span></span><input type="checkbox" name="rollover" ${s.rollover ? 'checked' : ''}/></label>
        <div class="field" style="margin-top:8px"><label>Theme</label>
          <select class="input" name="theme">${[['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<option value="${k}" ${s.theme === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="form-actions"><button class="btn primary" type="submit">Save settings</button></div>
      </form>
      ${hist.length > 1 ? `<h3 style="margin-top:18px">Budget history</h3><div class="list">${hist.map((h) => `<div class="row"><div class="grow">From week of ${fmtDate(h.from, { month: 'short', day: 'numeric', year: 'numeric' })}</div><b class="num">${money(h.amount)}/wk</b></div>`).join('')}</div>
        <p class="small muted">Past weeks are always measured against the budget you had at the time.</p>` : ''}
    </div>
    <div class="card">
      <h3>Your data</h3>
      <p class="muted small" style="margin-top:0">Everything is stored privately on this device. Export a backup regularly, especially before clearing your browser data or switching phones.</p>
      <div class="grid" style="gap:10px">
        <button class="btn block" data-action="export-json">⇩ Export backup (.json)</button>
        <button class="btn block" data-action="import-json">⇧ Restore from backup</button>
        <button class="btn block" data-action="export-csv-all">⇩ Export all transactions (.csv)</button>
        <button class="btn block" data-action="load-demo">✨ Load sample data to explore</button>
        <button class="btn block danger" data-action="reset">Erase everything</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden />
      <div class="kv" style="margin-top:16px"><span>Transactions</span><span class="num">${S.expenses.length}</span></div>
      <div class="kv"><span>Subscriptions</span><span class="num">${S.subscriptions.length}</span></div>
      <div class="kv"><span>Goals</span><span class="num">${S.goals.length}</span></div>
      <div class="kv"><span>Tracking since</span><span>${fmtDate(firstDate(), { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>
    </div>
  </div>`;
}

// ======================= Modals & forms =======================
function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  const first = $('#modal-body [autofocus]') || $('#modal-body input:not([type=hidden])');
  if (first && window.matchMedia('(pointer:fine)').matches) setTimeout(() => first.focus(), 50);
}
function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; }

function catPicker(selected) {
  return `<input type="hidden" name="categoryId" value="${selected}" /><div class="cat-picker">${S.categories.map((c) =>
    `<button type="button" class="cat-opt ${c.id === selected ? 'sel' : ''}" data-action="pick-cat" data-id="${c.id}"><span class="e">${c.icon}</span>${esc(c.name)}</button>`).join('')}</div>`;
}
function emojiPicker(name, value) {
  return `<input class="input" name="${name}" value="${esc(value)}" maxlength="4" style="width:80px;text-align:center;font-size:20px" />
    <div class="chips-scroll" style="margin-top:8px">${EMOJIS.map((e) => `<button type="button" class="chip" data-action="pick-emoji" data-name="${name}" data-v="${e}" style="font-size:18px">${e}</button>`).join('')}</div>`;
}

function expenseForm(e) {
  const isEdit = !!e;
  e = e || { amount: '', categoryId: (S.categories[0] || {}).id, note: '', date: today() };
  const refund = e.amount < 0;
  openModal(isEdit ? 'Edit transaction' : 'Add expense', `
    <form data-form="expense" data-id="${e.id || ''}">
      <div style="display:flex;justify-content:center;margin-bottom:12px"><div class="seg">
        <button type="button" class="${refund ? '' : 'sel'}" data-action="seg" data-name="kind" data-v="expense">Expense</button>
        <button type="button" class="${refund ? 'sel' : ''}" data-action="seg" data-name="kind" data-v="refund">Refund / money back</button></div></div>
      <input type="hidden" name="kind" value="${refund ? 'refund' : 'expense'}" />
      <div class="field"><input class="input amount-input num" name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" placeholder="0.00" value="${e.amount ? Math.abs(e.amount) : ''}" required autofocus /></div>
      <div class="field"><label>Category</label>${catPicker(e.categoryId)}</div>
      <div class="row-2">
        <div class="field"><label>Note</label><input class="input" name="note" placeholder="e.g. Starbucks" value="${esc(e.note)}" list="note-suggest" /></div>
        <div class="field"><label>Date</label><input class="input" name="date" type="date" value="${e.date}" required /></div>
      </div>
      <datalist id="note-suggest">${[...new Set(S.expenses.map((x) => x.note).filter(Boolean))].slice(-40).map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="form-actions">
        ${isEdit ? `<button type="button" class="btn danger" data-action="delete-expense" data-id="${e.id}">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn" data-action="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${isEdit ? 'Save' : 'Add expense'}</button>
      </div>
    </form>`);
}

function categoryForm(c) {
  const isEdit = !!c;
  c = c || { name: '', icon: '📦', color: PALETTE[S.categories.length % PALETTE.length], limit: 0 };
  openModal(isEdit ? 'Edit category' : 'New category', `
    <form data-form="category" data-id="${c.id || ''}">
      <div class="field"><label>Name</label><input class="input" name="name" value="${esc(c.name)}" required autofocus /></div>
      <div class="field"><label>Icon</label>${emojiPicker('icon', c.icon)}</div>
      <div class="field"><label>Colour</label><input type="hidden" name="color" value="${c.color}" />
        <div class="swatches">${PALETTE.map((p) => `<button type="button" class="swatch ${p === c.color ? 'sel' : ''}" style="background:${p}" data-action="pick-color" data-v="${p}" aria-label="${p}"></button>`).join('')}</div></div>
      <div class="field"><label>Weekly limit (optional)</label><input class="input num" name="limit" type="number" step="0.01" min="0" inputmode="decimal" placeholder="No limit" value="${c.limit || ''}" />
        <span class="small muted">You'll see a warning bar on the dashboard as you get close.</span></div>
      <div class="form-actions">
        ${isEdit && S.categories.length > 1 ? `<button type="button" class="btn danger" data-action="delete-category" data-id="${c.id}">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn" data-action="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${isEdit ? 'Save' : 'Create'}</button>
      </div>
    </form>`);
}

function subForm(s) {
  const isEdit = !!s;
  s = s || { name: '', amount: '', cycle: 'monthly', nextDate: today(), categoryId: subsCat().id, active: true, autoLog: true, icon: '' };
  openModal(isEdit ? 'Edit subscription' : 'New subscription', `
    <form data-form="sub" data-id="${s.id || ''}">
      <div class="field"><label>Name</label><input class="input" name="name" placeholder="Netflix, Gym, Phone…" value="${esc(s.name)}" required autofocus /></div>
      <div class="row-2">
        <div class="field"><label>Amount</label><input class="input num" name="amount" type="number" step="0.01" min="0" inputmode="decimal" value="${s.amount}" required /></div>
        <div class="field"><label>Billed</label><select class="input" name="cycle">${CYCLES.map(([k, l]) => `<option value="${k}" ${s.cycle === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="row-2">
        <div class="field"><label>Next payment</label><input class="input" name="nextDate" type="date" value="${s.nextDate || ''}" required /></div>
        <div class="field"><label>Category</label><select class="input" name="categoryId">${S.categories.map((c) => `<option value="${c.id}" ${c.id === s.categoryId ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Icon (optional)</label>${emojiPicker('icon', s.icon || '')}</div>
      <label class="toggle"><span><b>Auto-log payments</b><br><span class="small muted">Adds the charge to your spending on each due date.</span></span><input type="checkbox" name="autoLog" ${s.autoLog ? 'checked' : ''}/></label>
      <label class="toggle"><span><b>Active</b><br><span class="small muted">Turn off to pause or mark as cancelled.</span></span><input type="checkbox" name="active" ${s.active ? 'checked' : ''}/></label>
      <div class="form-actions">
        ${isEdit ? `<button type="button" class="btn danger" data-action="delete-sub" data-id="${s.id}">Delete</button>
          <button type="button" class="btn" data-action="log-sub" data-id="${s.id}">Log payment now</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn" data-action="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${isEdit ? 'Save' : 'Add'}</button>
      </div>
    </form>`);
}

function goalForm(g) {
  const isEdit = !!g;
  g = g || { name: '', price: '', saved: 0, targetDate: '', icon: '🎯' };
  openModal(isEdit ? 'Edit goal' : 'New goal', `
    <form data-form="goal" data-id="${g.id || ''}">
      <div class="field"><label>What do you want?</label><input class="input" name="name" placeholder="New laptop, Vacation, Emergency fund…" value="${esc(g.name)}" required autofocus /></div>
      <div class="row-2">
        <div class="field"><label>Cost</label><input class="input num" name="price" type="number" step="0.01" min="0.01" inputmode="decimal" value="${g.price}" required /></div>
        <div class="field"><label>Want it by (optional)</label><input class="input" name="targetDate" type="date" value="${g.targetDate || ''}" /></div>
      </div>
      ${isEdit ? '' : `<div class="field"><label>Already saved (optional)</label><input class="input num" name="saved" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00" /></div>`}
      <div class="field"><label>Icon</label>${emojiPicker('icon', g.icon || '🎯')}</div>
      <div class="form-actions">
        ${isEdit ? `<button type="button" class="btn danger" data-action="delete-goal" data-id="${g.id}">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn" data-action="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${isEdit ? 'Save' : 'Create goal'}</button>
      </div>
    </form>`);
}

function contributeForm(g, withdraw) {
  const st = stats();
  const suggest = withdraw ? '' : (st.cw.left > 0 ? round2(st.cw.left) : '');
  const m = goalMath(g);
  openModal(withdraw ? `Withdraw from ${g.name}` : `Save toward ${g.name}`, `
    <form data-form="contribute" data-id="${g.id}" data-withdraw="${withdraw ? 1 : ''}">
      <div class="field"><input class="input amount-input num" name="amount" type="number" step="0.01" min="0.01" ${withdraw ? `max="${g.saved}"` : ''} inputmode="decimal" placeholder="0.00" value="${suggest}" required autofocus /></div>
      ${withdraw ? `<p class="muted small">You have ${money(g.saved)} saved toward this goal.</p>` : `
      <div class="chips-scroll" style="margin-bottom:12px">
        ${m.perWeek ? `<button type="button" class="chip" data-action="fill-amount" data-v="${round2(m.perWeek)}">Weekly target ${money(m.perWeek)}</button>` : ''}
        ${st.cw.left > 0 ? `<button type="button" class="chip" data-action="fill-amount" data-v="${round2(st.cw.left)}">All of this week's leftover ${money(st.cw.left)}</button>` : ''}
        <button type="button" class="chip" data-action="fill-amount" data-v="${round2(m.remaining)}">Finish it ${money(m.remaining)}</button>
      </div>
      <label class="toggle"><span><b>Take it from this week's budget</b><br><span class="small muted">Reduces what you have left to spend this week.</span></span><input type="checkbox" name="fromBudget" checked /></label>`}
      <div class="form-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${withdraw ? 'Withdraw' : 'Add savings'}</button></div>
    </form>`);
}

function onboarding() {
  openModal('Welcome to Pocketwise 👋', `
    <form data-form="onboard">
      <p class="muted" style="margin-top:0">Give yourself a weekly spending amount. Everything you log is measured against it, and the week resets automatically.</p>
      <div class="field"><label>How much can you spend each week?</label><input class="input amount-input num" name="weeklyBudget" type="number" step="0.01" min="1" inputmode="decimal" placeholder="300" required autofocus /></div>
      <div class="row-2">
        <div class="field"><label>Week starts on</label><select class="input" name="weekStart">${[...Array(7)].map((_, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'long' })}</option>`).join('')}</select></div>
        <div class="field"><label>Currency</label><select class="input" name="currency">${CURRENCIES.map((c) => `<option ${c === 'USD' ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      </div>
      <div class="form-actions"><button type="button" class="btn" data-action="load-demo">Explore with sample data</button><button class="btn primary" type="submit">Start budgeting</button></div>
    </form>`);
}

function setWeeklyBudget(amount) {
  const ws = weekStartOf(today());
  S.settings.weeklyBudget = amount;
  S.budgetHistory = S.budgetHistory.filter((h) => h.from !== ws);
  const prev = budgetFor(ws);
  if (!S.budgetHistory.length || prev !== amount) S.budgetHistory.push({ from: S.budgetHistory.length ? ws : weekStartOf(firstDate()), amount });
}

// ======================= Event handling =======================
function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return o;
}

function onSubmit(ev) {
  const form = ev.target.closest('form[data-form]');
  if (!form) return;
  ev.preventDefault();
  const d = formData(form);
  const id = form.dataset.id;
  switch (form.dataset.form) {
    case 'onboard': {
      S.settings.weekStart = Number(d.weekStart);
      S.settings.currency = d.currency;
      S.settings.startDate = today();
      S.settings.onboarded = true;
      S.budgetHistory = [];
      setWeeklyBudget(round2(Number(d.weeklyBudget)));
      toast('You\'re all set! Tap + to log your first expense.');
      break;
    }
    case 'expense': {
      const amt = round2(Number(d.amount)) * (d.kind === 'refund' ? -1 : 1);
      if (id) Object.assign(S.expenses.find((e) => e.id === id), { amount: amt, categoryId: d.categoryId, note: d.note.trim(), date: d.date });
      else S.expenses.push({ id: uid(), amount: amt, categoryId: d.categoryId, note: d.note.trim(), date: d.date, createdAt: Date.now() });
      if (!id) {
        const cw = stats().cw;
        const c = catById(d.categoryId);
        const cs = catSpend(cw.start, cw.end)[c.id] || 0;
        if (c.limit && cs > c.limit && inRange(d.date, cw.start, cw.end)) toast(`Heads up: ${c.name} is over its weekly limit`);
        else toast(cw.left >= 0 ? `Saved · ${money(cw.left)} left this week` : `Saved · ${money(-cw.left)} over this week`);
      } else toast('Transaction updated');
      break;
    }
    case 'category': {
      const v = { name: d.name.trim(), icon: d.icon || '📦', color: d.color, limit: round2(Number(d.limit) || 0) };
      if (id) Object.assign(S.categories.find((c) => c.id === id), v);
      else S.categories.push({ id: uid(), ...v });
      break;
    }
    case 'sub': {
      const v = { name: d.name.trim(), amount: round2(Number(d.amount)), cycle: d.cycle, nextDate: d.nextDate, categoryId: d.categoryId, autoLog: d.autoLog, active: d.active, icon: d.icon, anchorDay: parse(d.nextDate).getDate() };
      if (id) Object.assign(S.subscriptions.find((s) => s.id === id), v);
      else S.subscriptions.push({ id: uid(), ...v });
      processSubscriptions();
      break;
    }
    case 'goal': {
      const v = { name: d.name.trim(), price: round2(Number(d.price)), targetDate: d.targetDate || '', icon: d.icon || '🎯' };
      if (id) Object.assign(S.goals.find((g) => g.id === id), v);
      else {
        const saved = round2(Number(d.saved) || 0);
        S.goals.push({ id: uid(), ...v, saved, contributions: saved ? [{ date: today(), amount: saved, fromBudget: false }] : [] });
      }
      break;
    }
    case 'contribute': {
      const g = S.goals.find((x) => x.id === id);
      let amt = round2(Number(d.amount));
      if (form.dataset.withdraw) amt = -Math.min(amt, g.saved);
      g.saved = round2(g.saved + amt);
      g.contributions = g.contributions || [];
      g.contributions.push({ date: today(), amount: amt, fromBudget: !!d.fromBudget });
      toast(g.saved >= g.price ? `🎉 ${g.name} is fully funded!` : amt > 0 ? `${money(amt)} saved toward ${g.name}` : `Withdrew ${money(-amt)}`);
      break;
    }
    case 'settings': {
      const amt = round2(Number(d.weeklyBudget));
      if (amt !== budgetFor(weekStartOf(today())) || !S.budgetHistory.length) setWeeklyBudget(amt);
      S.settings.weeklyBudget = amt;
      S.settings.weekStart = Number(d.weekStart);
      S.settings.currency = d.currency;
      S.settings.rollover = d.rollover;
      S.settings.theme = d.theme;
      applyTheme();
      toast('Settings saved');
      break;
    }
  }
  save();
  closeModal();
  render();
}

function onClick(ev) {
  const el = ev.target.closest('[data-action]');
  if (!el) {
    if (ev.target.id === 'modal') closeModal();
    return;
  }
  const { action, id } = el.dataset;
  switch (action) {
    case 'add-expense': return expenseForm();
    case 'edit-expense': return expenseForm(S.expenses.find((e) => e.id === id));
    case 'delete-expense': {
      const i = S.expenses.findIndex((e) => e.id === id);
      UI.lastDeleted = { type: 'expense', item: S.expenses[i] };
      S.expenses.splice(i, 1);
      save(); closeModal(); render();
      return toast('Transaction deleted', 'Undo');
    }
    case 'undo': {
      const u = UI.lastDeleted;
      if (u?.type === 'expense') S.expenses.push(u.item);
      UI.lastDeleted = null;
      save(); render(); hideToast();
      return;
    }
    case 'close-modal': return closeModal();
    case 'toggle-theme': {
      const cur = document.documentElement.dataset.theme;
      S.settings.theme = cur === 'dark' ? 'light' : 'dark';
      save(); applyTheme(); render();
      return;
    }
    case 'pick-cat': {
      const form = el.closest('form');
      form.elements.categoryId.value = id;
      form.querySelectorAll('.cat-opt').forEach((b) => b.classList.toggle('sel', b === el));
      return;
    }
    case 'pick-emoji': { el.closest('form').elements[el.dataset.name].value = el.dataset.v; return; }
    case 'pick-color': {
      const form = el.closest('form');
      form.elements.color.value = el.dataset.v;
      form.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('sel', b === el));
      return;
    }
    case 'seg': {
      const form = el.closest('form');
      form.elements[el.dataset.name].value = el.dataset.v;
      el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b === el));
      return;
    }
    case 'fill-amount': { el.closest('form').elements.amount.value = el.dataset.v; return; }
    case 'act-cat': { UI.actFilter.cat = id; return render(); }
    case 'add-category': return categoryForm();
    case 'edit-category': return categoryForm(S.categories.find((c) => c.id === id));
    case 'delete-category': {
      const c = S.categories.find((x) => x.id === id);
      const n = S.expenses.filter((e) => e.categoryId === id).length;
      const fallback = S.categories.find((x) => x.id !== id && x.name === 'Other') || S.categories.find((x) => x.id !== id);
      if (!confirm(`Delete “${c.name}”?${n ? ` Its ${n} transaction(s) will move to “${fallback.name}”.` : ''}`)) return;
      S.expenses.forEach((e) => { if (e.categoryId === id) e.categoryId = fallback.id; });
      S.subscriptions.forEach((s) => { if (s.categoryId === id) s.categoryId = fallback.id; });
      S.categories = S.categories.filter((x) => x.id !== id);
      save(); closeModal(); render();
      return toast('Category deleted');
    }
    case 'add-sub': return subForm();
    case 'edit-sub': return subForm(S.subscriptions.find((s) => s.id === id));
    case 'delete-sub': {
      if (!confirm('Delete this subscription? Past payments stay in your history.')) return;
      S.subscriptions = S.subscriptions.filter((s) => s.id !== id);
      save(); closeModal(); render();
      return;
    }
    case 'log-sub': {
      const s = S.subscriptions.find((x) => x.id === id);
      logSubCharge(s, today());
      if (s.nextDate && s.nextDate <= addDays(today(), 7)) advanceSub(s);
      save(); closeModal(); render();
      return toast(`Logged ${money(s.amount)} for ${s.name}`);
    }
    case 'add-goal': return goalForm();
    case 'edit-goal': return goalForm(S.goals.find((g) => g.id === id));
    case 'delete-goal': {
      if (!confirm('Delete this goal?')) return;
      S.goals = S.goals.filter((g) => g.id !== id);
      save(); closeModal(); render();
      return;
    }
    case 'contribute-goal': return contributeForm(S.goals.find((g) => g.id === id), false);
    case 'withdraw-goal': return contributeForm(S.goals.find((g) => g.id === id), true);
    case 'export-json': return download(`pocketwise-backup-${today()}.json`, JSON.stringify(S, null, 2), 'application/json');
    case 'import-json': return $('#import-file').click();
    case 'export-csv': return exportCSV(filteredExpenses());
    case 'export-csv-all': return exportCSV([...S.expenses].sort((a, b) => b.date.localeCompare(a.date)));
    case 'load-demo': {
      if (S.expenses.length && !confirm('Replace your current data with sample data?')) return;
      S = demoData(); save(); applyTheme(); closeModal(); render();
      return toast('Sample data loaded — erase it anytime in Settings');
    }
    case 'reset': {
      if (!confirm('Erase ALL data? This cannot be undone. Export a backup first if unsure.')) return;
      S = freshState(); save(); render(); onboarding();
      return;
    }
  }
}

function onInput(ev) {
  if (ev.target.dataset.input === 'act-q') {
    UI.actFilter.q = ev.target.value;
    const list = filteredExpenses();
    const byDay = {};
    for (const e of list) (byDay[e.date] = byDay[e.date] || []).push(e);
    $('#act-list').innerHTML = activityList(byDay);
    $('#view-sub').textContent = `${list.length} transaction${list.length === 1 ? '' : 's'} · ${money(sum(list, (e) => e.amount))} total`;
  }
}
function onChange(ev) {
  const k = ev.target.dataset.change;
  if (k === 'act-period') { UI.actFilter.period = ev.target.value; render(); }
  if (k === 'cat-range') { UI.catRange = ev.target.value; render(); }
  if (ev.target.id === 'import-file' && ev.target.files[0]) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data || !Array.isArray(data.expenses) || !data.settings) throw new Error('bad file');
        const base = freshState();
        S = { ...base, ...data, settings: { ...base.settings, ...data.settings } };
        save(); applyTheme(); render(); toast('Backup restored');
      } catch { toast('That file is not a valid Pocketwise backup'); }
    };
    r.readAsText(ev.target.files[0]);
    ev.target.value = '';
  }
}

// ======================= Utilities =======================
let toastTimer;
function toast(msg, actionLabel) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button data-action="undo">${esc(actionLabel)}</button>` : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 5000 : 2600);
}
function hideToast() { $('#toast').hidden = true; }

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportCSV(list) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Amount', 'Category', 'Note', 'Subscription'].join(',')]
    .concat(list.map((e) => [e.date, e.amount.toFixed(2), q(catById(e.categoryId).name), q(e.note), e.subId ? 'yes' : ''].join(',')));
  download(`pocketwise-transactions-${today()}.csv`, rows.join('\n'), 'text/csv');
}

function applyTheme() {
  const t = S.settings.theme;
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const tb = document.querySelector('[data-action=toggle-theme]'); if (tb) tb.innerHTML = dark ? ICONS.sun : ICONS.moon;
  document.querySelector('meta[name=theme-color]').setAttribute('content', dark ? '#0b0d12' : '#f4f5f9');
}

// ======================= Sample data =======================
function demoData() {
  const s = freshState();
  const t = today();
  s.settings = { ...s.settings, weeklyBudget: 350, onboarded: true, startDate: addDays(t, -7 * 14) };
  const c = Object.fromEntries(s.categories.map((x) => [x.name, x.id]));
  s.categories.find((x) => x.name === 'Food & Dining').limit = 90;
  s.categories.find((x) => x.name === 'Shopping').limit = 60;
  s.categories.find((x) => x.name === 'Entertainment').limit = 40;
  s.budgetHistory = [{ from: weekStartOf(s.settings.startDate), amount: 300 }, { from: weekStartOf(addDays(t, -7 * 6)), amount: 350 }];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const items = [
    ['Food & Dining', ['Chipotle', 'Starbucks', 'Pizza night', 'Sushi', 'Starbucks', 'Lunch with team'], 6, 28],
    ['Groceries', ['Trader Joe’s', 'Whole Foods', 'Costco'], 25, 90],
    ['Transport', ['Uber', 'Gas', 'Parking', 'Metro card'], 6, 45],
    ['Shopping', ['Amazon', 'Target', 'Nike'], 12, 70],
    ['Entertainment', ['Movies', 'Concert', 'Bowling'], 12, 45],
    ['Health', ['Pharmacy', 'Vitamins'], 8, 30],
    ['Gifts', ['Birthday gift'], 20, 50],
  ];
  for (let day = -7 * 14; day <= 0; day++) {
    const date = addDays(t, day);
    const n = Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const [cat, notes, lo, hi] = items[Math.floor(rnd() * rnd() * items.length)];
      s.expenses.push({ id: uid(), amount: round2(lo + rnd() * (hi - lo)), categoryId: c[cat], note: pick(notes), date, createdAt: Date.now() + day * 1000 + i });
    }
  }
  s.expenses.push({ id: uid(), amount: -24.99, categoryId: c.Shopping, note: 'Amazon return', date: addDays(t, -3), createdAt: Date.now() });
  const subs = [['Netflix', 15.49, 'monthly', '🎬'], ['Spotify', 11.99, 'monthly', '🎵'], ['Gym', 40, 'monthly', '🏋️'], ['iCloud', 2.99, 'monthly', '☁️'], ['Amazon Prime', 139, 'yearly', '📦']];
  subs.forEach(([name, amount, cycle, icon], i) => {
    const start = addDays(t, -95 + i * 9);
    const sub = { id: uid(), name, amount, cycle, nextDate: start, anchorDay: parse(start).getDate(), categoryId: c.Subscriptions, active: true, autoLog: true, icon };
    s.subscriptions.push(sub);
  });
  s.goals = [
    { id: uid(), name: 'New iPhone', price: 1099, saved: 420, targetDate: addDays(t, 7 * 12), icon: '📱', contributions: [{ date: addDays(t, -40), amount: 300 }, { date: addDays(t, -14), amount: 70 }, { date: addDays(t, -6), amount: 50 }] },
    { id: uid(), name: 'Summer trip', price: 2400, saved: 650, targetDate: addDays(t, 7 * 30), icon: '🏖️', contributions: [{ date: addDays(t, -30), amount: 500 }, { date: addDays(t, -10), amount: 150 }] },
    { id: uid(), name: 'Emergency fund', price: 3000, saved: 1200, targetDate: '', icon: '🛟', contributions: [{ date: addDays(t, -20), amount: 1200 }] },
  ];
  // Let the subscription engine back-fill the demo charges.
  const prev = S; S = s;
  for (const sub of S.subscriptions) { let g = 0; while (sub.nextDate <= t && g++ < 50) { logSubCharge(sub, sub.nextDate); advanceSub(sub); } }
  S = prev;
  return s;
}

// ======================= Boot =======================
document.addEventListener('click', onClick);
document.addEventListener('submit', onSubmit);
document.addEventListener('input', onInput);
document.addEventListener('change', onChange);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  if (e.key === 'n' && $('#modal').hidden && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); expenseForm(); }
});
window.addEventListener('hashchange', route);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (S.settings.theme === 'system') applyTheme(); });
// Re-render when the app comes back into view (e.g. a new week started while it was in the background).
document.addEventListener('visibilitychange', () => { if (!document.hidden) { processSubscriptions(); if ($('#modal').hidden) render(); } });

applyTheme();
processSubscriptions();
route();
if (!S.settings.onboarded) onboarding();
if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
