/* Pocketwise Budget — a weekly budget tracker.
 *
 * Storage: when opened as a Claude artifact, data syncs privately to the viewer's own
 * Claude account (db capability, under data/users/<id>/ which nobody else can read).
 * Opened anywhere else (a local file, GitHub Pages), it uses this browser's localStorage only.
 * The source code never contains anyone's data. */
'use strict';

// ======================= Constants =======================
const STORE_KEY = 'pocketwise.v1';
const DEVICE_KEY = 'pocketwise.device';
const PALETTE = ['#6d4dff', '#18b98d', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6', '#8b5cf6', '#f97316', '#64748b', '#84cc16', '#06b6d4'];
const EMOJIS = ['🍔', '🛒', '🚗', '🛍️', '🎬', '💡', '💊', '🔁', '🎁', '📦', '☕', '🍺', '✈️', '🏠', '📱', '💻', '🎮', '👕', '💇', '🐶', '📚', '🏋️', '⛽', '🚌', '🎵', '🍕', '🧾', '💳', '🎓', '👶', '🌱', '🎟️', '🚲', '⌚', '👟', '🎧', '🛋️', '🏖️', '💍', '🚙', '🛟', '🎯'];
const METHODS = ['Card', 'Cash', 'Debit', 'Credit', 'Apple Pay', 'Google Pay', 'Venmo', 'Other'];
const INCOME_TYPES = [['job', '💼 Job / paycheck'], ['side', '🛠️ Side hustle'], ['gift', '🎁 Gift'], ['allowance', '👛 Allowance'], ['sold', '🏷️ Sold something'], ['cashback', '💸 Cashback / refund'], ['other', '💰 Other']];
const CYCLES = [['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']];
const COOL_OPTS = [[24, '24 hours'], [48, '48 hours'], [168, '1 week'], [720, '30 days']];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'ILS', 'JPY', 'INR', 'CHF', 'MXN', 'BRL', 'ZAR', 'NZD', 'SGD'];

const DEFAULT_CATEGORIES = [
  ['Food & Dining', '🍔'], ['Groceries', '🛒'], ['Transport', '🚗'], ['Shopping', '🛍️'],
  ['Entertainment', '🎬'], ['Bills & Utilities', '💡'], ['Health', '💊'], ['Subscriptions', '🔁'],
  ['Gifts', '🎁'], ['Other', '📦'],
].map(([name, icon], i) => ({ id: 'c' + (i + 1), name, icon, color: PALETTE[i % PALETTE.length], limit: 0 }));

function freshState() {
  return {
    version: 2,
    settings: {
      weeklyBudget: 0, currency: 'USD', weekStart: 1, rollover: false, theme: 'system', startDate: null, onboarded: false,
      reminderDays: 3, logReminder: true, coolingHours: 48,
    },
    budgetHistory: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    expenses: [], subscriptions: [], goals: [],
    income: [], recurringIncome: [],
    people: [], ious: [],
    templates: [], cooling: [], noSpendMarks: [],
  };
}
function normalize(data) {
  const base = freshState();
  const s = { ...base, ...data, settings: { ...base.settings, ...(data.settings || {}) } };
  for (const k of Object.keys(base)) if (Array.isArray(base[k]) && !Array.isArray(s[k])) s[k] = [];
  // Drop duplicate ids (can happen if two devices logged the same automatic charge).
  for (const k of ['expenses', 'income']) {
    const seen = new Set();
    s[k] = s[k].filter((x) => x && x.id && !seen.has(x.id) && seen.add(x.id));
  }
  s.version = 2;
  return s;
}

// ======================= Local storage =======================
function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, v) { try { localStorage.setItem(key, v); return true; } catch { return false; } }
function loadLocal() {
  const raw = lsGet(STORE_KEY);
  if (raw) { try { return normalize(JSON.parse(raw)); } catch (e) { console.warn('Bad saved data', e); } }
  return freshState();
}
let DEV = (() => { try { return JSON.parse(lsGet(DEVICE_KEY) || '{}'); } catch { return {}; } })();
function saveDev() { lsSet(DEVICE_KEY, JSON.stringify(DEV)); }

let S = loadLocal();
const UI = {
  view: 'dashboard', actFilter: { q: '', cat: 'all', period: 'month', tag: '' }, catRange: 'week',
  undo: null, calMonth: null, goalsTab: 'goals', reportKey: null, ask: null, pendingCool: null,
};

function save() {
  lsSet(STORE_KEY, JSON.stringify(S));
  Sync.schedule();
}
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ======================= Helpers =======================
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => toISO(new Date());
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return toISO(d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const sum = (arr, f = (x) => x) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const monthEnd = (ym) => toISO(new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0));

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
const monthName = (ym, o = { month: 'long', year: 'numeric' }) => parse(ym + '-01').toLocaleDateString(undefined, o);
function relDay(s) {
  const d = daysBetween(today(), s);
  if (d === 0) return 'Today';
  if (d === -1) return 'Yesterday';
  if (d === 1) return 'Tomorrow';
  if (d > 1 && d < 7) return `In ${d} days`;
  return fmtDate(s, { weekday: 'short', month: 'short', day: 'numeric' });
}
const parseTags = (s) => [...new Set(String(s || '').split(/[\s,]+/).map((t) => t.replace(/^#/, '').toLowerCase()).filter(Boolean))].slice(0, 8);

const catById = (id) => S.categories.find((c) => c.id === id) || { id, name: 'Uncategorized', icon: '❔', color: '#94a3b8' };
const otherCat = () => S.categories.find((c) => c.name === 'Other') || S.categories[S.categories.length - 1];
const subsCat = () => S.categories.find((c) => c.name === 'Subscriptions') || otherCat();
const personById = (id) => S.people.find((p) => p.id === id) || { id, name: 'Someone', color: '#94a3b8' };
const parts = (e) => (e.parts && e.parts.length ? e.parts : [{ categoryId: e.categoryId, amount: e.amount }]);
const amountFor = (e, cat) => (cat === 'all' ? e.amount : sum(parts(e).filter((p) => p.categoryId === cat), (p) => p.amount));

// ======================= Capabilities (artifact runtime) =======================
const Cap = { inArtifact: !!(window.claude && typeof window.claude.use === 'function'), db: null, user: null, sample: null, downloads: null, images: false };
async function initCaps() {
  if (!Cap.inArtifact) { Sync.setStatus('local'); Sync.resolveReady(); return; }
  const use = (n) => Promise.resolve(window.claude.use(n)).catch(() => null);
  const [db, user, sample, downloads] = await Promise.all([use('db'), use('user'), use('sample'), use('downloads')]);
  Object.assign(Cap, { db, user, sample, downloads });
  if (sample) { const lim = await sample.limits().catch(() => null); Cap.images = !!lim?.images; }
  let id = null;
  if (db && user) id = await user.id().catch(() => null);
  if (db && id) Sync.start(db, id);
  else { Sync.setStatus('local'); Sync.resolveReady(); afterSyncReady(); }
  render();
}

// ======================= Cloud sync =======================
// Layout under the viewer's private subtree data/users/<id>/:
//   meta        — settings, categories, subscriptions, goals, people, IOUs, …
//   tx-YYYY-MM  — that month's expenses and income (keeps each document small)
const Sync = {
  db: null, uid: null, status: 'starting', last: {}, pending: new Map(), writing: new Set(), timer: null,
  latestSnap: null, gotFirst: false, readyResolved: false,
  resolveReady() { this.readyResolved = true; },

  setStatus(s) { this.status = s; const el = $('#sync-pill'); if (el) el.outerHTML = syncPill(); },

  docs(state) {
    const { expenses, income, ...meta } = state;
    const out = { meta: JSON.parse(JSON.stringify(meta)) };
    for (const e of expenses) { const k = 'tx-' + e.date.slice(0, 7); (out[k] = out[k] || { expenses: [], income: [] }).expenses.push(e); }
    for (const i of income) { const k = 'tx-' + i.date.slice(0, 7); (out[k] = out[k] || { expenses: [], income: [] }).income.push(i); }
    return out;
  },
  ref(key) { return this.db.doc(`data/users/${this.uid}/${key}`); },

  start(db, id) {
    this.db = db; this.uid = id;
    this.setStatus('busy');
    const timer = setTimeout(() => {
      if (!this.gotFirst) { this.setStatus('offline'); this.resolveReady(); afterSyncReady(); }
    }, 10000);
    this.unsub = db.collection(`data/users/${id}`).onSnapshot((snap) => {
      this.latestSnap = snap;
      if (snap.metadata.fromCache && !this.gotFirst) { if (!snap.empty) this.apply(snap); return; }
      clearTimeout(timer);
      if (!this.gotFirst) {
        const wasReady = this.readyResolved;
        this.gotFirst = true;
        if (snap.empty) {
          // Nothing in the cloud yet: upload whatever this device has (if anything).
          this.last = {};
          if (S.settings.onboarded) this.schedule(0);
        } else this.apply(snap);
        this.setStatus('ok');
        this.resolveReady();
        if (!wasReady) afterSyncReady(); else { processRecurring(); render(); }
        return;
      }
      if (!this.pending.size && !this.writing.size) this.apply(snap);
      if (this.status === 'offline') this.setStatus('ok');
    }, (err) => {
      clearTimeout(timer);
      console.warn('Sync stopped', err);
      this.setStatus('offline');
      if (!this.readyResolved) { this.resolveReady(); afterSyncReady(); }
    });
  },

  apply(snap) {
    const byId = {};
    for (const d of snap.docs) if (d.exists) byId[d.id] = d.data();
    if (!byId.meta) return;
    const next = { ...JSON.parse(JSON.stringify(byId.meta)), expenses: [], income: [] };
    for (const [k, v] of Object.entries(byId)) {
      if (!k.startsWith('tx-')) continue;
      next.expenses.push(...(v.expenses || []).map((x) => JSON.parse(JSON.stringify(x))));
      next.income.push(...(v.income || []).map((x) => JSON.parse(JSON.stringify(x))));
    }
    const before = JSON.stringify(S);
    S = normalize(next);
    this.last = Object.fromEntries(Object.entries(this.docs(S)).map(([k, v]) => [k, JSON.stringify(v)]));
    for (const k of Object.keys(byId)) if (!(k in this.last)) this.last[k] = '__stale__';
    lsSet(STORE_KEY, JSON.stringify(S));
    if (JSON.stringify(S) !== before && $('#modal').hidden) render();
  },

  schedule(delay = 600) {
    if (!this.db || !this.gotFirst) return;
    const docs = this.docs(S);
    for (const [k, v] of Object.entries(docs)) {
      const j = JSON.stringify(v);
      if (this.last[k] !== j) this.pending.set(k, { body: v, json: j });
      else this.pending.delete(k);
    }
    for (const k of Object.keys(this.last)) if (!(k in docs)) this.pending.set(k, { del: true });
    if (!this.pending.size) return;
    this.setStatus('busy');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  },

  async flush() {
    const jobs = [...this.pending.entries()].filter(([k]) => !this.writing.has(k));
    let failed = false;
    await Promise.all(jobs.map(async ([k, job]) => {
      this.pending.delete(k);
      this.writing.add(k);
      try {
        if (job.del) { await this.ref(k).delete(); delete this.last[k]; }
        else { await this.ref(k).set(job.body); this.last[k] = job.json; }
      } catch (e) {
        failed = true;
        console.warn('Sync write failed', k, e);
        if (e?.code === 'unavailable' && !this.pending.has(k)) this.pending.set(k, job);
        if (e?.code === 'quota_exceeded') toast('Cloud storage is full. Your changes are saved on this device.');
        this.setStatus('offline');
      } finally { this.writing.delete(k); }
    }));
    if (this.pending.size) { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), failed ? 4000 : 300); return; }
    if (!this.writing.size) {
      if (!failed) this.setStatus('ok');
      if (this.latestSnap && !failed) this.apply(this.latestSnap);
    }
  },
};

function syncPill() {
  const map = {
    starting: ['busy', 'Connecting…'], busy: ['busy', 'Syncing…'], ok: ['ok', 'Synced'],
    offline: ['off', 'Offline: saved on this device'], local: ['', 'This device only'],
  };
  const [cls, label] = map[Sync.status] || map.local;
  return `<span class="sync-pill ${cls}" id="sync-pill" title="${esc(label)}"><i></i><span>${label}</span></span>`;
}

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
const inRange = (date, a, b) => date >= a && date <= b;
function firstDate() {
  const dates = [S.settings.startDate, ...S.expenses.map((e) => e.date)].filter(Boolean).sort();
  return dates[0] || today();
}

/** Every week from the first tracked week to the current one, oldest first. */
function computeWeeks() {
  const cur = weekStartOf(today());
  let ws = weekStartOf(firstDate());
  if (ws > cur) ws = cur;
  const by = (list, f, filter = () => true) => { const m = {}; for (const x of list) if (filter(x)) { const k = weekStartOf(x.date); m[k] = (m[k] || 0) + f(x); } return m; };
  const spentBy = by(S.expenses, (e) => e.amount);
  const setAsideBy = by(S.goals.flatMap((g) => g.contributions || []), (c) => c.amount, (c) => c.fromBudget);
  const extraBy = by(S.income, (i) => i.amount, (i) => i.addToBudget);
  const weeks = [];
  let prevLeft = 0, guard = 0;
  while (ws <= cur && guard++ < 1500) {
    const budget = budgetFor(ws);
    const spent = round2(spentBy[ws] || 0);
    const setAside = round2(setAsideBy[ws] || 0);
    const extra = round2(extraBy[ws] || 0);
    const carryIn = S.settings.rollover ? prevLeft : 0;
    const available = budget + carryIn + extra;
    const left = round2(available - spent - setAside);
    weeks.push({ start: ws, end: addDays(ws, 6), budget, spent, setAside, extra, carryIn, available, left, current: ws === cur });
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
  const pace = (cw.spent / Math.max(1, daysIn)) * 7;
  // Bills still to come this week (not yet logged).
  const billsLeft = sum(projectEvents(addDays(t, 1), cw.end).filter((e) => e.type === 'bill' || e.type === 'trial'), (e) => e.amount);
  const incomeMonth = sum(S.income.filter((i) => i.date.startsWith(monthKey)), (i) => i.amount);
  return { weeks, cw, done, lifetime, month, lastMonth, avgWeek, unspent, streak, daysLeft, perDay, pace, billsLeft, incomeMonth };
}

function catSpend(from, to) {
  const m = {};
  for (const e of S.expenses) if (inRange(e.date, from, to)) for (const p of parts(e)) m[p.categoryId] = (m[p.categoryId] || 0) + p.amount;
  return m;
}
function loggingStreak() {
  const days = new Set([...S.expenses.filter((e) => !e.subId).map((e) => e.date), ...S.noSpendMarks, ...S.income.filter((i) => !i.recurringId).map((i) => i.date)]);
  let d = today();
  if (!days.has(d)) d = addDays(d, -1);
  let n = 0;
  while (days.has(d) && n < 3650) { n++; d = addDays(d, -1); }
  return n;
}
/** Days with no spending (automatic bills don't count). Today counts only if marked. */
function noSpendDays(from, to) {
  const start = S.settings.startDate || firstDate();
  const spent = new Set(S.expenses.filter((e) => e.amount > 0 && !e.subId).map((e) => e.date));
  const out = [];
  const end = to < addDays(today(), -1) ? to : addDays(today(), -1);
  let d = from > start ? from : start;
  for (let g = 0; d <= end && g < 4000; g++, d = addDays(d, 1)) if (!spent.has(d)) out.push(d);
  if (inRange(today(), from, to) && S.noSpendMarks.includes(today()) && !spent.has(today())) out.push(today());
  return out;
}
function iouBalance(personId) { return round2(sum(S.ious.filter((x) => x.personId === personId), (x) => x.amount)); }

// ======================= Recurring engine =======================
function advanceSub(sub) {
  if (sub.cycle === 'weekly') sub.nextDate = addDays(sub.nextDate, 7);
  else if (sub.cycle === 'biweekly') sub.nextDate = addDays(sub.nextDate, 14);
  else if (sub.cycle === 'quarterly') sub.nextDate = addMonths(sub.nextDate, 3, sub.anchorDay);
  else if (sub.cycle === 'yearly') sub.nextDate = addMonths(sub.nextDate, 12, sub.anchorDay);
  else sub.nextDate = addMonths(sub.nextDate, 1, sub.anchorDay);
}
function monthlyCost(sub) {
  const a = Number(sub.amount) || 0;
  return { weekly: (a * 52) / 12, biweekly: (a * 26) / 12, monthly: a, quarterly: a / 3, yearly: a / 12 }[sub.cycle] ?? a;
}
function occurrences(item, from, to) {
  const out = [];
  if (!item.nextDate) return out;
  const it = { ...item };
  let g = 0;
  while (it.nextDate <= to && g++ < 600) { if (it.nextDate >= from) out.push(it.nextDate); advanceSub(it); }
  return out;
}
function logSubCharge(sub, date) {
  const id = `sub-${sub.id}-${date}`;
  if (S.expenses.some((e) => e.id === id)) return false;
  S.expenses.push({ id, amount: Number(sub.amount), categoryId: sub.categoryId || subsCat().id, note: sub.name, date, subId: sub.id, method: sub.method || '', tags: [], createdAt: Date.now() });
  return true;
}
function logRecurringIncome(r, date) {
  const id = `inc-${r.id}-${date}`;
  if (S.income.some((i) => i.id === id)) return false;
  S.income.push({ id, amount: Number(r.amount), name: r.name, type: r.type || 'other', date, addToBudget: !!r.addToBudget, recurringId: r.id, createdAt: Date.now() });
  return true;
}
/** Log subscription charges and recurring income that came due while the app was closed. */
function processRecurring() {
  const t = today();
  let n = 0, m = 0;
  for (const sub of S.subscriptions) {
    if (!sub.active || !sub.autoLog || !sub.nextDate) continue;
    let g = 0;
    while (sub.nextDate <= t && g++ < 120) { if (logSubCharge(sub, sub.nextDate)) n++; sub.trial = false; advanceSub(sub); }
  }
  for (const r of S.recurringIncome) {
    if (!r.active || !r.autoLog || !r.nextDate) continue;
    let g = 0;
    while (r.nextDate <= t && g++ < 120) { if (logRecurringIncome(r, r.nextDate)) m++; advanceSub(r); }
  }
  if (n || m) {
    save();
    const msg = [n && `${n} subscription charge${n > 1 ? 's' : ''}`, m && `${m} income payment${m > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
    setTimeout(() => toast(`Logged ${msg}`), 500);
  }
}

/** Future-facing calendar events between two dates (inclusive). */
function projectEvents(from, to) {
  const ev = [];
  for (const s of S.subscriptions) {
    if (!s.active) continue;
    occurrences(s, from, to).forEach((d, i) => {
      const trial = s.trial && i === 0 && d === s.nextDate;
      ev.push({ date: d, type: trial ? 'trial' : 'bill', ico: s.icon || catById(s.categoryId).icon, title: trial ? `${s.name} trial ends` : s.name, amount: Number(s.amount), ref: s.id });
    });
  }
  for (const r of S.recurringIncome) {
    if (!r.active) continue;
    occurrences(r, from, to).forEach((d) => ev.push({ date: d, type: 'income', ico: '💰', title: r.name, amount: Number(r.amount), ref: r.id }));
  }
  for (const g of S.goals) if (g.targetDate && inRange(g.targetDate, from, to)) ev.push({ date: g.targetDate, type: 'goal', ico: g.icon || '🎯', title: `${g.name} deadline`, amount: Math.max(0, g.price - g.saved), ref: g.id });
  for (const c of S.cooling) {
    if (c.status !== 'waiting') continue;
    const d = toISO(new Date(c.until));
    if (inRange(d, from, to)) ev.push({ date: d, type: 'cooling', ico: '🧊', title: `Decide on ${c.name}`, amount: c.price, ref: c.id });
  }
  return ev.sort((a, b) => a.date.localeCompare(b.date));
}

// ======================= Reminders =======================
function reminders() {
  const r = [];
  const t = today();
  const st = stats();
  const days = Number(S.settings.reminderDays) || 3;
  for (const e of projectEvents(t, addDays(t, days))) {
    const when = relDay(e.date).toLowerCase();
    if (e.type === 'trial') r.push({ key: `trial-${e.ref}-${e.date}`, lvl: 'bad', ico: '⏰', text: `Your <b>${esc(e.title.replace(' trial ends', ''))}</b> free trial ends ${when}. Cancel before then or you'll be charged ${money(e.amount)}.`, act: [['edit-sub', e.ref, 'Open']] });
    else if (e.type === 'bill') r.push({ key: `bill-${e.ref}-${e.date}`, lvl: daysBetween(t, e.date) <= 1 ? 'warn' : '', ico: e.ico, text: `<b>${esc(e.title)}</b> renews ${when}: ${money(e.amount)}.` });
    else if (e.type === 'income') r.push({ key: `inc-${e.ref}-${e.date}`, lvl: 'good', ico: '💰', text: `<b>${esc(e.title)}</b> (${money(e.amount)}) is expected ${when}.` });
  }
  const loggedToday = S.expenses.some((e) => e.date === t && !e.subId) || S.noSpendMarks.includes(t);
  if (S.settings.logReminder && !loggedToday && new Date().getHours() >= 18) r.push({ key: `log-${t}`, lvl: '', ico: '📝', text: `You haven't logged anything today. Did you spend anything?`, act: [['add-expense', '', 'Add expense'], ['no-spend', '', 'Spent nothing']] });
  if (st.cw.budget) {
    if (st.cw.left < 0) r.push({ key: `over-${st.cw.start}`, lvl: 'bad', ico: '🚨', text: `You're <b>${money(-st.cw.left)} over</b> this week's budget.` });
    else if (st.cw.left < st.cw.available * 0.15) r.push({ key: `low-${st.cw.start}`, lvl: 'warn', ico: '⚠️', text: `Only <b>${money(st.cw.left)}</b> left for the next ${st.daysLeft} day${st.daysLeft > 1 ? 's' : ''}.` });
  }
  const cs = catSpend(st.cw.start, st.cw.end);
  for (const c of S.categories) {
    if (!c.limit) continue;
    const s = cs[c.id] || 0;
    if (s > c.limit) r.push({ key: `lim-${c.id}-${st.cw.start}`, lvl: 'bad', ico: c.icon, text: `<b>${esc(c.name)}</b> is over its weekly limit (${money(s)} of ${money(c.limit)}).` });
    else if (s > c.limit * 0.85) r.push({ key: `near-${c.id}-${st.cw.start}`, lvl: 'warn', ico: c.icon, text: `<b>${esc(c.name)}</b> is at ${Math.round((s / c.limit) * 100)}% of its weekly limit.` });
  }
  for (const g of S.goals) {
    if (!g.targetDate || g.saved >= g.price) continue;
    const d = daysBetween(t, g.targetDate);
    if (d >= 0 && d <= 14) r.push({ key: `goal-${g.id}-${g.targetDate}`, lvl: 'warn', ico: g.icon || '🎯', text: `<b>${esc(g.name)}</b> is due in ${d} day${d === 1 ? '' : 's'}. You still need ${money(g.price - g.saved)}.`, act: [['contribute-goal', g.id, 'Add savings']] });
  }
  for (const p of S.people) {
    const b = iouBalance(p.id);
    const lastDate = S.ious.filter((x) => x.personId === p.id).map((x) => x.date).sort().pop();
    if (b > 0 && lastDate && daysBetween(lastDate, t) >= 14) r.push({ key: `iou-${p.id}-${lastDate}`, lvl: '', ico: '🤝', text: `<b>${esc(p.name)}</b> has owed you ${money(b)} since ${fmtDate(lastDate)}.`, act: [['open-person', p.id, 'View']] });
  }
  for (const c of S.cooling) if (c.status === 'waiting' && Date.now() >= c.until) r.push({ key: `cool-${c.id}`, lvl: 'good', ico: '🧊', text: `The cooling-off period for <b>${esc(c.name)}</b> is over. Do you still want it?`, act: [['goto-cooling', '', 'Decide']] });
  if (Sync.status === 'local' && S.expenses.length > 10 && (!DEV.lastBackup || daysBetween(DEV.lastBackup, t) > 30)) r.push({ key: `backup-${t.slice(0, 7)}`, lvl: '', ico: '💾', text: `Your data is only on this device. Export a backup to keep it safe.`, act: [['export-json', '', 'Back up now']] });
  const dismissed = DEV.dismissed || {};
  return r.filter((x) => !dismissed[x.key]);
}

// ======================= Achievements =======================
function achievements() {
  const st = stats();
  const nsAll = noSpendDays('0000-01-01', '9999-12-31');
  const nsSet = new Set(nsAll);
  const weekendNS = nsAll.some((d) => parse(d).getDay() === 6 && nsSet.has(addDays(d, 1)));
  const realTx = S.expenses.filter((e) => !e.subId).length;
  const streakLog = loggingStreak();
  let bestUnder = 0, run = 0;
  for (const w of st.done) { if (w.spent <= w.budget) { run++; bestUnder = Math.max(bestUnder, run); } else run = 0; }
  const skipped = S.cooling.filter((c) => c.status === 'skipped');
  const list = [
    ['first', '🌱', 'First step', 'Log your first expense', realTx, 1],
    ['tx100', '💯', 'Centurion', 'Log 100 transactions', realTx, 100],
    ['week1', '📅', 'Week one', 'Track a full week', st.done.length, 1],
    ['log7', '🔥', 'On a roll', 'Log something 7 days in a row', streakLog, 7],
    ['log30', '🌟', 'Habit formed', 'Log something 30 days in a row', streakLog, 30],
    ['under1', '✅', 'Under budget', 'Finish a week under budget', bestUnder, 1],
    ['under3', '🎩', 'Hat trick', '3 weeks under budget in a row', bestUnder, 3],
    ['under8', '🏆', 'Budget boss', '8 weeks under budget in a row', bestUnder, 8],
    ['ns1', '🧘', 'No-spend day', 'Go a whole day without spending', nsAll.length, 1],
    ['nsw', '🏝️', 'No-spend weekend', 'Spend nothing on a Saturday and Sunday', weekendNS ? 1 : 0, 1],
    ['ns10', '🧊', 'Ice cold', '10 no-spend days', nsAll.length, 10],
    ['saver', '🐷', 'Saver', 'Put money toward a goal', S.goals.some((g) => (g.contributions || []).some((c) => c.amount > 0)) ? 1 : 0, 1],
    ['funded', '🎉', 'Goal getter', 'Fully fund a goal', S.goals.filter((g) => g.saved >= g.price).length, 1],
    ['resist', '🛑', 'Impulse resisted', 'Skip something on your cooling-off list', skipped.length, 1],
    ['resist5', '🦾', 'Iron will', 'Skip 5 impulse buys', skipped.length, 5],
    ['subs3', '🔍', 'Subscription sleuth', 'Track 3 subscriptions', S.subscriptions.length, 3],
    ['custom', '🗂️', 'Organized', 'Create your own category', S.categories.filter((c) => !/^c\d+$/.test(c.id)).length, 1],
    ['scan', '📸', 'Receipt pro', 'Scan a receipt', S.expenses.filter((e) => e.scanned).length, 1],
    ['split', '🍕', 'Fair share', 'Split a bill with a friend', S.ious.filter((x) => x.type === 'split').length, 1],
    ['settle', '🤝', 'All square', 'Settle up with a friend', S.ious.filter((x) => x.type === 'settle').length, 1],
    ['income', '💼', 'Money in', 'Log your first income', S.income.length, 1],
    ['fav', '⚡', 'Speed logger', 'Save a quick-add favorite', S.templates.length, 1],
  ];
  return list.map(([id, ico, name, desc, have, need]) => ({ id, ico, name, desc, have: Math.min(have, need), need, done: have >= need }));
}

// ======================= Icons & charts =======================
const ICON = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  dashboard: ICON('<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>'),
  activity: ICON('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  calendar: ICON('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  categories: ICON('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  subscriptions: ICON('<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/>'),
  income: ICON('<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  goals: ICON('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  friends: ICON('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
  insights: ICON('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
  reports: ICON('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
  badges: ICON('<circle cx="12" cy="8" r="6"/><path d="M15.5 13 17 22l-5-3-5 3 1.5-9"/>'),
  prefs: ICON('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  more: ICON('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  sun: ICON('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: ICON('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  bell: ICON('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>'),
  camera: ICON('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  scale: ICON('<path d="M12 3v18M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0z"/>'),
  leaf: ICON('<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.1-6"/>'),
  split: ICON('<path d="M16 3h5v5M8 3H3v5M21 3l-7 7M3 3l7 7M12 22v-8"/>'),
  ice: ICON('<path d="M12 2v20M17 5l-5 5-5-5M17 19l-5-5-5 5M2 12h20M5 7l5 5-5 5M19 7l-5 5 5 5"/>'),
};
function ring(pct, { size = 150, stroke = 14, color = '#fff', track = 'rgba(255,255,255,.22)' } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = clamp(pct, 0, 1);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c * p} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})" style="transition:stroke-dasharray .6s"/></svg>`;
}
function donut(segs, { size = 170, stroke = 26, center = '' } = {}) {
  const total = sum(segs, (s) => s.value), r = (size - stroke) / 2, c = 2 * Math.PI * r;
  let off = 0;
  const gap = segs.length > 1 ? 2 : 0;
  const arcs = total ? segs.map((s) => {
    const len = (s.value / total) * c;
    const a = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${stroke}" stroke-dasharray="${Math.max(0, len - gap)} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(s.label)}: ${money(s.value)}</title></circle>`;
    off += len;
    return a;
  }).join('') : '';
  return `<div style="position:relative;width:${size}px;height:${size}px;max-width:100%"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--bg-2)" stroke-width="${stroke}"/>${arcs}</svg>
    <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center">${center}</div></div>`;
}
/** Vertical bars. data: [{label, value, target?, highlight?}] */
function bars(data, { height = 190, color = 'var(--accent)', showTarget = true, width = 640 } = {}) {
  const W = width, H = height, padB = 30, padT = 22;
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, showTarget ? d.target || 0 : 0))) * 1.08;
  const n = data.length || 1, slot = W / n, bw = Math.min(42, slot * 0.62);
  const y = (v) => H - padB - (Math.max(0, v) / max) * (H - padB - padT);
  const out = data.map((d, i) => {
    const x = i * slot + (slot - bw) / 2;
    const over = showTarget && d.target && d.value > d.target;
    const fill = d.highlight ? 'var(--accent-2)' : over ? 'var(--bad)' : color;
    const top = y(d.value), h = Math.max(0, H - padB - top);
    let s = `<rect x="${x}" y="${top}" width="${bw}" height="${h}" rx="6" fill="${fill}" opacity="${d.highlight ? 1 : 0.85}"><title>${esc(d.label)}: ${money(d.value)}${d.target ? ' of ' + money(d.target) : ''}</title></rect>`;
    if (showTarget && d.target) s += `<line x1="${x - 4}" x2="${x + bw + 4}" y1="${y(d.target)}" y2="${y(d.target)}" stroke="var(--text)" stroke-opacity=".45" stroke-width="2" stroke-dasharray="4 3"/>`;
    if (d.value > 0 && n <= 14) s += `<text x="${x + bw / 2}" y="${top - 5}" text-anchor="middle" style="font-size:13px;font-weight:600">${compact(d.value)}</text>`;
    s += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
    return s;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" stroke="var(--border)"/>${out}</svg>`;
}
/** Paired bars: data [{label, a, b}] — a = income (green), b = spending (accent). */
function pairBars(data, { height = 200, width = 640 } = {}) {
  const W = width, H = height, padB = 30, padT = 22;
  const max = Math.max(1, ...data.flatMap((d) => [d.a, d.b])) * 1.1;
  const n = data.length || 1, slot = W / n, bw = Math.min(26, slot * 0.32);
  const y = (v) => H - padB - (Math.max(0, v) / max) * (H - padB - padT);
  const out = data.map((d, i) => {
    const cx = i * slot + slot / 2;
    const bar = (x, v, fill, lbl) => `<rect x="${x}" y="${y(v)}" width="${bw}" height="${H - padB - y(v)}" rx="5" fill="${fill}"><title>${lbl}: ${money(v)}</title></rect>`;
    return bar(cx - bw - 2, d.a, 'var(--good)', 'Income') + bar(cx + 2, d.b, 'var(--accent)', 'Spent') + `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}"><line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" stroke="var(--border)"/>${out}</svg>`;
}

// ======================= Navigation =======================
const VIEWS = {
  dashboard: { label: 'Dashboard', render: renderDashboard },
  activity: { label: 'Activity', render: renderActivity },
  calendar: { label: 'Calendar', render: renderCalendar },
  categories: { label: 'Categories', render: renderCategories, group: 'Money' },
  subscriptions: { label: 'Subscriptions', render: renderSubscriptions },
  income: { label: 'Income', render: renderIncome },
  goals: { label: 'Wishlist & Goals', render: renderGoals },
  friends: { label: 'Friends & IOUs', render: renderFriends },
  insights: { label: 'Insights', render: renderInsights, group: 'Understand' },
  reports: { label: 'Reports', render: renderReports },
  badges: { label: 'Achievements', render: renderBadges },
  prefs: { label: 'Settings', render: renderSettings, group: '' },
  more: { label: 'More', render: renderMore, hidden: true },
};
const MOBILE_NAV = [['dashboard', 'Home'], ['activity', 'Activity'], ['calendar', 'Calendar'], ['goals', 'Goals'], ['more', 'More']];

function renderNav() {
  $('#nav').innerHTML = Object.entries(VIEWS).filter(([, v]) => !v.hidden).map(([k, v]) =>
    `${v.group ? `<div class="nav-sep">${v.group}</div>` : v.group === '' ? '<div style="flex:1;min-height:12px"></div>' : ''}<a href="#${k}" class="${UI.view === k ? 'active' : ''}"><span class="ico">${ICONS[k]}</span>${v.label}</a>`).join('');
  const mobileKeys = MOBILE_NAV.map((x) => x[0]);
  $('#bottom-nav').innerHTML = MOBILE_NAV.map(([k, label]) => {
    const active = UI.view === k || (k === 'more' && !mobileKeys.includes(UI.view));
    return `<a href="#${k}" class="${active ? 'active' : ''}"><span class="ico">${ICONS[k]}</span>${label}</a>`;
  }).join('');
}
function isDark() {
  const root = document.documentElement;
  return root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
}
function renderTopActions() {
  const n = Sync.readyResolved ? reminders().length : 0;
  $('#top-actions').innerHTML = `${syncPill()}
    <button class="icon-btn bell" data-action="open-reminders" aria-label="Reminders">${ICONS.bell}${n ? `<span class="badge-dot">${n}</span>` : ''}</button>
    <button class="icon-btn" data-action="toggle-theme" aria-label="Toggle theme">${isDark() ? ICONS.sun : ICONS.moon}</button>`;
}
function render() {
  const v = VIEWS[UI.view] || VIEWS.dashboard;
  renderNav();
  $('#view-title').textContent = v.label;
  $('#view-sub').textContent = '';
  if (!Sync.readyResolved) $('#view').innerHTML = `<div class="loading-veil"><div class="spinner"></div>Loading your budget…</div>`;
  else $('#view').innerHTML = v.render();
  renderTopActions();
}
function route() {
  const h = location.hash.slice(1) || 'dashboard';
  UI.view = VIEWS[h] ? h : 'dashboard';
  render();
  window.scrollTo(0, 0);
}

// ======================= Shared fragments =======================
function emptyState(ico, text, btn = '') {
  return `<div class="empty"><div class="e-ico">${ico}</div><div>${text}</div>${btn ? `<div style="margin-top:14px">${btn}</div>` : ''}</div>`;
}
function expenseRow(e, { showDate = false, cat = 'all' } = {}) {
  const ps = parts(e);
  const c = catById(ps.length > 1 ? [...ps].sort((a, b) => b.amount - a.amount)[0].categoryId : e.categoryId);
  const refund = e.amount < 0;
  const amt = amountFor(e, cat);
  const meta = [
    ps.length > 1 ? `Split · ${ps.length} categories` : c.name,
    showDate ? relDay(e.date) : '',
    e.subId ? 'Subscription' : '',
    e.split ? `Split with ${e.split.people.map((p) => personById(p).name).join(', ')}` : '',
    e.method || '',
  ].filter(Boolean).join(' · ');
  const tags = (e.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join(' ');
  return `<div class="row clickable" data-action="edit-expense" data-id="${e.id}">
    <div class="avatar" style="background:${c.color}22">${c.icon}</div>
    <div class="grow"><div class="title">${esc(e.note || c.name)} ${e.scanned ? '<span class="muted small" title="Scanned receipt">📸</span>' : ''}</div><div class="sub">${esc(meta)} ${tags}</div></div>
    <div class="amt num ${refund ? 'good' : ''}">${refund ? '+' : '−'}${money(Math.abs(amt))}</div>
  </div>`;
}
function reminderHTML(x) {
  return `<div class="reminder ${x.lvl}"><div class="r-ico">${x.ico}</div><div class="r-body"><div>${x.text}</div>
    ${x.act ? `<div class="r-actions">${x.act.map(([a, id, l]) => `<button class="btn sm" data-action="${a}" data-id="${id}">${l}</button>`).join('')}</div>` : ''}</div>
    <button class="x" data-action="dismiss-reminder" data-key="${esc(x.key)}" aria-label="Dismiss">✕</button></div>`;
}

// ======================= Dashboard =======================
function renderDashboard() {
  const st = stats();
  const { cw } = st;
  const used = cw.spent + cw.setAside;
  const pct = cw.available > 0 ? used / cw.available : (used > 0 ? 1 : 0);
  const over = cw.left < 0;
  $('#view-sub').textContent = `Week of ${fmtDate(cw.start)} – ${fmtDate(cw.end)}`;
  const cs = catSpend(cw.start, cw.end);
  const catRows = S.categories.map((c) => ({ c, spent: cs[c.id] || 0 })).filter((x) => x.spent > 0 || x.c.limit > 0).sort((a, b) => b.spent - a.spent);
  const recent = [...S.expenses].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 6);
  const upcoming = projectEvents(today(), addDays(today(), 14)).filter((e) => e.type !== 'goal').slice(0, 6);
  const last8 = st.weeks.slice(-8).map((w) => ({ label: fmtDate(w.start, { month: 'numeric', day: 'numeric' }), value: w.spent, target: w.budget, highlight: w.current }));
  const lmDelta = st.lastMonth ? (st.month - st.lastMonth) / st.lastMonth : 0;
  const rem = reminders();
  const safeAfterBills = cw.left - st.billsLeft;
  const spentToday = S.expenses.some((e) => e.date === today() && e.amount > 0 && !e.subId);
  const markedNS = S.noSpendMarks.includes(today());
  const owed = sum(S.people, (p) => Math.max(0, iouBalance(p.id)));
  const owe = sum(S.people, (p) => Math.max(0, -iouBalance(p.id)));
  const nsMonth = noSpendDays(today().slice(0, 8) + '01', today()).length;
  const ls = loggingStreak();

  const qa = [
    Cap.images ? ['scan-receipt', ICONS.camera, 'Scan receipt'] : null,
    ['afford', ICONS.scale, 'Can I afford it?'],
    spentToday ? null : ['no-spend', ICONS.leaf, markedNS ? 'No-spend day ✓' : 'Spent nothing today'],
    ['add-income', ICONS.income, 'Add income'],
    ['split-bill', ICONS.split, 'Split a bill'],
    ['add-cooling', ICONS.ice, 'Cooling-off list'],
  ].filter(Boolean);

  return `
  <div class="grid" style="gap:16px">
    <div class="card hero">
      <div class="ring-wrap">${ring(pct, { color: over ? '#ffd3d5' : '#fff' })}
        <div class="ring-center"><div><b>${Math.round(pct * 100)}%</b><span>used</span></div></div></div>
      <div style="position:relative;z-index:1">
        <div class="muted" style="font-weight:600">${over ? 'Over budget by' : 'Left to spend this week'}</div>
        <div class="big num">${money(Math.abs(cw.left))}</div>
        <div class="muted" style="margin-top:4px">${over ? 'Try to hold off on non-essentials until next week.' :
          `That's <b style="color:#fff">${money(st.perDay)}/day</b> for the next ${st.daysLeft} day${st.daysLeft > 1 ? 's' : ''}.`}
          ${st.billsLeft > 0 && !over ? `<br>After ${money(st.billsLeft)} in bills due this week: <b style="color:#fff">${money(Math.max(0, safeAfterBills))} safe to spend</b>.` : ''}</div>
        <div class="chips">
          <span class="chip">Spent ${money(cw.spent)}</span>
          <span class="chip">Budget ${money(cw.budget)}</span>
          ${cw.extra ? `<span class="chip">Extra income +${money(cw.extra)}</span>` : ''}
          ${cw.carryIn ? `<span class="chip">Rolled over ${cw.carryIn > 0 ? '+' : ''}${money(cw.carryIn)}</span>` : ''}
          ${cw.setAside ? `<span class="chip">Saved to goals ${money(cw.setAside)}</span>` : ''}
          <span class="chip">Pace ${money(st.pace)}/wk</span>
        </div>
      </div>
    </div>

    <div class="qa">${qa.map(([a, ico, l]) => `<button data-action="${a}"><span class="q-ico">${ico}</span>${l}</button>`).join('')}</div>

    ${S.templates.length ? `<div class="card" style="padding:14px 16px"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="muted small" style="font-weight:600">Quick add</span>
      ${S.templates.map((t) => `<button class="chip fav-chip" data-action="use-template" data-id="${t.id}">${catById(t.categoryId).icon} ${esc(t.name)} · ${money(t.amount)}</button>`).join('')}</div></div>` : ''}

    ${rem.length ? `<div class="card"><h3>Reminders <button class="btn sm" data-action="open-reminders">All ${rem.length}</button></h3>${rem.slice(0, 3).map(reminderHTML).join('')}</div>` : ''}

    <div class="grid g-4">
      <div class="card stat"><div class="label">Lifetime spent</div><div class="value num">${money(st.lifetime, { short: true })}</div><div class="foot">${S.expenses.length} transactions since ${fmtDate(firstDate(), { month: 'short', year: 'numeric' })}</div></div>
      <div class="card stat"><div class="label">This month</div><div class="value num">${money(st.month, { short: true })}</div><div class="foot">${st.lastMonth ? `<span class="${lmDelta > 0 ? 'bad' : 'good'}">${lmDelta > 0 ? '▲' : '▼'} ${Math.abs(Math.round(lmDelta * 100))}%</span> vs last month` : 'No data for last month'}</div></div>
      <div class="card stat"><div class="label">Avg per week</div><div class="value num">${money(st.avgWeek, { short: true })}</div><div class="foot">over ${Math.max(1, st.done.length)} week${st.done.length === 1 ? '' : 's'}</div></div>
      <div class="card stat"><div class="label">Under-budget streak</div><div class="value num">${st.streak} wk${st.streak === 1 ? '' : 's'}</div><div class="foot">${st.unspent >= 0 ? `<span class="good">${money(st.unspent, { short: true })}</span> unspent all-time` : `<span class="bad">${money(-st.unspent, { short: true })}</span> over all-time`}</div></div>
      <div class="card stat"><div class="label">Logging streak</div><div class="value num">${ls} day${ls === 1 ? '' : 's'}</div><div class="foot"><a href="#badges" class="link-btn">See achievements</a></div></div>
      <div class="card stat"><div class="label">No-spend days</div><div class="value num">${nsMonth}</div><div class="foot">this month</div></div>
      <div class="card stat"><div class="label">Income this month</div><div class="value num good">${money(st.incomeMonth, { short: true })}</div><div class="foot"><a href="#income" class="link-btn">Open income</a></div></div>
      <div class="card stat"><div class="label">Friends</div><div class="value num">${owed || owe ? money(owed - owe, { short: true }) : '—'}</div><div class="foot">${owed ? `<span class="good">${money(owed)}</span> owed to you` : ''}${owed && owe ? ' · ' : ''}${owe ? `<span class="bad">${money(owe)}</span> you owe` : ''}${!owed && !owe ? 'All settled up' : ''}</div></div>
    </div>

    <div class="grid g-2">
      <div class="card">
        <h3>This week by category <a class="btn sm" href="#categories">Manage</a></h3>
        ${catRows.length ? `<div class="list">${catRows.map(({ c, spent }) => {
          const lim = c.limit || 0;
          const p = lim ? spent / lim : (cw.spent ? spent / cw.spent : 0);
          const col = lim && spent > lim ? 'var(--bad)' : lim && spent > lim * 0.8 ? 'var(--warn)' : c.color;
          return `<div style="padding:9px 0"><div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:14px">
              <span>${c.icon} <b style="font-weight:600">${esc(c.name)}</b></span><span class="num">${money(spent)}${lim ? ` <span class="muted">/ ${money(lim)}</span>` : ''}</span></div>
            <div class="bar"><i style="width:${clamp(p, 0, 1) * 100}%;background:${col}"></i></div></div>`;
        }).join('')}</div>` : emptyState('🌤️', 'No spending yet this week.')}
      </div>
      <div class="card">
        <h3>Recent activity <a class="btn sm" href="#activity">See all</a></h3>
        ${recent.length ? `<div class="list">${recent.map((e) => expenseRow(e, { showDate: true })).join('')}</div>` :
          emptyState('🧾', 'Nothing logged yet.', '<button class="btn primary" data-action="add-expense">Add your first expense</button>')}
      </div>
    </div>

    <div class="grid g-3">
      <div class="card span-2"><h3>Last 8 weeks <span class="muted">dashed line = budget</span></h3>${bars(last8, { width: 560 })}</div>
      <div class="card">
        <h3>Coming up <a class="btn sm" href="#calendar">Calendar</a></h3>
        ${upcoming.length ? `<div class="list">${upcoming.map((e) => `<div class="row"><div class="avatar" style="background:var(--accent-soft)">${e.ico}</div>
            <div class="grow"><div class="title">${esc(e.title)}</div><div class="sub">${relDay(e.date)}</div></div>
            <div class="amt num ${e.type === 'income' ? 'good' : ''}">${e.type === 'income' ? '+' : ''}${money(e.amount)}</div></div>`).join('')}</div>` : emptyState('📭', 'Nothing due in the next 2 weeks.')}
      </div>
    </div>

    ${S.goals.length ? `<div class="card"><h3>Goals <a class="btn sm" href="#goals">All goals</a></h3>
      <div class="grid g-3">${S.goals.slice(0, 3).map((g) => {
        const p = g.price ? g.saved / g.price : 0;
        return `<div><div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px"><span>${g.icon || '🎯'} <b>${esc(g.name)}</b></span><span class="num muted">${Math.round(p * 100)}%</span></div>
          <div class="bar"><i style="width:${clamp(p, 0, 1) * 100}%;background:var(--grad)"></i></div>
          <div class="small muted" style="margin-top:6px">${money(g.saved)} of ${money(g.price)}</div></div>`;
      }).join('')}</div></div>` : ''}
  </div>`;
}

// ======================= Activity =======================
function periodRange(p) {
  const t = today();
  if (p === 'week') { const s = weekStartOf(t); return [s, addDays(s, 6)]; }
  if (p === 'lastweek') { const s = addDays(weekStartOf(t), -7); return [s, addDays(s, 6)]; }
  if (p === 'month') return [t.slice(0, 8) + '01', monthEnd(t.slice(0, 7))];
  if (p === 'lastmonth') { const s = addMonths(t.slice(0, 8) + '01', -1); return [s, monthEnd(s.slice(0, 7))]; }
  if (p === 'year') return [t.slice(0, 4) + '-01-01', t.slice(0, 4) + '-12-31'];
  return ['0000-01-01', '9999-12-31'];
}
const PERIODS = [['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'This year'], ['all', 'All time']];

function filteredExpenses() {
  const f = UI.actFilter;
  const [a, b] = periodRange(f.period);
  const q = f.q.trim().toLowerCase();
  return S.expenses.filter((e) => inRange(e.date, a, b) &&
    (f.cat === 'all' || parts(e).some((p) => p.categoryId === f.cat)) &&
    (!f.tag || (e.tags || []).includes(f.tag)) &&
    (!q || (e.note || '').toLowerCase().includes(q) || catById(e.categoryId).name.toLowerCase().includes(q) || String(e.amount).includes(q) || (e.tags || []).some((t) => t.includes(q.replace('#', ''))) || (e.method || '').toLowerCase().includes(q)))
    .sort((x, y) => y.date.localeCompare(x.date) || y.createdAt - x.createdAt);
}
function activitySub(list) {
  return `${list.length} transaction${list.length === 1 ? '' : 's'} · ${money(sum(list, (e) => amountFor(e, UI.actFilter.cat)))} total`;
}
function renderActivity() {
  const f = UI.actFilter;
  const list = filteredExpenses();
  $('#view-sub').textContent = activitySub(list);
  const allTags = [...new Set(S.expenses.flatMap((e) => e.tags || []))].sort();
  return `<div class="card">
    <div class="toolbar">
      <input class="input search" id="act-q" type="search" placeholder="Search notes, categories, #tags, amounts…" value="${esc(f.q)}" data-input="act-q" aria-label="Search transactions" />
      <select class="input" id="act-period" style="width:auto" data-change="act-period" aria-label="Period">${PERIODS.map(([k, l]) => `<option value="${k}" ${f.period === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn" data-action="export-csv">Export CSV</button>
    </div>
    <div class="chips-scroll" style="margin-bottom:8px">
      <button class="chip ${f.cat === 'all' ? 'sel' : ''}" data-action="act-cat" data-id="all">All</button>
      ${S.categories.map((c) => `<button class="chip ${f.cat === c.id ? 'sel' : ''}" data-action="act-cat" data-id="${c.id}">${c.icon} ${esc(c.name)}</button>`).join('')}
    </div>
    ${allTags.length ? `<div class="chips-scroll" style="margin-bottom:8px">${allTags.map((t) => `<button class="chip ${f.tag === t ? 'sel' : ''}" data-action="act-tag" data-id="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
    <div id="act-list">${activityList(list)}</div></div>`;
}
function activityList(list) {
  const byDay = {};
  for (const e of list) (byDay[e.date] = byDay[e.date] || []).push(e);
  const days = Object.keys(byDay).sort().reverse();
  if (!days.length) return emptyState('🔍', 'No transactions match.');
  return days.map((d) => `<div class="day-head"><span>${relDay(d)}</span><span class="num">${money(sum(byDay[d], (e) => amountFor(e, UI.actFilter.cat)))}</span></div>
    <div class="list">${byDay[d].map((e) => expenseRow(e, { cat: UI.actFilter.cat })).join('')}</div>`).join('');
}

// ======================= Calendar =======================
function renderCalendar() {
  const ym = UI.calMonth || today().slice(0, 7);
  const first = ym + '-01', last = monthEnd(ym);
  const gridStart = weekStartOf(first);
  const gridEnd = addDays(weekStartOf(last), 6);
  const spent = {}, inc = {};
  for (const e of S.expenses) if (inRange(e.date, gridStart, gridEnd)) spent[e.date] = (spent[e.date] || 0) + e.amount;
  for (const i of S.income) if (inRange(i.date, gridStart, gridEnd)) inc[i.date] = (inc[i.date] || 0) + i.amount;
  const evs = projectEvents(today() > gridStart ? today() : gridStart, gridEnd);
  const evBy = {};
  for (const e of evs) (evBy[e.date] = evBy[e.date] || []).push(e);
  const daily = (budgetFor(weekStartOf(first)) || 1) / 7;
  const dows = [...Array(7)].map((_, i) => new Date(2024, 0, 7 + ((i + Number(S.settings.weekStart)) % 7)).toLocaleDateString(undefined, { weekday: 'short' }));
  const dotCol = { bill: 'var(--warn)', trial: 'var(--bad)', income: 'var(--good)', goal: 'var(--accent)', cooling: '#06b6d4' };
  const cells = [];
  for (let d = gridStart, g = 0; d <= gridEnd && g < 42; d = addDays(d, 1), g++) {
    const s = spent[d] || 0;
    const lvl = s <= daily ? 'lo' : s <= daily * 1.6 ? 'mid' : 'hi';
    const ev = evBy[d] || [];
    cells.push(`<button class="day ${d.slice(0, 7) !== ym ? 'out' : ''} ${d === today() ? 'today' : ''}" data-action="cal-day" data-id="${d}" aria-label="${fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' })}">
      <span class="d-num">${parse(d).getDate()}</span>
      ${s ? `<span class="d-amt ${lvl}">${compact(s)}</span>` : ''}
      ${inc[d] ? `<span class="d-inc">+${compact(inc[d])}</span>` : ''}
      ${ev.slice(0, 2).map((e) => `<span class="d-ev">${e.ico} <b>${esc(e.title)}</b></span>`).join('')}
      ${ev.length > 2 ? `<span class="d-ev">+${ev.length - 2} more</span>` : ''}
      ${ev.length ? `<span class="d-dots">${ev.slice(0, 4).map((e) => `<i style="background:${dotCol[e.type]}"></i>`).join('')}</span>` : ''}
    </button>`);
  }
  const agenda = projectEvents(today(), addDays(today(), 30));
  const billTotal = sum(agenda.filter((e) => e.type === 'bill' || e.type === 'trial'), (e) => e.amount);
  const monthSpent = sum(S.expenses.filter((e) => e.date.startsWith(ym)), (e) => e.amount);
  $('#view-sub').textContent = `${money(monthSpent)} spent in ${monthName(ym, { month: 'long' })}`;
  return `<div class="grid g-3">
    <div class="card span-2">
      <div class="cal-head">
        <button class="icon-btn" data-action="cal-nav" data-id="-1" aria-label="Previous month">‹</button>
        <h3>${monthName(ym)}</h3>
        <button class="btn sm" data-action="cal-nav" data-id="0">Today</button>
        <button class="icon-btn" data-action="cal-nav" data-id="1" aria-label="Next month">›</button>
      </div>
      <div class="cal">${dows.map((d) => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div>
      <div class="cal-legend"><span><b class="good">●</b> under ${compact(daily)}/day</span><span><b class="warn">●</b> a bit over</span><span><b class="bad">●</b> big spending day</span><span><b class="warn">●</b> renewal</span><span><b class="bad">●</b> trial ends</span><span><b class="good">●</b> income</span><span>🎯 goal deadline</span><span>🧊 cooling-off ends</span></div>
    </div>
    <div class="card">
      <h3>Next 30 days <span class="muted">${money(billTotal)} in bills</span></h3>
      ${agenda.length ? `<div class="list">${agenda.map((e) => `<div class="row"><div class="avatar" style="background:var(--accent-soft)">${e.ico}</div>
        <div class="grow"><div class="title">${esc(e.title)}</div><div class="sub">${relDay(e.date)}${e.type === 'trial' ? ' · cancel before this date' : ''}</div></div>
        <div class="amt num ${e.type === 'income' ? 'good' : ''}">${e.type === 'income' ? '+' : ''}${money(e.amount)}</div></div>`).join('')}</div>`
        : emptyState('📆', 'Add subscriptions, recurring income or goals with deadlines to see them here.', '<button class="btn primary" data-action="add-sub">Add a subscription</button>')}
      ${!Cap.inArtifact && S.subscriptions.length ? `<button class="btn block" style="margin-top:12px" data-action="export-ics">Add renewals to my phone calendar</button>` : ''}
    </div>
  </div>`;
}
function dayModal(d) {
  const ex = S.expenses.filter((e) => e.date === d);
  const inc = S.income.filter((i) => i.date === d);
  const ev = d >= today() ? projectEvents(d, d) : [];
  const ns = noSpendDays(d, d).length > 0;
  openModal(parse(d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), `
    ${ex.length ? `<div class="day-head"><span>Spending</span><span class="num">${money(sum(ex, (e) => e.amount))}</span></div><div class="list">${ex.map((e) => expenseRow(e)).join('')}</div>` : ''}
    ${inc.length ? `<div class="day-head"><span>Income</span><span class="num good">+${money(sum(inc, (i) => i.amount))}</span></div><div class="list">${inc.map(incomeRow).join('')}</div>` : ''}
    ${ev.length ? `<div class="day-head"><span>Scheduled</span></div><div class="list">${ev.map((e) => `<div class="row"><div class="avatar" style="background:var(--accent-soft)">${e.ico}</div><div class="grow"><div class="title">${esc(e.title)}</div></div><div class="amt num">${money(e.amount)}</div></div>`).join('')}</div>` : ''}
    ${!ex.length && !inc.length && !ev.length ? emptyState(ns ? '🧘' : '📭', ns ? 'No-spend day. Nice.' : 'Nothing on this day.') : ''}
    <div class="form-actions"><button class="btn" data-action="add-income" data-id="${d}">Add income</button><button class="btn primary" data-action="add-expense" data-id="${d}">Add expense on this day</button></div>`);
}

// ======================= Categories =======================
function renderCategories() {
  const [ws, we] = periodRange('week'), [ms, me] = periodRange('month');
  const wk = catSpend(ws, we), mo = catSpend(ms, me), all = catSpend('0000-01-01', '9999-12-31');
  const counts = {};
  for (const e of S.expenses) for (const p of parts(e)) counts[p.categoryId] = (counts[p.categoryId] || 0) + 1;
  const totalLimits = sum(S.categories, (c) => c.limit);
  $('#view-sub').textContent = `${S.categories.length} categories${totalLimits ? ` · ${money(totalLimits)} in weekly limits` : ''}`;
  return `<div class="toolbar"><div style="flex:1" class="muted small">Tap a category to rename it, change its icon or set a weekly spending limit.</div>
    <button class="btn primary" data-action="add-category">+ New category</button></div>
  <div class="grid g-3">${S.categories.map((c) => {
    const spent = wk[c.id] || 0, p = c.limit ? spent / c.limit : 0;
    return `<div class="card" style="cursor:pointer" data-action="edit-category" data-id="${c.id}">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px"><div class="avatar" style="background:${c.color}22">${c.icon}</div>
        <div style="min-width:0;flex:1"><div style="font-weight:600">${esc(c.name)}</div><div class="muted small">${counts[c.id] || 0} transactions</div></div></div>
      <div class="kv"><span>This week</span><b class="num">${money(spent)}${c.limit ? ` / ${money(c.limit)}` : ''}</b></div>
      ${c.limit ? `<div class="bar" style="margin:6px 0"><i style="width:${clamp(p, 0, 1) * 100}%;background:${p > 1 ? 'var(--bad)' : p > 0.8 ? 'var(--warn)' : c.color}"></i></div>` : ''}
      <div class="kv"><span>This month</span><span class="num">${money(mo[c.id] || 0)}</span></div>
      <div class="kv"><span>Lifetime</span><span class="num">${money(all[c.id] || 0)}</span></div></div>`;
  }).join('')}</div>`;
}

// ======================= Subscriptions =======================
function renderSubscriptions() {
  const active = S.subscriptions.filter((s) => s.active);
  const monthly = sum(active, monthlyCost);
  const paid = sum(S.expenses.filter((e) => e.subId), (e) => e.amount);
  const list = [...S.subscriptions].sort((a, b) => (b.active - a.active) || (a.nextDate || '').localeCompare(b.nextDate || ''));
  const next = active.filter((s) => s.nextDate).sort((a, b) => a.nextDate.localeCompare(b.nextDate))[0];
  const weeklyShare = S.settings.weeklyBudget ? ((monthly * 12) / 52) / S.settings.weeklyBudget : 0;
  const trials = active.filter((s) => s.trial);
  $('#view-sub').textContent = `${active.length} active${trials.length ? ` · ${trials.length} free trial${trials.length > 1 ? 's' : ''}` : ''}`;
  return `<div class="grid g-4" style="margin-bottom:16px">
    <div class="card stat"><div class="label">Per month</div><div class="value num">${money(monthly)}</div><div class="foot">${money((monthly * 12) / 52)}/week equivalent</div></div>
    <div class="card stat"><div class="label">Per year</div><div class="value num">${money(monthly * 12, { short: true })}</div><div class="foot">if nothing changes</div></div>
    <div class="card stat"><div class="label">Share of weekly budget</div><div class="value num ${weeklyShare > 0.3 ? 'warn' : ''}">${Math.round(weeklyShare * 100)}%</div><div class="foot">taken up by subscriptions</div></div>
    <div class="card stat"><div class="label">Paid to date</div><div class="value num">${money(paid, { short: true })}</div><div class="foot">${next ? `Next: ${esc(next.name)} ${relDay(next.nextDate).toLowerCase()}` : 'Nothing scheduled'}</div></div>
  </div>
  <div class="card"><h3>Your subscriptions & bills <button class="btn primary sm" data-action="add-sub">+ Add</button></h3>
    ${list.length ? `<div class="list">${list.map((s) => {
      const c = catById(s.categoryId);
      const due = s.nextDate ? daysBetween(today(), s.nextDate) : null;
      return `<div class="row clickable" data-action="edit-sub" data-id="${s.id}" style="${s.active ? '' : 'opacity:.55'}">
        <div class="avatar" style="background:${c.color}22">${s.icon || c.icon}</div>
        <div class="grow"><div class="title">${esc(s.name)}</div>
          <div class="sub">${CYCLES.find((x) => x[0] === s.cycle)?.[1] || s.cycle} · ${s.active ? (s.nextDate ? `${s.trial ? 'trial ends' : 'next'} ${relDay(s.nextDate).toLowerCase()}` : 'no date') : 'paused'}${s.autoLog && s.active ? ' · auto-logs' : ''}</div></div>
        ${s.active && s.trial ? `<span class="chip" style="color:var(--bad)">Free trial</span>` : s.active && due !== null && due <= 3 ? `<span class="chip" style="color:var(--warn)">Due soon</span>` : ''}
        <div style="text-align:right"><div class="amt num">${money(s.amount)}</div><div class="sub small muted">${money(monthlyCost(s))}/mo</div></div></div>`;
    }).join('')}</div>` : emptyState('🔁', 'Track Netflix, Spotify, gym, phone bill, rent… and see what they really cost you per year.', '<button class="btn primary" data-action="add-sub">Add a subscription</button>')}
  </div>`;
}

// ======================= Income =======================
function incomeRow(i) {
  const t = INCOME_TYPES.find((x) => x[0] === i.type) || INCOME_TYPES[6];
  return `<div class="row clickable" data-action="edit-income" data-id="${i.id}"><div class="avatar" style="background:color-mix(in srgb, var(--good) 15%, transparent)">${t[1].split(' ')[0]}</div>
    <div class="grow"><div class="title">${esc(i.name || t[1].slice(3))}</div><div class="sub">${relDay(i.date)} · ${t[1].slice(3)}${i.addToBudget ? ' · added to weekly budget' : ''}${i.recurringId ? ' · recurring' : ''}</div></div>
    <div class="amt num good">+${money(i.amount)}</div></div>`;
}
function renderIncome() {
  const t = today();
  const mk = t.slice(0, 7);
  const incM = sum(S.income.filter((i) => i.date.startsWith(mk)), (i) => i.amount);
  const spM = sum(S.expenses.filter((e) => e.date.startsWith(mk)), (e) => e.amount);
  const life = sum(S.income, (i) => i.amount);
  const rate = incM > 0 ? (incM - spM) / incM : null;
  const months = [];
  for (let k = 5; k >= 0; k--) {
    const m = addMonths(mk + '-01', -k).slice(0, 7);
    months.push({ label: monthName(m, { month: 'short' }), a: sum(S.income.filter((i) => i.date.startsWith(m)), (i) => i.amount), b: sum(S.expenses.filter((e) => e.date.startsWith(m)), (e) => e.amount) });
  }
  const bySrc = {};
  for (const i of S.income) { const k = i.type || 'other'; bySrc[k] = (bySrc[k] || 0) + i.amount; }
  const list = [...S.income].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
  $('#view-sub').textContent = life ? `${money(life)} received all-time` : 'Money coming in';
  return `<div class="grid g-4" style="margin-bottom:16px">
    <div class="card stat"><div class="label">Income this month</div><div class="value num good">${money(incM)}</div><div class="foot">${S.income.filter((i) => i.date.startsWith(mk)).length} payment(s)</div></div>
    <div class="card stat"><div class="label">Spent this month</div><div class="value num">${money(spM)}</div><div class="foot">net ${incM - spM >= 0 ? '<span class="good">+' : '<span class="bad">'}${money(incM - spM)}</span></div></div>
    <div class="card stat"><div class="label">Savings rate</div><div class="value num">${rate === null ? '—' : Math.round(rate * 100) + '%'}</div><div class="foot">of this month's income kept</div></div>
    <div class="card stat"><div class="label">Lifetime income</div><div class="value num">${money(life, { short: true })}</div><div class="foot">vs ${money(sum(S.expenses, (e) => e.amount), { short: true })} spent</div></div>
  </div>
  <div class="grid g-2" style="margin-bottom:16px">
    <div class="card"><h3>Income vs spending <span class="muted"><b class="good">●</b> income <b style="color:var(--accent)">●</b> spent</span></h3>${pairBars(months)}</div>
    <div class="card"><h3>Recurring income <button class="btn sm" data-action="add-recurring-income">+ Add</button></h3>
      ${S.recurringIncome.length ? `<div class="list">${S.recurringIncome.map((r) => `<div class="row clickable" data-action="edit-recurring-income" data-id="${r.id}" style="${r.active ? '' : 'opacity:.55'}">
        <div class="avatar" style="background:color-mix(in srgb, var(--good) 15%, transparent)">💰</div><div class="grow"><div class="title">${esc(r.name)}</div>
        <div class="sub">${CYCLES.find((x) => x[0] === r.cycle)?.[1]} · ${r.active ? `next ${relDay(r.nextDate).toLowerCase()}` : 'paused'}${r.addToBudget ? ' · boosts weekly budget' : ''}</div></div>
        <div class="amt num good">+${money(r.amount)}</div></div>`).join('')}</div>`
        : emptyState('🗓️', 'Allowance, paycheck or anything that arrives on a schedule. It logs itself on the day.')}
      ${Object.keys(bySrc).length ? `<h3 style="margin-top:16px">By source</h3>${Object.entries(bySrc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="kv"><span>${(INCOME_TYPES.find((x) => x[0] === k) || INCOME_TYPES[6])[1]}</span><b class="num">${money(v)}</b></div>`).join('')}` : ''}
    </div>
  </div>
  <div class="card"><h3>Income history <button class="btn primary sm" data-action="add-income">+ Add income</button></h3>
    ${list.length ? `<div class="list">${list.map(incomeRow).join('')}</div>` : emptyState('💵', "No income right now? That's fine. Log gifts, side gigs, money from family, or things you sell. Turn on \"Add to that week's budget\" to get extra spending money for that week.", '<button class="btn primary" data-action="add-income">Log income</button>')}
  </div>`;
}

// ======================= Goals & cooling-off =======================
function goalMath(g) {
  const remaining = Math.max(0, g.price - g.saved);
  const contribs = g.contributions || [];
  const t = today();
  let perWeek = null, weeksLeft = null;
  if (g.targetDate) { weeksLeft = Math.max(0, daysBetween(t, g.targetDate) / 7); perWeek = weeksLeft > 0 ? remaining / weeksLeft : remaining; }
  const since = addDays(t, -56);
  const recent = sum(contribs.filter((c) => c.date >= since), (c) => c.amount);
  const first = contribs.length ? contribs.map((c) => c.date).sort()[0] : t;
  const spanWeeks = clamp(daysBetween(first < since ? since : first, t) / 7, 1, 8);
  const rate = recent / spanWeeks;
  const eta = rate > 0 && remaining > 0 ? addDays(t, Math.ceil((remaining / rate) * 7)) : null;
  return { remaining, perWeek, weeksLeft, rate, eta };
}
function renderGoals() {
  const tab = UI.goalsTab;
  const waiting = S.cooling.filter((c) => c.status === 'waiting');
  const head = `<div class="tabs"><button class="${tab === 'goals' ? 'sel' : ''}" data-action="goals-tab" data-id="goals">Savings goals (${S.goals.length})</button>
    <button class="${tab === 'cooling' ? 'sel' : ''}" data-action="goals-tab" data-id="cooling">Cooling-off list (${waiting.length})</button></div>`;
  return head + (tab === 'cooling' ? renderCooling() : renderGoalList());
}
function renderGoalList() {
  const totalNeed = sum(S.goals, (g) => Math.max(0, g.price - g.saved));
  const totalSaved = sum(S.goals, (g) => g.saved);
  const st = stats();
  $('#view-sub').textContent = S.goals.length ? `${money(totalSaved)} saved · ${money(totalNeed)} to go` : 'Things you want, and how to get there';
  const wantsPerWeek = sum(S.goals.map(goalMath), (m) => m.perWeek || 0);
  const usualLeft = Math.max(0, st.cw.budget - st.avgWeek);
  return `${S.goals.length ? `<div class="grid g-3" style="margin-bottom:16px">
    <div class="card stat"><div class="label">Total saved</div><div class="value num">${money(totalSaved)}</div><div class="foot">across ${S.goals.length} goal${S.goals.length > 1 ? 's' : ''}</div></div>
    <div class="card stat"><div class="label">Still needed</div><div class="value num">${money(totalNeed)}</div><div class="foot">${S.goals.filter((g) => g.saved >= g.price).length} goal(s) fully funded</div></div>
    <div class="card stat"><div class="label">Needed per week</div><div class="value num ${wantsPerWeek > usualLeft ? 'warn' : ''}">${money(wantsPerWeek)}</div><div class="foot">to hit every target date · you usually leave ${money(usualLeft)}/wk unspent</div></div>
  </div>` : ''}
  <div class="toolbar"><div style="flex:1"></div><button class="btn primary" data-action="add-goal">+ New goal</button></div>
  ${S.goals.length ? `<div class="grid g-3">${S.goals.map((g) => {
    const m = goalMath(g), p = g.price ? g.saved / g.price : 0, done = g.saved >= g.price;
    return `<div class="card goal-card">
      <div class="goal-top"><div class="avatar" style="background:var(--accent-soft)">${g.icon || '🎯'}</div>
        <div style="min-width:0;flex:1"><div style="font-weight:700">${esc(g.name)}</div><div class="muted small">${g.targetDate ? `by ${fmtDate(g.targetDate, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'No deadline'}</div></div>
        <button class="icon-btn" data-action="edit-goal" data-id="${g.id}" aria-label="Edit goal">✎</button></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="goal-amt num">${money(g.saved)}</span><span class="muted num">of ${money(g.price)}</span></div>
      <div class="bar"><i style="width:${clamp(p, 0, 1) * 100}%"></i></div>
      ${done ? `<div class="good" style="font-weight:700;margin:8px 0">🎉 Fully funded. Go get it!</div>` : `
        <div class="kv"><span>Remaining</span><b class="num">${money(m.remaining)}</b></div>
        ${m.perWeek !== null ? `<div class="kv"><span>Save per week</span><b class="num">${money(m.perWeek)}</b></div>
        <div class="kv"><span>Save per day</span><span class="num">${money(m.perWeek / 7)}</span></div>
        <div class="kv"><span>Weeks left</span><span class="num">${Math.ceil(m.weeksLeft)}</span></div>` : ''}
        <div class="kv"><span>Your pace</span><span class="num">${m.rate > 0 ? `${money(m.rate)}/wk → ${fmtDate(m.eta, { month: 'short', year: 'numeric' })}` : 'not started'}</span></div>`}
      <div class="form-actions" style="margin-top:12px">
        ${g.saved > 0 ? `<button class="btn sm" data-action="withdraw-goal" data-id="${g.id}">− Withdraw</button>` : ''}
        <button class="btn primary sm" data-action="contribute-goal" data-id="${g.id}">+ Add savings</button></div></div>`;
  }).join('')}</div>` : `<div class="card">${emptyState('🎯', 'Add something you want, like a trip, new shoes or an emergency fund, and see exactly how much to put away each week.', '<button class="btn primary" data-action="add-goal">Create a goal</button>')}</div>`}`;
}
function renderCooling() {
  const waiting = S.cooling.filter((c) => c.status === 'waiting').sort((a, b) => a.until - b.until);
  const decided = S.cooling.filter((c) => c.status !== 'waiting').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  const skipped = decided.filter((c) => c.status === 'skipped');
  const savedBySkipping = sum(skipped, (c) => c.price);
  $('#view-sub').textContent = `${money(savedBySkipping)} saved by skipping impulse buys`;
  const now = Date.now();
  const left = (ms) => { const h = Math.ceil(ms / 36e5); return h >= 48 ? `${Math.ceil(h / 24)} days left` : `${h} hour${h === 1 ? '' : 's'} left`; };
  return `<div class="grid g-3" style="margin-bottom:16px">
    <div class="card stat"><div class="label">Saved by skipping</div><div class="value num good">${money(savedBySkipping)}</div><div class="foot">${skipped.length} impulse buy${skipped.length === 1 ? '' : 's'} skipped</div></div>
    <div class="card stat"><div class="label">Waiting</div><div class="value num">${waiting.length}</div><div class="foot">${money(sum(waiting, (c) => c.price))} on hold</div></div>
    <div class="card stat"><div class="label">Bought after waiting</div><div class="value num">${decided.filter((c) => c.status === 'bought').length}</div><div class="foot">deliberate purchases</div></div>
  </div>
  <div class="card" style="margin-bottom:16px"><h3>Waiting to decide <button class="btn primary sm" data-action="add-cooling">+ Add item</button></h3>
    <p class="muted small" style="margin-top:0">Want something right now? Put it here first. Once the timer runs out, decide if you still want it. Most impulses fade.</p>
    ${waiting.length ? `<div class="list">${waiting.map((c) => {
      const total = c.until - c.addedAt, done = now >= c.until, p = clamp((now - c.addedAt) / total, 0, 1);
      return `<div class="row" style="flex-wrap:wrap"><div class="avatar" style="background:var(--accent-soft)">${catById(c.categoryId).icon}</div>
        <div class="grow"><div class="title">${esc(c.name)}</div><div class="cooling-timer ${done ? 'good' : 'muted'}">${done ? 'Ready to decide' : left(c.until - now)}</div>
          <div class="bar" style="margin-top:6px;height:6px"><i style="width:${p * 100}%;background:${done ? 'var(--good)' : 'var(--accent)'}"></i></div></div>
        <div class="amt num">${money(c.price)}</div>
        <div style="display:flex;gap:6px;width:100%;justify-content:flex-end;margin-top:6px;flex-wrap:wrap">
          <button class="btn sm" data-action="cool-skip" data-id="${c.id}">Skip it</button>
          <button class="btn sm" data-action="cool-goal" data-id="${c.id}">Make it a goal</button>
          ${done ? `<button class="btn primary sm" data-action="cool-buy" data-id="${c.id}">Buy it</button>` : ''}</div></div>`;
    }).join('')}</div>` : emptyState('🧊', 'Nothing waiting. Add the next thing you feel like buying on impulse.')}
  </div>
  ${decided.length ? `<div class="card"><h3>History</h3><div class="list">${decided.slice(0, 20).map((c) => `<div class="row"><div class="grow"><div class="title">${esc(c.name)}</div><div class="sub">${c.status === 'skipped' ? 'Skipped' : 'Bought'} · ${new Date(c.decidedAt || c.until).toLocaleDateString()}</div></div><div class="amt num ${c.status === 'skipped' ? 'good' : ''}">${c.status === 'skipped' ? 'saved ' : ''}${money(c.price)}</div><button class="x link-btn" data-action="cool-delete" data-id="${c.id}" aria-label="Remove">✕</button></div>`).join('')}</div></div>` : ''}`;
}

// ======================= Friends & IOUs =======================
function renderFriends() {
  const bal = S.people.map((p) => ({ p, b: iouBalance(p.id) }));
  const owed = sum(bal, (x) => Math.max(0, x.b)), owe = sum(bal, (x) => Math.max(0, -x.b));
  $('#view-sub').textContent = S.people.length ? `${S.people.length} friend${S.people.length > 1 ? 's' : ''}` : 'Split bills and track who owes what';
  return `<div class="grid g-3" style="margin-bottom:16px">
    <div class="card stat"><div class="label">Owed to you</div><div class="value num good">${money(owed)}</div><div class="foot">${bal.filter((x) => x.b > 0).length} friend(s)</div></div>
    <div class="card stat"><div class="label">You owe</div><div class="value num ${owe ? 'bad' : ''}">${money(owe)}</div><div class="foot">${bal.filter((x) => x.b < 0).length} friend(s)</div></div>
    <div class="card stat"><div class="label">Net</div><div class="value num">${money(owed - owe)}</div><div class="foot">${owed - owe >= 0 ? 'in your favor' : 'you owe overall'}</div></div>
  </div>
  <div class="card"><h3>Friends <span style="display:flex;gap:8px"><button class="btn sm" data-action="split-bill">Split a bill</button><button class="btn primary sm" data-action="add-person">+ Add friend</button></span></h3>
    ${bal.length ? `<div class="list">${bal.sort((a, b) => Math.abs(b.b) - Math.abs(a.b)).map(({ p, b }) => `<div class="row clickable" data-action="open-person" data-id="${p.id}">
      <div class="avatar" style="background:${p.color}22;color:${p.color};font-weight:800">${esc(p.name.slice(0, 1).toUpperCase())}</div>
      <div class="grow"><div class="title">${esc(p.name)}</div><div class="sub">${b > 0 ? 'owes you' : b < 0 ? 'you owe' : 'settled up'}</div></div>
      <div class="amt num ${b > 0 ? 'good' : b < 0 ? 'bad' : 'muted'}">${b ? money(Math.abs(b)) : '—'}</div></div>`).join('')}</div>`
      : emptyState('🤝', 'Add friends to split dinners, rides and trips. Only your share counts toward your budget.', '<button class="btn primary" data-action="add-person">Add a friend</button>')}
  </div>`;
}
function personModal(id) {
  const p = personById(id), b = iouBalance(id);
  const hist = S.ious.filter((x) => x.personId === id).sort((a, c) => c.date.localeCompare(a.date));
  const label = { split: 'Split', lent: 'You lent', borrowed: 'You borrowed', settle: 'Settled up' };
  openModal(p.name, `
    <div class="big-answer num ${b > 0 ? 'good' : b < 0 ? 'bad' : ''}">${b > 0 ? `${esc(p.name)} owes you ${money(b)}` : b < 0 ? `You owe ${esc(p.name)} ${money(-b)}` : 'All settled up'}</div>
    <div class="form-actions" style="justify-content:flex-start;margin-bottom:12px">
      ${b ? `<button class="btn primary sm" data-action="settle" data-id="${id}">Settle up ${money(Math.abs(b))}</button>` : ''}
      <button class="btn sm" data-action="iou-add" data-id="${id}" data-kind="lent">I lent them money</button>
      <button class="btn sm" data-action="iou-add" data-id="${id}" data-kind="borrowed">I borrowed money</button></div>
    ${hist.length ? `<div class="list">${hist.map((x) => `<div class="row"><div class="grow"><div class="title">${esc(x.note || label[x.type] || 'Entry')}</div><div class="sub">${label[x.type] || ''} · ${fmtDate(x.date, { month: 'short', day: 'numeric', year: 'numeric' })}</div></div>
      <div class="amt num ${x.amount > 0 ? 'good' : 'bad'}">${x.amount > 0 ? '+' : '−'}${money(Math.abs(x.amount))}</div>
      ${x.expenseId ? '' : `<button class="x link-btn" data-action="iou-delete" data-id="${x.id}" aria-label="Delete entry">✕</button>`}</div>`).join('')}</div>
      <p class="small muted">+ means they owe you more, − means you owe them more.</p>` : emptyState('🧾', 'No history yet.')}
    <div class="form-actions"><button class="btn danger" data-action="delete-person" data-id="${id}">Remove friend</button><span class="spacer"></span><button class="btn" data-action="close-modal">Done</button></div>`);
}

// ======================= Insights =======================
function renderInsights() {
  const st = stats();
  const range = UI.catRange;
  const [a, b] = periodRange(range);
  const cs = catSpend(a, b);
  const segs = S.categories.map((c) => ({ label: `${c.icon} ${c.name}`, value: cs[c.id] || 0, color: c.color })).filter((s) => s.value > 0).sort((x, y) => y.value - x.value);
  const segTotal = sum(segs, (s) => s.value);
  const weeks12 = st.weeks.slice(-12).map((w) => ({ label: fmtDate(w.start, { month: 'numeric', day: 'numeric' }), value: w.spent, target: w.budget, highlight: w.current }));
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const k = addMonths(today().slice(0, 8) + '01', -i).slice(0, 7);
    months.push({ label: monthName(k, { month: 'short' }), value: sum(S.expenses.filter((e) => e.date.startsWith(k)), (e) => e.amount), highlight: i === 0 });
  }
  const dowNames = [...Array(7)].map((_, i) => new Date(2024, 0, 7 + ((i + Number(S.settings.weekStart)) % 7)).toLocaleDateString(undefined, { weekday: 'short' }));
  const dowTot = Array(7).fill(0);
  for (const e of S.expenses) dowTot[(parse(e.date).getDay() - Number(S.settings.weekStart) + 7) % 7] += e.amount;
  const nWeeks = Math.max(1, st.weeks.length);
  const dow = dowTot.map((v, i) => ({ label: dowNames[i], value: v / nWeeks }));
  const topDow = dow.reduce((m, d, i) => (d.value > dow[m].value ? i : m), 0);
  const notes = {};
  for (const e of S.expenses) if (e.note && e.amount > 0) { const k = e.note.trim().toLowerCase(); notes[k] = notes[k] || { name: e.note.trim(), total: 0, n: 0 }; notes[k].total += e.amount; notes[k].n++; }
  const topNotes = Object.values(notes).sort((x, y) => y.total - x.total).slice(0, 6);
  const inR = S.expenses.filter((e) => inRange(e.date, a, b) && e.amount > 0);
  const tagTot = {}, methTot = {};
  for (const e of inR) { for (const t of e.tags || []) tagTot['#' + t] = (tagTot['#' + t] || 0) + e.amount; const m = e.method || 'Not set'; methTot[m] = (methTot[m] || 0) + e.amount; }
  const hmStart = addDays(weekStartOf(today()), -28);
  const daily = {};
  for (const e of S.expenses) if (e.date >= hmStart) daily[e.date] = (daily[e.date] || 0) + e.amount;
  const hmMax = Math.max(1, ...Object.values(daily));

  const tips = [];
  const cw = st.cw, lw = st.weeks[st.weeks.length - 2];
  if (cw.spent > 0 && st.pace > cw.budget && cw.budget) tips.push(['⚠️', `At this pace you'll spend about <b>${money(st.pace)}</b> this week, which is ${money(st.pace - cw.budget)} over budget.`]);
  else if (cw.budget && cw.spent > 0) tips.push(['✅', `You're on pace to finish the week around <b>${money(st.pace)}</b>, under your ${money(cw.budget)} budget.`]);
  if (lw) {
    const lcs = catSpend(lw.start, lw.end), ccs = catSpend(cw.start, cw.end);
    let best = null;
    for (const c of S.categories) { const d = (ccs[c.id] || 0) - (lcs[c.id] || 0); if (!best || Math.abs(d) > Math.abs(best.d)) best = { c, d }; }
    if (best && Math.abs(best.d) >= 1) tips.push([best.d > 0 ? '📈' : '📉', `${best.c.icon} ${esc(best.c.name)} is <b>${best.d > 0 ? 'up' : 'down'} ${money(Math.abs(best.d))}</b> compared with last week.`]);
  }
  if (segs[0] && segTotal) tips.push(['🏷️', `${esc(segs[0].label)} is your biggest category (${PERIODS.find((p) => p[0] === range)[1].toLowerCase()}) at <b>${Math.round((segs[0].value / segTotal) * 100)}%</b> of spending.`]);
  if (dow[topDow].value > 0) tips.push(['📆', `<b>${dowNames[topDow]}</b> is your most expensive day, averaging ${money(dow[topDow].value)}.`]);
  const activeSubs = S.subscriptions.filter((s) => s.active);
  const subMonthly = sum(activeSubs, monthlyCost);
  if (subMonthly) tips.push(['🔁', `Subscriptions cost you <b>${money(subMonthly * 12)}</b> a year. Cancelling an average one (${money(subMonthly / activeSubs.length)}/mo) saves about ${money((subMonthly / activeSubs.length) * 12)}/yr.`]);
  const [mFrom, mTo] = periodRange('month');
  const small = S.expenses.filter((e) => inRange(e.date, mFrom, mTo) && e.amount > 0 && e.amount < 10);
  if (small.length >= 5) tips.push(['☕', `${small.length} small purchases under ${money(10)} this month add up to <b>${money(sum(small, (e) => e.amount))}</b>.`]);
  const biggest = [...S.expenses].filter((e) => e.date >= mFrom).sort((x, y) => y.amount - x.amount)[0];
  if (biggest) tips.push(['💥', `Biggest purchase this month: <b>${esc(biggest.note || catById(biggest.categoryId).name)}</b> for ${money(biggest.amount)} (${relDay(biggest.date).toLowerCase()}).`]);
  if (st.unspent > 0 && st.done.length) tips.push(['💰', `You've left <b>${money(st.unspent)}</b> of your budget unspent overall. You could move some of it into a goal.`]);

  const kvList = (obj) => Object.entries(obj).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b class="num">${money(v)}</b></div>`).join('');
  return `<div class="grid g-2" style="margin-bottom:16px">
    <div class="card"><h3>Insights</h3>${tips.length ? tips.map(([i, t]) => `<div class="insight"><div class="i-ico">${i}</div><div>${t}</div></div>`).join('') : emptyState('🧠', 'Log a few expenses and insights will show up here.')}</div>
    <div class="card"><h3>Where it goes
        <select class="input" id="cat-range" style="width:auto;padding:6px 10px" data-change="cat-range" aria-label="Period">${PERIODS.map(([k, l]) => `<option value="${k}" ${range === k ? 'selected' : ''}>${l}</option>`).join('')}</select></h3>
      ${segs.length ? `<div class="donut-layout">${donut(segs, { center: `<div><div class="muted small">Total</div><b class="num" style="font-size:18px">${compact(segTotal)}</b></div>` })}
        <div class="legend">${segs.map((s) => `<div class="li"><span class="dot" style="background:${s.color}"></span><span class="grow">${esc(s.label)}</span><b class="num">${money(s.value)}</b><span class="muted num small" style="width:36px;text-align:right">${Math.round((s.value / segTotal) * 100)}%</span></div>`).join('')}</div></div>`
        : emptyState('🍩', 'No spending in this period.')}
      ${inR.length ? `<div class="split-two" style="margin-top:16px">
        <div><h3>By tag</h3>${Object.keys(tagTot).length ? kvList(tagTot) : '<div class="muted small">Add #tags to expenses to see them here.</div>'}</div>
        <div><h3>By payment method</h3>${kvList(methTot)}</div></div>` : ''}
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
        const d = addDays(hmStart, i), v = daily[d] || 0, future = d > today();
        return `<div class="cell" title="${fmtDate(d)}: ${money(v)}" style="${future ? 'opacity:.3' : v ? `background:color-mix(in srgb, var(--accent) ${Math.round(20 + (80 * v) / hmMax)}%, transparent)` : ''}${d === today() ? ';outline:2px solid var(--text)' : ''}"></div>`;
      }).join('')}</div><div class="small muted" style="margin-top:10px">Darker means more spent that day.</div></div>
    <div class="card"><h3>Top places & items</h3>
      ${topNotes.length ? `<div class="list">${topNotes.map((n) => `<div class="row"><div class="grow"><div class="title">${esc(n.name)}</div><div class="sub">${n.n} time${n.n > 1 ? 's' : ''}</div></div><div class="amt num">${money(n.total)}</div></div>`).join('')}</div>`
        : emptyState('📍', 'Add notes like “Starbucks” to your expenses to see where you spend most.')}</div>
  </div>`;
}

// ======================= Reports =======================
function renderReports() {
  const t = today();
  const monthsWithData = [...new Set([t.slice(0, 7), ...S.expenses.map((e) => e.date.slice(0, 7)), ...S.income.map((i) => i.date.slice(0, 7))])].filter((m) => m <= t.slice(0, 7)).sort().reverse();
  const years = [...new Set(monthsWithData.map((m) => m.slice(0, 4)))];
  const key = UI.reportKey || 'm:' + t.slice(0, 7);
  const isYear = key.startsWith('y:');
  const val = key.slice(2);
  const from = isYear ? `${val}-01-01` : `${val}-01`;
  const to = isYear ? `${val}-12-31` : monthEnd(val);
  const prevFrom = isYear ? `${+val - 1}-01-01` : addMonths(from, -1);
  const prevTo = isYear ? `${+val - 1}-12-31` : monthEnd(prevFrom.slice(0, 7));
  const ex = S.expenses.filter((e) => inRange(e.date, from, to));
  const prevEx = S.expenses.filter((e) => inRange(e.date, prevFrom, prevTo));
  const total = sum(ex, (e) => e.amount), prevTotal = sum(prevEx, (e) => e.amount);
  const inc = sum(S.income.filter((i) => inRange(i.date, from, to)), (i) => i.amount);
  const cs = catSpend(from, to), pcs = catSpend(prevFrom, prevTo);
  const endForAvg = to > t ? t : to;
  const nDays = Math.max(1, daysBetween(from, endForAvg) + 1);
  const byDay = {};
  for (const e of ex) byDay[e.date] = (byDay[e.date] || 0) + e.amount;
  const bigDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const weeks = computeWeeks().filter((w) => !w.current && w.start >= from && w.start <= to);
  const under = weeks.filter((w) => w.spent <= w.budget).length;
  const ns = noSpendDays(from, to).length;
  const subsPaid = sum(ex.filter((e) => e.subId), (e) => e.amount);
  const saved = sum(S.goals.flatMap((g) => g.contributions || []).filter((c) => inRange(c.date, from, to)), (c) => c.amount);
  const top = [...ex].sort((a, b) => b.amount - a.amount).slice(0, 5);
  const delta = prevTotal ? (total - prevTotal) / prevTotal : null;
  const label = isYear ? val : monthName(val);
  const prevLabel = isYear ? `${+val - 1}` : monthName(prevFrom.slice(0, 7), { month: 'long' });
  $('#view-sub').textContent = `Your ${isYear ? 'year' : 'month'} in money`;
  const catRows = S.categories.map((c) => ({ c, v: cs[c.id] || 0, p: pcs[c.id] || 0 })).filter((x) => x.v || x.p).sort((a, b) => b.v - a.v);
  return `<div class="toolbar"><select class="input" id="report-key" style="width:auto" data-change="report-key" aria-label="Report period">
      <optgroup label="Months">${monthsWithData.map((m) => `<option value="m:${m}" ${key === 'm:' + m ? 'selected' : ''}>${monthName(m)}</option>`).join('')}</optgroup>
      <optgroup label="Years">${years.map((y) => `<option value="y:${y}" ${key === 'y:' + y ? 'selected' : ''}>${y}</option>`).join('')}</optgroup></select></div>
  <div class="card hero" style="grid-template-columns:1fr;margin-bottom:16px"><div style="position:relative;z-index:1">
    <div class="muted" style="font-weight:600">${label}</div><div class="big num">${money(total)} spent</div>
    <div class="muted" style="margin-top:4px">${delta === null ? 'No data for the period before to compare.' : `${delta > 0 ? 'Up' : 'Down'} ${Math.abs(Math.round(delta * 100))}% from ${prevLabel} (${money(prevTotal)}).`}</div>
    <div class="chips"><span class="chip">${ex.length} transactions</span><span class="chip">${money(total / nDays)}/day average</span>${inc ? `<span class="chip">Income ${money(inc)}</span><span class="chip">Net ${money(inc - total)}</span>` : ''}</div></div></div>
  <div class="grid g-4" style="margin-bottom:16px">
    <div class="card stat"><div class="label">Weeks under budget</div><div class="value num">${under}/${weeks.length}</div><div class="foot">completed weeks</div></div>
    <div class="card stat"><div class="label">No-spend days</div><div class="value num">${ns}</div><div class="foot">automatic bills don't count</div></div>
    <div class="card stat"><div class="label">Subscriptions paid</div><div class="value num">${money(subsPaid)}</div><div class="foot">${total ? Math.round((subsPaid / total) * 100) : 0}% of spending</div></div>
    <div class="card stat"><div class="label">Put toward goals</div><div class="value num good">${money(saved)}</div><div class="foot">${bigDay ? `Biggest day: ${fmtDate(bigDay[0])} (${money(bigDay[1])})` : ''}</div></div>
  </div>
  <div class="grid g-2">
    <div class="card"><h3>By category <span class="muted">vs ${prevLabel}</span></h3>
      ${catRows.length ? `<div class="list">${catRows.map(({ c, v, p }) => { const d = v - p; return `<div class="row"><div class="avatar" style="background:${c.color}22">${c.icon}</div><div class="grow"><div class="title">${esc(c.name)}</div><div class="sub">${total ? Math.round((v / total) * 100) : 0}% of spending</div></div>
        <div style="text-align:right"><div class="amt num">${money(v)}</div><div class="small num ${d > 0 ? 'bad' : d < 0 ? 'good' : 'muted'}">${d > 0 ? '▲ ' : d < 0 ? '▼ ' : ''}${d ? money(Math.abs(d)) : 'same'}</div></div></div>`; }).join('')}</div>` : emptyState('📊', 'No spending in this period.')}</div>
    <div class="card"><h3>Biggest purchases</h3>${top.length ? `<div class="list">${top.map((e) => expenseRow(e, { showDate: true })).join('')}</div>` : emptyState('🧾', 'Nothing yet.')}</div>
  </div>`;
}

// ======================= Achievements =======================
function renderBadges() {
  const list = achievements();
  const got = list.filter((a) => a.done).length;
  $('#view-sub').textContent = `${got} of ${list.length} unlocked`;
  return `<div class="grid g-3" style="margin-bottom:16px">
    <div class="card stat"><div class="label">Logging streak</div><div class="value num">${loggingStreak()} days</div><div class="foot">days in a row with something logged</div></div>
    <div class="card stat"><div class="label">Under-budget streak</div><div class="value num">${stats().streak} weeks</div><div class="foot">consecutive weeks</div></div>
    <div class="card stat"><div class="label">No-spend days</div><div class="value num">${noSpendDays('0000-01-01', '9999-12-31').length}</div><div class="foot">all-time</div></div>
  </div>
  <div class="badges">${list.map((a) => `<div class="badge-card ${a.done ? '' : 'locked'}"><div class="b-ico">${a.ico}</div><div class="b-name">${a.name}</div><div class="b-desc">${a.desc}</div>
    ${a.done ? '<div class="small good" style="margin-top:8px;font-weight:700">Unlocked</div>' : `<div class="bar"><i style="width:${(a.have / a.need) * 100}%"></i></div><div class="small muted" style="margin-top:4px">${a.have} / ${a.need}</div>`}</div>`).join('')}</div>`;
}

// ======================= More & Settings =======================
function renderMore() {
  const items = [['categories', 'Categories', 'Organize spending and set weekly limits'], ['subscriptions', 'Subscriptions', 'Renewals, free trials and yearly cost'], ['income', 'Income', 'Money in, savings rate'], ['friends', 'Friends & IOUs', 'Split bills, track who owes what'], ['insights', 'Insights', 'Charts, trends and patterns'], ['reports', 'Reports', 'Monthly and yearly summaries'], ['badges', 'Achievements', 'Streaks and badges'], ['prefs', 'Settings', 'Budget, reminders, PIN lock, backup']];
  return `<div class="card"><div class="list">${items.map(([k, l, d]) => `<a class="row clickable" href="#${k}" style="text-decoration:none;color:inherit">
    <div class="avatar" style="background:var(--accent-soft);color:var(--accent)">${ICONS[k]}</div>
    <div class="grow"><div class="title">${l}</div><div class="sub">${d}</div></div><span class="muted">›</span></a>`).join('')}</div></div>`;
}
function renderSettings() {
  const s = S.settings;
  const days = [...Array(7)].map((_, i) => new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'long' }));
  const hist = [...S.budgetHistory].sort((a, b) => b.from.localeCompare(a.from));
  const syncText = {
    ok: "Synced to your Claude account. Open this page on any device where you're signed in to see the same data. Nobody else can read it.",
    busy: 'Syncing to your Claude account…', starting: 'Connecting…',
    offline: "Can't reach the cloud right now. Changes are saved on this device and will sync when you're back online.",
    local: 'Stored only in this browser. Open the app from your Claude link to sync between devices.',
  }[Sync.status];
  return `<div class="grid g-2">
    <div class="card"><h3>Budget</h3>
      <form data-form="settings">
        <div class="field"><label for="s-budget">Weekly budget</label><input class="input num" id="s-budget" name="weeklyBudget" type="number" step="0.01" min="0" inputmode="decimal" value="${s.weeklyBudget || ''}" required /></div>
        <div class="row-2">
          <div class="field"><label for="s-ws">Week starts on</label><select class="input" id="s-ws" name="weekStart">${days.map((d, i) => `<option value="${i}" ${Number(s.weekStart) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
          <div class="field"><label for="s-cur">Currency</label><select class="input" id="s-cur" name="currency">${CURRENCIES.map((c) => `<option ${s.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>
        <label class="toggle"><span><b>Roll over leftovers</b><br><span class="small muted">Unspent money (or overspending) carries into next week.</span></span><input type="checkbox" name="rollover" ${s.rollover ? 'checked' : ''}/></label>
        <h3 style="margin-top:14px">Reminders</h3>
        <div class="row-2">
          <div class="field"><label for="s-rd">Remind me about bills</label><select class="input" id="s-rd" name="reminderDays">${[1, 2, 3, 5, 7].map((n) => `<option value="${n}" ${Number(s.reminderDays) === n ? 'selected' : ''}>${n} day${n > 1 ? 's' : ''} before</option>`).join('')}</select></div>
          <div class="field"><label for="s-cool">Default cooling-off time</label><select class="input" id="s-cool" name="coolingHours">${COOL_OPTS.map(([h, l]) => `<option value="${h}" ${Number(s.coolingHours) === h ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
        <label class="toggle"><span><b>Evening logging nudge</b><br><span class="small muted">After 6pm, remind me if I haven't logged anything today.</span></span><input type="checkbox" name="logReminder" ${s.logReminder ? 'checked' : ''}/></label>
        <div class="field" style="margin-top:8px"><label for="s-theme">Theme</label>
          <select class="input" id="s-theme" name="theme">${[['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<option value="${k}" ${s.theme === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="form-actions"><button class="btn primary" type="submit">Save settings</button></div>
      </form>
      ${hist.length > 1 ? `<h3 style="margin-top:18px">Budget history</h3><div class="list">${hist.map((h) => `<div class="row"><div class="grow">From week of ${fmtDate(h.from, { month: 'short', day: 'numeric', year: 'numeric' })}</div><b class="num">${money(h.amount)}/wk</b></div>`).join('')}</div>
        <p class="small muted">Past weeks are always measured against the budget you had at the time.</p>` : ''}
    </div>
    <div class="grid" style="gap:16px;align-content:start">
      <div class="card"><h3>Sync ${syncPill().replace('id="sync-pill"', '')}</h3><p class="muted small" style="margin:0">${syncText}</p></div>
      <div class="card"><h3>PIN lock</h3>
        <p class="muted small" style="margin-top:0">Ask for a 4-digit PIN when the app opens on this device. Currently ${DEV.pinHash ? '<b class="good">on</b>' : 'off'}.</p>
        <div class="form-actions" style="justify-content:flex-start">${DEV.pinHash ? '<button class="btn" data-action="set-pin">Change PIN</button><button class="btn danger" data-action="remove-pin">Turn off</button>' : '<button class="btn primary" data-action="set-pin">Set a PIN</button>'}</div></div>
      <div class="card"><h3>Quick-add favorites</h3>
        ${S.templates.length ? `<div class="list">${S.templates.map((t) => `<div class="row"><div class="avatar" style="background:${catById(t.categoryId).color}22">${catById(t.categoryId).icon}</div><div class="grow"><div class="title">${esc(t.name)}</div><div class="sub">${esc(catById(t.categoryId).name)}</div></div><div class="amt num">${money(t.amount)}</div><button class="x link-btn" data-action="delete-template" data-id="${t.id}" aria-label="Delete favorite">✕</button></div>`).join('')}</div>`
          : '<p class="muted small" style="margin:0">When adding an expense, tick “Save as quick-add favorite” to log it with one tap from the dashboard.</p>'}</div>
      <div class="card"><h3>Your data</h3>
        <div class="grid" style="gap:10px">
          <button class="btn block" data-action="export-json">Export backup (.json)</button>
          <button class="btn block" data-action="import-json">Restore from backup</button>
          <button class="btn block" data-action="export-csv-all">Export all transactions (.csv)</button>
          ${!Cap.inArtifact ? '<button class="btn block" data-action="export-ics">Export renewals to calendar (.ics)</button>' : ''}
          <button class="btn block" data-action="load-demo">Load sample data to explore</button>
          <button class="btn block danger" data-action="reset">Erase everything</button></div>
        <input type="file" id="import-file" accept="application/json,.json" hidden />
        <div class="kv" style="margin-top:16px"><span>Transactions</span><span class="num">${S.expenses.length}</span></div>
        <div class="kv"><span>Income entries</span><span class="num">${S.income.length}</span></div>
        <div class="kv"><span>Tracking since</span><span>${fmtDate(firstDate(), { month: 'short', day: 'numeric', year: 'numeric' })}</span></div></div>
    </div></div>`;
}

// ======================= Modals =======================
function openModal(title, html) {
  if (UI.ask) { const r = UI.ask; UI.ask = null; r(false); }
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').hidden = false;
  const first = $('#modal-body [autofocus]');
  if (first && matchMedia('(pointer:fine)').matches) setTimeout(() => first.focus(), 50);
}
function closeModal() {
  if (UI.ask) { const r = UI.ask; UI.ask = null; r(false); }
  $('#modal').hidden = true; $('#modal-body').innerHTML = '';
}
/** In-page confirm (the artifact viewer blocks window.confirm). */
function ask(title, message, okLabel = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    openModal(title, `<p style="margin-top:0">${message}</p><div class="form-actions"><button class="btn" data-action="ask-no">Cancel</button><button class="btn ${danger ? 'danger-fill' : 'primary'}" data-action="ask-yes">${esc(okLabel)}</button></div>`);
    UI.ask = resolve;
  });
}
function catPicker(selected, name = 'categoryId') {
  return `<input type="hidden" name="${name}" value="${selected}" /><div class="cat-picker">${S.categories.map((c) =>
    `<button type="button" class="cat-opt ${c.id === selected ? 'sel' : ''}" data-action="pick-cat" data-id="${c.id}"><span class="e">${c.icon}</span>${esc(c.name)}</button>`).join('')}</div>`;
}
const catOptions = (sel) => S.categories.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('');
function emojiPicker(name, value) {
  return `<input class="input" name="${name}" value="${esc(value)}" maxlength="4" style="width:80px;text-align:center;font-size:20px" aria-label="Icon" />
    <div class="chips-scroll" style="margin-top:8px">${EMOJIS.map((e) => `<button type="button" class="chip" data-action="pick-emoji" data-name="${name}" data-v="${e}" style="font-size:18px">${e}</button>`).join('')}</div>`;
}

// ----- Expense form (category split, friend split, tags, favorites, receipt) -----
function expenseForm(e, opts = {}) {
  const isEdit = !!(e && e.id && S.expenses.some((x) => x.id === e.id));
  e = { amount: '', categoryId: (S.categories[0] || {}).id, note: '', date: today(), tags: [], method: '', ...(e || {}) };
  const refund = e.amount < 0;
  const hasParts = e.parts && e.parts.length > 1;
  const split = e.split || null;
  const shownAmount = split ? split.total : (e.amount ? Math.abs(e.amount) : '');
  const scan = opts.scan;
  const splitOpen = !!(split || opts.split);
  openModal(isEdit ? 'Edit transaction' : opts.title || 'Add expense', `
    <form data-form="expense" data-id="${isEdit ? e.id : ''}" data-scanned="${e.scanned ? 1 : ''}" data-cool="${esc(opts.coolId || '')}">
      ${!isEdit && !scan && Cap.images ? `<button type="button" class="btn block" style="margin-bottom:12px" data-action="scan-receipt">${ICONS.camera} Scan a receipt instead</button>` : ''}
      ${scan ? `<div class="sub-box"><b>📸 Read from your receipt</b>${scan.merchant ? ` · ${esc(scan.merchant)}` : ''}<div class="small muted">Check the details below, then save.</div>
        ${scan.items?.length ? `<details style="margin-top:6px"><summary class="small">${scan.items.length} line item${scan.items.length > 1 ? 's' : ''}</summary><div class="receipt-items">${scan.items.map((it) => `<div><span>${esc(it.name)}</span><span class="num">${money(it.price)}</span></div>`).join('')}</div></details>` : ''}</div>` : ''}
      ${!isEdit && S.templates.length && !scan ? `<div class="chips-scroll" style="margin-bottom:12px">${S.templates.map((t) => `<button type="button" class="chip fav-chip" data-action="fill-template" data-id="${t.id}">${catById(t.categoryId).icon} ${esc(t.name)} ${money(t.amount)}</button>`).join('')}</div>` : ''}
      <div style="display:flex;justify-content:center;margin-bottom:12px"><div class="seg">
        <button type="button" class="${refund ? '' : 'sel'}" data-action="seg" data-name="kind" data-v="expense">Expense</button>
        <button type="button" class="${refund ? 'sel' : ''}" data-action="seg" data-name="kind" data-v="refund">Refund / money back</button></div></div>
      <input type="hidden" name="kind" value="${refund ? 'refund' : 'expense'}" />
      <div class="field"><input class="input amount-input num" id="f-amount" name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" placeholder="0.00" value="${shownAmount}" required autofocus aria-label="Amount" /></div>
      <div id="single-cat" ${hasParts ? 'hidden' : ''}><div class="field"><label>Category</label>${catPicker(e.categoryId)}</div></div>
      <div id="parts-box" class="sub-box" ${hasParts ? '' : 'hidden'}>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px"><b>Split across categories</b><span class="small num" id="parts-left"></span></div>
        <div id="parts-rows">${(hasParts ? e.parts : [{ categoryId: e.categoryId, amount: '' }, { categoryId: (S.categories[1] || S.categories[0]).id, amount: '' }]).map(partRow).join('')}</div>
        <button type="button" class="link-btn" data-action="add-part">+ Add category</button></div>
      <button type="button" class="link-btn" data-action="toggle-parts" style="margin-bottom:10px">${hasParts ? 'Use one category' : 'Split across categories'}</button>
      <div class="row-2">
        <div class="field"><label for="f-note">Note</label><input class="input" id="f-note" name="note" placeholder="e.g. Starbucks" value="${esc(e.note)}" list="note-suggest" /></div>
        <div class="field"><label for="f-date">Date</label><input class="input" id="f-date" name="date" type="date" value="${e.date}" required /></div></div>
      <div class="row-2">
        <div class="field"><label for="f-method">Paid with</label><select class="input" id="f-method" name="method"><option value="">Not set</option>${METHODS.map((m) => `<option ${e.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div class="field"><label for="f-tags">Tags</label><input class="input" id="f-tags" name="tags" placeholder="#trip #work" value="${esc((e.tags || []).map((t) => '#' + t).join(' '))}" /></div></div>
      <datalist id="note-suggest">${[...new Set(S.expenses.map((x) => x.note).filter(Boolean))].slice(-50).map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <div id="split-box" class="sub-box" ${splitOpen ? '' : 'hidden'}>
        <b>Split with friends</b>
        <div class="small muted" style="margin:2px 0 8px">Enter the full bill above. Only your share counts toward your budget.</div>
        <div id="split-people" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">${S.people.map((p) => `<button type="button" class="chip ${split?.people.includes(p.id) ? 'sel' : ''}" data-action="split-person" data-id="${p.id}">${esc(p.name)}</button>`).join('')}
          <span id="new-person-wrap" style="display:inline-flex;gap:6px"><input class="input" id="new-person" placeholder="New friend" style="width:130px;padding:6px 10px" aria-label="New friend name"/><button type="button" class="btn sm" data-action="split-new-person">Add</button></span></div>
        <div class="row-2" style="margin-top:10px">
          <div class="field"><label for="f-paidby">Who paid?</label><select class="input" id="f-paidby" name="paidBy"></select></div>
          <div class="field"><label>How to split</label><div class="seg"><button type="button" class="${split?.mode === 'custom' ? '' : 'sel'}" data-action="seg" data-name="splitMode" data-v="equal">Equally</button><button type="button" class="${split?.mode === 'custom' ? 'sel' : ''}" data-action="seg" data-name="splitMode" data-v="custom">Custom</button></div></div></div>
        <input type="hidden" name="splitMode" value="${split?.mode || 'equal'}" />
        <div id="shares"></div>
        <div id="split-summary" class="small" style="font-weight:600"></div></div>
      ${splitOpen ? '' : `<button type="button" class="link-btn" data-action="toggle-split" style="margin-bottom:10px;margin-left:14px">Split with friends</button>`}
      ${!isEdit ? `<label class="toggle"><span>Save as quick-add favorite</span><input type="checkbox" name="saveTemplate" /></label>` : ''}
      <div class="form-actions">
        ${isEdit ? `<button type="button" class="btn danger" data-action="delete-expense" data-id="${e.id}">Delete</button><button type="button" class="btn" data-action="duplicate-expense" data-id="${e.id}">Duplicate</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn" data-action="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${isEdit ? 'Save' : 'Add expense'}</button></div>
    </form>`);
  const form = $('#modal-body form');
  form._split = split ? { people: [...split.people], shares: { ...split.shares }, paidBy: split.paidBy } : { people: [], shares: {}, paidBy: 'me' };
  form._scanItems = scan?.items || null;
  refreshSplitUI(form);
  refreshParts(form);
}
function partRow(p) {
  return `<div class="part-row"><select class="input" data-part="cat" aria-label="Category">${catOptions(p.categoryId)}</select>
    <input class="input num" data-part="amt" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00" value="${p.amount || ''}" aria-label="Amount" />
    <button type="button" class="icon-btn" data-action="remove-part" aria-label="Remove">✕</button></div>`;
}
function refreshParts(form) {
  const box = $('#parts-box', form);
  if (!box || box.hidden) return;
  const total = round2(form.elements.amount.value);
  const used = round2(sum($$('[data-part=amt]', form), (i) => i.value));
  const left = round2(total - used);
  $('#parts-left', form).innerHTML = left === 0 ? '<span class="good">All assigned ✓</span>' : left > 0 ? `${money(left)} left to assign` : `<span class="bad">${money(-left)} too much</span>`;
}
function splitSummaryHTML(form) {
  const sp = form._split;
  if (!sp.people.length) return '<span class="muted">Pick at least one friend.</span>';
  const { my, shares, total } = computeSplit(form);
  const each = form.elements.splitMode.value === 'equal' ? ` (${money(total / (sp.people.length + 1))} each)` : '';
  return `Your share: <span class="num">${money(my)}</span>${each} · ${sp.paidBy === 'me' ? `friends owe you ${money(sum(Object.values(shares)))}` : `you owe ${esc(personById(sp.paidBy).name)} ${money(my)}`}`;
}
function refreshSplitUI(form) {
  const box = $('#split-box', form);
  if (!box || box.hidden) return;
  const sp = form._split;
  if (sp.paidBy !== 'me' && !sp.people.includes(sp.paidBy)) sp.paidBy = 'me';
  const sel = form.elements.paidBy;
  sel.innerHTML = `<option value="me">Me</option>${sp.people.map((id) => `<option value="${id}">${esc(personById(id).name)}</option>`).join('')}`;
  sel.value = sp.paidBy;
  $('#shares', form).innerHTML = form.elements.splitMode.value === 'custom'
    ? sp.people.map((id) => `<div class="share-row"><span>${esc(personById(id).name)}'s share</span><input class="input num" data-share="${id}" type="number" step="0.01" min="0" inputmode="decimal" value="${sp.shares[id] ?? ''}" aria-label="${esc(personById(id).name)} share"/></div>`).join('')
    : '';
  $('#split-summary', form).innerHTML = splitSummaryHTML(form);
}
function computeSplit(form) {
  const sp = form._split;
  const total = round2(form.elements.amount.value);
  const shares = {};
  if (form.elements.splitMode.value === 'custom') for (const id of sp.people) shares[id] = round2(sp.shares[id]);
  else { const each = Math.floor((total / (sp.people.length + 1)) * 100) / 100; for (const id of sp.people) shares[id] = each; }
  return { my: round2(total - sum(Object.values(shares))), shares, total };
}

function incomeForm(i, recurring) {
  const isEdit = !!(i && i.id);
  i = { amount: '', name: '', type: 'gift', date: today(), addToBudget: false, cycle: 'monthly', nextDate: today(), autoLog: true, active: true, ...(i || {}) };
  openModal(isEdit ? (recurring ? 'Edit recurring income' : 'Edit income') : recurring ? 'New recurring income' : 'Add income', `
    <form data-form="${recurring ? 'recurring-income' : 'income'}" data-id="${isEdit ? i.id : ''}">
      <div class="field"><input class="input amount-input num" name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" placeholder="0.00" value="${i.amount}" required autofocus aria-label="Amount" /></div>
      <div class="row-2">
        <div class="field"><label for="i-name">From / description</label><input class="input" id="i-name" name="name" placeholder="Grandma, eBay, Tutoring…" value="${esc(i.name)}" list="inc-suggest" /></div>
        <div class="field"><label for="i-type">Type</label><select class="input" id="i-type" name="type">${INCOME_TYPES.map(([k, l]) => `<option value="${k}" ${i.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <datalist id="inc-suggest">${[...new Set(S.income.map((x) => x.name).filter(Boolean))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      ${recurring ? `<div class="row-2"><div class="field"><label for="i-cycle">Arrives</label><select class="input" id="i-cycle" name="cycle">${CYCLES.map(([k, l]) => `<option value="${k}" ${i.cycle === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="i-next">Next payment</label><input class="input" id="i-next" name="nextDate" type="date" value="${i.nextDate}" required /></div></div>
        <label class="toggle"><span><b>Log automatically</b><br><span class="small muted">Adds it to your income on each date.</span></span><input type="checkbox" name="autoLog" ${i.autoLog ? 'checked' : ''}/></label>
        <label class="toggle"><span><b>Active</b></span><input type="checkbox" name="active" ${i.active ? 'checked' : ''}/></label>`
        : `<div class="field"><label for="i-date">Date</label><input class="input" id="i-date" name="date" type="date" value="${i.date}" required /></div>`}
      <label class="toggle"><span><b>Add to that week's budget</b><br><span class="small muted">Gives you extra spending money for that week.</span></span><input type="checkbox" name="addToBudget" ${i.addToBudget ? 'checked' : ''}/></label>
      <div class="form-actions">${isEdit ? `<button type="button" class="btn danger" data-action="${recurring ? 'delete-recurring-income' : 'delete-income'}" data-id="${i.id}">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${isEdit ? 'Save' : 'Add'}</button></div>
    </form>`);
}

function categoryForm(c) {
  const isEdit = !!c;
  c = c || { name: '', icon: '📦', color: PALETTE[S.categories.length % PALETTE.length], limit: 0 };
  openModal(isEdit ? 'Edit category' : 'New category', `
    <form data-form="category" data-id="${c.id || ''}">
      <div class="field"><label for="c-name">Name</label><input class="input" id="c-name" name="name" value="${esc(c.name)}" required autofocus /></div>
      <div class="field"><label>Icon</label>${emojiPicker('icon', c.icon)}</div>
      <div class="field"><label>Color</label><input type="hidden" name="color" value="${c.color}" />
        <div class="swatches">${PALETTE.map((p) => `<button type="button" class="swatch ${p === c.color ? 'sel' : ''}" style="background:${p}" data-action="pick-color" data-v="${p}" aria-label="Color ${p}"></button>`).join('')}</div></div>
      <div class="field"><label for="c-limit">Weekly limit (optional)</label><input class="input num" id="c-limit" name="limit" type="number" step="0.01" min="0" inputmode="decimal" placeholder="No limit" value="${c.limit || ''}" />
        <span class="small muted">You'll get a reminder and a warning bar as you get close.</span></div>
      <div class="form-actions">${isEdit && S.categories.length > 1 ? `<button type="button" class="btn danger" data-action="delete-category" data-id="${c.id}">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${isEdit ? 'Save' : 'Create'}</button></div>
    </form>`);
}

function subForm(s) {
  const isEdit = !!s;
  s = s || { name: '', amount: '', cycle: 'monthly', nextDate: today(), categoryId: subsCat().id, active: true, autoLog: true, icon: '', trial: false };
  openModal(isEdit ? 'Edit subscription' : 'New subscription or bill', `
    <form data-form="sub" data-id="${s.id || ''}">
      <div class="field"><label for="s-name">Name</label><input class="input" id="s-name" name="name" placeholder="Netflix, Gym, Phone, Rent…" value="${esc(s.name)}" required autofocus /></div>
      <div class="row-2">
        <div class="field"><label for="s-amt">Amount</label><input class="input num" id="s-amt" name="amount" type="number" step="0.01" min="0" inputmode="decimal" value="${s.amount}" required /></div>
        <div class="field"><label for="s-cyc">Billed</label><select class="input" id="s-cyc" name="cycle">${CYCLES.map(([k, l]) => `<option value="${k}" ${s.cycle === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="row-2">
        <div class="field"><label for="s-next">Next payment</label><input class="input" id="s-next" name="nextDate" type="date" value="${s.nextDate || ''}" required /></div>
        <div class="field"><label for="s-cat">Category</label><select class="input" id="s-cat" name="categoryId">${catOptions(s.categoryId)}</select></div></div>
      <div class="field"><label>Icon (optional)</label>${emojiPicker('icon', s.icon || '')}</div>
      <label class="toggle"><span><b>This is a free trial</b><br><span class="small muted">"Next payment" is when the trial ends. You'll get a reminder to cancel in time.</span></span><input type="checkbox" name="trial" ${s.trial ? 'checked' : ''}/></label>
      <label class="toggle"><span><b>Auto-log payments</b><br><span class="small muted">Adds the charge to your spending on each due date.</span></span><input type="checkbox" name="autoLog" ${s.autoLog ? 'checked' : ''}/></label>
      <label class="toggle"><span><b>Active</b><br><span class="small muted">Turn off to pause or mark as cancelled.</span></span><input type="checkbox" name="active" ${s.active ? 'checked' : ''}/></label>
      <div class="form-actions">${isEdit ? `<button type="button" class="btn danger" data-action="delete-sub" data-id="${s.id}">Delete</button>
          <button type="button" class="btn" data-action="log-sub" data-id="${s.id}">Log payment now</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${isEdit ? 'Save' : 'Add'}</button></div>
    </form>`);
}

function goalForm(g) {
  const isEdit = !!(g && g.id);
  g = { name: '', price: '', saved: 0, targetDate: '', icon: '🎯', ...(g || {}) };
  openModal(isEdit ? 'Edit goal' : 'New goal', `
    <form data-form="goal" data-id="${isEdit ? g.id : ''}">
      <div class="field"><label for="g-name">What do you want?</label><input class="input" id="g-name" name="name" placeholder="New laptop, Vacation, Emergency fund…" value="${esc(g.name)}" required autofocus /></div>
      <div class="row-2">
        <div class="field"><label for="g-price">Cost</label><input class="input num" id="g-price" name="price" type="number" step="0.01" min="0.01" inputmode="decimal" value="${g.price || ''}" required /></div>
        <div class="field"><label for="g-date">Want it by (optional)</label><input class="input" id="g-date" name="targetDate" type="date" value="${g.targetDate || ''}" /></div></div>
      ${isEdit ? '' : `<div class="field"><label for="g-saved">Already saved (optional)</label><input class="input num" id="g-saved" name="saved" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00" /></div>`}
      <div class="field"><label>Icon</label>${emojiPicker('icon', g.icon || '🎯')}</div>
      <div class="form-actions">${isEdit ? `<button type="button" class="btn danger" data-action="delete-goal" data-id="${g.id}">Delete</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${isEdit ? 'Save' : 'Create goal'}</button></div>
    </form>`);
}

function contributeForm(g, withdraw) {
  const st = stats(), m = goalMath(g);
  const suggest = withdraw ? '' : (st.cw.left > 0 ? round2(st.cw.left) : '');
  openModal(withdraw ? `Withdraw from ${g.name}` : `Save toward ${g.name}`, `
    <form data-form="contribute" data-id="${g.id}" data-withdraw="${withdraw ? 1 : ''}">
      <div class="field"><input class="input amount-input num" name="amount" type="number" step="0.01" min="0.01" ${withdraw ? `max="${g.saved}"` : ''} inputmode="decimal" placeholder="0.00" value="${suggest}" required autofocus aria-label="Amount" /></div>
      ${withdraw ? `<p class="muted small">You have ${money(g.saved)} saved toward this goal.</p>` : `
      <div class="chips-scroll" style="margin-bottom:12px">
        ${m.perWeek ? `<button type="button" class="chip" data-action="fill-amount" data-v="${round2(m.perWeek)}">Weekly target ${money(m.perWeek)}</button>` : ''}
        ${st.cw.left > 0 ? `<button type="button" class="chip" data-action="fill-amount" data-v="${round2(st.cw.left)}">All of this week's leftover ${money(st.cw.left)}</button>` : ''}
        <button type="button" class="chip" data-action="fill-amount" data-v="${round2(m.remaining)}">Finish it ${money(m.remaining)}</button></div>
      <label class="toggle"><span><b>Take it from this week's budget</b><br><span class="small muted">Reduces what you have left to spend this week.</span></span><input type="checkbox" name="fromBudget" checked /></label>`}
      <div class="form-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${withdraw ? 'Withdraw' : 'Add savings'}</button></div>
    </form>`);
}

function coolingForm(prefill = {}) {
  openModal('Add to cooling-off list', `
    <form data-form="cooling">
      <p class="muted small" style="margin-top:0">Wait before you buy. When the timer runs out, decide if you still want it.</p>
      <div class="field"><label for="co-name">What do you want to buy?</label><input class="input" id="co-name" name="name" value="${esc(prefill.name || '')}" required autofocus /></div>
      <div class="row-2">
        <div class="field"><label for="co-price">Price</label><input class="input num" id="co-price" name="price" type="number" step="0.01" min="0.01" inputmode="decimal" value="${prefill.price || ''}" required /></div>
        <div class="field"><label for="co-wait">Wait for</label><select class="input" id="co-wait" name="hours">${COOL_OPTS.map(([h, l]) => `<option value="${h}" ${Number(S.settings.coolingHours) === h ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="field"><label for="co-cat">Category</label><select class="input" id="co-cat" name="categoryId">${catOptions(prefill.categoryId || (S.categories.find((c) => c.name === 'Shopping') || S.categories[0]).id)}</select></div>
      <div class="form-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Start the timer</button></div>
    </form>`);
}

function personForm() {
  openModal('Add a friend', `<form data-form="person"><div class="field"><label for="p-name">Name</label><input class="input" id="p-name" name="name" required autofocus /></div>
    <div class="form-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Add</button></div></form>`);
}
function iouForm(personId, kind) {
  const p = personById(personId);
  openModal(kind === 'lent' ? `You lent ${p.name} money` : `You borrowed from ${p.name}`, `
    <form data-form="iou" data-id="${personId}" data-kind="${kind}">
      <div class="field"><input class="input amount-input num" name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" placeholder="0.00" required autofocus aria-label="Amount" /></div>
      <div class="row-2"><div class="field"><label for="iou-note">What for?</label><input class="input" id="iou-note" name="note" placeholder="Concert tickets" /></div>
      <div class="field"><label for="iou-date">Date</label><input class="input" id="iou-date" name="date" type="date" value="${today()}" /></div></div>
      <p class="small muted">${kind === 'lent' ? "Lending isn't counted as spending, since you'll get it back." : "Borrowed money isn't counted as income."}</p>
      <div class="form-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`);
}

function affordModal() {
  openModal('Can I afford it?', `
    <div class="field"><input class="input amount-input num" id="afford-price" type="number" step="0.01" min="0" inputmode="decimal" placeholder="Price" data-input="afford" autofocus aria-label="Price" /></div>
    <div id="afford-out" class="muted">Type a price to see how it fits your budget and goals.</div>`);
}
function affordHTML(price) {
  if (!price) return '<span class="muted">Type a price to see how it fits your budget and goals.</span>';
  const st = stats();
  const left = st.cw.left, after = round2(left - price);
  const usual = Math.max(0, st.cw.budget - st.avgWeek);
  let html = '';
  if (after >= 0) html += `<div class="big-answer good">Yes, it fits this week.</div><div>You'd have <b>${money(after)}</b> left${st.daysLeft > 1 ? `, or ${money(after / st.daysLeft)}/day for ${st.daysLeft} days` : ''}.</div>`;
  else {
    html += `<div class="big-answer bad">Not this week.</div><div>It would put you <b>${money(-after)}</b> over budget.</div>`;
    if (usual > 0) { const weeks = Math.ceil((price - Math.max(0, left)) / usual); html += `<div style="margin-top:6px">If you save your usual leftover (${money(usual)}/wk), you could buy it in about <b>${weeks} week${weeks > 1 ? 's' : ''}</b> (${fmtDate(addDays(today(), weeks * 7), { month: 'short', day: 'numeric' })}).</div>`; }
  }
  html += `<div class="kv" style="margin-top:10px"><span>Share of your weekly budget</span><b>${st.cw.budget ? Math.round((price / st.cw.budget) * 100) : 0}%</b></div>`;
  for (const g of S.goals) {
    if (g.saved >= g.price) continue;
    const m = goalMath(g);
    if (m.rate > 0) html += `<div class="kv"><span>Pushes back ${esc(g.name)}</span><b>~${Math.ceil((price / m.rate) * 7)} days</b></div>`;
  }
  html += `<div class="form-actions" style="margin-top:14px"><button class="btn" data-action="afford-cool">Cooling-off list</button><button class="btn" data-action="afford-goal">Make it a goal</button><button class="btn primary" data-action="afford-buy">Log it</button></div>`;
  return html;
}

function onboarding() {
  openModal('Welcome to Pocketwise 👋', `
    <form data-form="onboard">
      <p class="muted" style="margin-top:0">Set a weekly spending amount. Everything you log is measured against it, and the week resets automatically.${Sync.db ? ' Your data syncs privately to your Claude account.' : ''}</p>
      <div class="field"><label for="o-budget">How much can you spend each week?</label><input class="input amount-input num" id="o-budget" name="weeklyBudget" type="number" step="0.01" min="1" inputmode="decimal" placeholder="300" required autofocus /></div>
      <div class="row-2">
        <div class="field"><label for="o-ws">Week starts on</label><select class="input" id="o-ws" name="weekStart">${[...Array(7)].map((_, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'long' })}</option>`).join('')}</select></div>
        <div class="field"><label for="o-cur">Currency</label><select class="input" id="o-cur" name="currency">${CURRENCIES.map((c) => `<option ${c === 'USD' ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>
      <div class="form-actions"><button type="button" class="btn" data-action="load-demo">Explore with sample data</button><button class="btn primary" type="submit">Start budgeting</button></div>
    </form>`);
}
function remindersModal() {
  const r = reminders();
  openModal('Reminders', `${r.length ? r.map(reminderHTML).join('') : emptyState('🔕', "You're all caught up.")}
    <p class="small muted">Change when bill reminders appear in Settings.</p>`);
}
function setWeeklyBudget(amount) {
  const ws = weekStartOf(today());
  S.settings.weeklyBudget = amount;
  S.budgetHistory = S.budgetHistory.filter((h) => h.from !== ws);
  const prev = budgetFor(ws);
  if (!S.budgetHistory.length || prev !== amount) S.budgetHistory.push({ from: S.budgetHistory.length ? ws : weekStartOf(firstDate()), amount });
}

// ======================= Receipt scanning =======================
function pickReceipt() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => { if (inp.files[0]) scanReceipt(inp.files[0]); };
  inp.click();
}
async function scanReceipt(file) {
  openModal('Reading your receipt…', `<div style="text-align:center;padding:20px"><div class="spinner"></div><p class="muted">Finding the total, store, date and items. This can take up to a minute.</p></div>`);
  const cats = S.categories.map((c) => c.name);
  const prompt = `This image is a photo of a shopping receipt. Extract its details.
Categories to choose from: ${JSON.stringify(cats)}.
Reply with ONLY a JSON object, no other text:
{"merchant": string or null, "date": "YYYY-MM-DD" or null, "total": number (the final amount paid, including tax and tip), "category": one of the categories, "items": [{"name": string, "price": number, "category": one of the categories}]}
If the image is not a receipt, reply {"error": "not a receipt"}.`;
  try {
    const r = await Cap.sample.json(prompt, { images: [file], modelTier: 'default' });
    if (!r || r.error || !(Number(r.total) > 0)) throw { code: 'unreadable' };
    const findCat = (name) => (S.categories.find((c) => c.name.toLowerCase() === String(name || '').toLowerCase()) || otherCat()).id;
    const items = Array.isArray(r.items) ? r.items.filter((it) => it && it.name && Number(it.price)).map((it) => ({ name: String(it.name).slice(0, 60), price: round2(it.price), categoryId: findCat(it.category) })) : [];
    const e = { amount: round2(r.total), note: r.merchant ? String(r.merchant).slice(0, 60) : '', date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') && r.date <= today() ? r.date : today(), categoryId: findCat(r.category), scanned: true, tags: [] };
    // If the items span several categories, pre-fill a category split (tax spread proportionally).
    const byCat = {};
    for (const it of items) byCat[it.categoryId] = (byCat[it.categoryId] || 0) + it.price;
    const itemSum = sum(Object.values(byCat));
    if (Object.keys(byCat).length > 1 && itemSum > 0) {
      const ratio = e.amount / itemSum;
      e.parts = Object.entries(byCat).map(([categoryId, v]) => ({ categoryId, amount: round2(v * ratio) }));
      const diff = round2(e.amount - sum(e.parts, (p) => p.amount));
      e.parts[0].amount = round2(e.parts[0].amount + diff);
    }
    expenseForm(e, { scan: { merchant: e.note, items }, title: 'Check scanned expense' });
  } catch (err) {
    const msg = {
      not_granted: 'Receipt scanning needs permission to use Claude. You can still add the expense by hand.',
      rate_limited: "You've hit a usage limit for now. Try again later, or add it by hand.",
      image_rejected: "That image couldn't be read. Try a clearer photo (JPEG or PNG).",
      unreadable: "Couldn't find a total on that image. Try a clearer, flatter photo.",
      invalid_json: "Couldn't make sense of that receipt. Try a clearer photo.",
    }[err?.code] || 'Something went wrong reading the receipt. Try again, or add it by hand.';
    openModal("Couldn't scan that receipt", `<p>${msg}</p><div class="form-actions"><button class="btn" data-action="scan-receipt">Try another photo</button><button class="btn primary" data-action="add-expense">Add by hand</button></div>`);
  }
}

// ======================= Form submit =======================
function formData(form) {
  const o = {};
  for (const el of form.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
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
      setWeeklyBudget(round2(d.weeklyBudget));
      toast("You're all set! Tap + to log your first expense.");
      break;
    }
    case 'expense': if (!saveExpense(form, d, id)) return; break;
    case 'income': {
      const v = { amount: round2(d.amount), name: d.name.trim(), type: d.type, date: d.date, addToBudget: d.addToBudget };
      if (id) Object.assign(S.income.find((x) => x.id === id), v);
      else S.income.push({ id: uid(), ...v, createdAt: Date.now() });
      toast(id ? 'Income updated' : `+${money(v.amount)} income logged`);
      break;
    }
    case 'recurring-income': {
      const v = { amount: round2(d.amount), name: d.name.trim() || 'Income', type: d.type, cycle: d.cycle, nextDate: d.nextDate, anchorDay: parse(d.nextDate).getDate(), autoLog: d.autoLog, active: d.active, addToBudget: d.addToBudget };
      if (id) Object.assign(S.recurringIncome.find((x) => x.id === id), v);
      else S.recurringIncome.push({ id: uid(), ...v });
      processRecurring();
      break;
    }
    case 'category': {
      const v = { name: d.name.trim(), icon: d.icon || '📦', color: d.color, limit: round2(d.limit) };
      if (id) Object.assign(S.categories.find((c) => c.id === id), v);
      else S.categories.push({ id: uid(), ...v });
      break;
    }
    case 'sub': {
      const v = { name: d.name.trim(), amount: round2(d.amount), cycle: d.cycle, nextDate: d.nextDate, categoryId: d.categoryId, autoLog: d.autoLog, active: d.active, icon: d.icon, trial: d.trial, anchorDay: parse(d.nextDate).getDate() };
      if (id) Object.assign(S.subscriptions.find((s) => s.id === id), v);
      else S.subscriptions.push({ id: uid(), ...v });
      processRecurring();
      break;
    }
    case 'goal': {
      const v = { name: d.name.trim(), price: round2(d.price), targetDate: d.targetDate || '', icon: d.icon || '🎯' };
      if (id) Object.assign(S.goals.find((g) => g.id === id), v);
      else { const saved = round2(d.saved); S.goals.push({ id: uid(), ...v, saved, contributions: saved ? [{ date: today(), amount: saved, fromBudget: false }] : [] }); }
      if (UI.pendingCool) { const c = S.cooling.find((x) => x.id === UI.pendingCool); if (c) { c.status = 'skipped'; c.decidedAt = Date.now(); } UI.pendingCool = null; }
      break;
    }
    case 'contribute': {
      const g = S.goals.find((x) => x.id === id);
      let amt = round2(d.amount);
      if (form.dataset.withdraw) amt = -Math.min(amt, g.saved);
      g.saved = round2(g.saved + amt);
      (g.contributions = g.contributions || []).push({ date: today(), amount: amt, fromBudget: !!d.fromBudget });
      toast(g.saved >= g.price ? `🎉 ${g.name} is fully funded!` : amt > 0 ? `${money(amt)} saved toward ${g.name}` : `Withdrew ${money(-amt)}`);
      break;
    }
    case 'cooling': {
      const now = Date.now();
      S.cooling.push({ id: uid(), name: d.name.trim(), price: round2(d.price), categoryId: d.categoryId, addedAt: now, until: now + Number(d.hours) * 36e5, status: 'waiting' });
      toast("Timer started. You'll get a reminder when it's time to decide.");
      UI.goalsTab = 'cooling';
      break;
    }
    case 'person': S.people.push({ id: uid(), name: d.name.trim(), color: PALETTE[S.people.length % PALETTE.length] }); break;
    case 'iou': {
      const amt = round2(d.amount);
      S.ious.push({ id: uid(), personId: id, amount: form.dataset.kind === 'lent' ? amt : -amt, date: d.date || today(), note: d.note.trim(), type: form.dataset.kind });
      save(); render(); personModal(id);
      return;
    }
    case 'pin': {
      if (!/^\d{4}$/.test(d.pin)) { toast('Use exactly 4 digits'); return; }
      if (d.pin !== d.pin2) { toast("The PINs don't match"); return; }
      hashPin(d.pin).then((h) => { DEV.pinHash = h; DEV.lastActive = Date.now(); saveDev(); toast('PIN lock is on for this device'); closeModal(); render(); });
      return;
    }
    case 'settings': {
      const amt = round2(d.weeklyBudget);
      if (amt !== budgetFor(weekStartOf(today())) || !S.budgetHistory.length) setWeeklyBudget(amt);
      Object.assign(S.settings, { weeklyBudget: amt, weekStart: Number(d.weekStart), currency: d.currency, rollover: d.rollover, theme: d.theme, reminderDays: Number(d.reminderDays), coolingHours: Number(d.coolingHours), logReminder: d.logReminder });
      applyTheme();
      toast('Settings saved');
      break;
    }
  }
  save();
  closeModal();
  render();
}

function saveExpense(form, d, id) {
  const refund = d.kind === 'refund';
  const total = round2(d.amount);
  const partsOn = !$('#parts-box', form).hidden && !refund;
  const splitOn = !$('#split-box', form).hidden && form._split.people.length > 0 && !refund;
  let amount = total, partsArr = null, split = null;
  if (partsOn) {
    const merged = {};
    for (const r of $$('.part-row', form)) {
      const amt = round2($('[data-part=amt]', r).value);
      if (amt > 0) { const cid = $('[data-part=cat]', r).value; merged[cid] = round2((merged[cid] || 0) + amt); }
    }
    partsArr = Object.entries(merged).map(([categoryId, amt]) => ({ categoryId, amount: amt }));
    const used = round2(sum(partsArr, (p) => p.amount));
    if (!partsArr.length) { toast('Enter an amount for at least one category'); return false; }
    if (used !== total) { toast(`Category amounts add up to ${money(used)}, not ${money(total)}`); return false; }
    if (partsArr.length === 1) { d.categoryId = partsArr[0].categoryId; partsArr = null; }
  }
  if (splitOn) {
    const { my, shares } = computeSplit(form);
    if (my < 0) { toast("Friends' shares are more than the total"); return false; }
    split = { total, paidBy: form._split.paidBy, people: [...form._split.people], shares, mode: d.splitMode };
    amount = my;
  }
  const sorted = partsArr ? [...partsArr].sort((a, b) => b.amount - a.amount) : null;
  const v = {
    amount: refund ? -total : amount,
    categoryId: sorted ? sorted[0].categoryId : d.categoryId,
    note: d.note.trim(), date: d.date, method: d.method, tags: parseTags(d.tags),
  };
  if (partsArr) v.parts = partsArr;
  if (split) v.split = split;
  if (form.dataset.scanned) { v.scanned = true; if (form._scanItems) v.items = form._scanItems.map(({ name, price }) => ({ name, price })); }
  let e;
  if (id) { e = S.expenses.find((x) => x.id === id); delete e.parts; delete e.split; Object.assign(e, v); }
  else { e = { id: uid(), ...v, createdAt: Date.now() }; S.expenses.push(e); }
  // Rebuild IOUs that belong to this expense.
  S.ious = S.ious.filter((x) => x.expenseId !== e.id);
  if (split) {
    const label = e.note || catById(e.categoryId).name;
    if (split.paidBy === 'me') { for (const [pid, amt] of Object.entries(split.shares)) if (amt > 0) S.ious.push({ id: uid(), personId: pid, amount: amt, date: e.date, note: label, type: 'split', expenseId: e.id }); }
    else S.ious.push({ id: uid(), personId: split.paidBy, amount: -amount, date: e.date, note: label, type: 'split', expenseId: e.id });
  }
  if (d.saveTemplate && !refund && !split) S.templates.push({ id: uid(), name: e.note || catById(e.categoryId).name, amount: total, categoryId: e.categoryId, method: e.method });
  if (form.dataset.cool) { const c = S.cooling.find((x) => x.id === form.dataset.cool); if (c) { c.status = 'bought'; c.decidedAt = Date.now(); } }
  if (e.amount > 0) S.noSpendMarks = S.noSpendMarks.filter((x) => x !== e.date);
  if (!id) {
    const cw = stats().cw;
    const wk = catSpend(cw.start, cw.end);
    const over = parts(e).map((p) => catById(p.categoryId)).find((c) => c.limit && (wk[c.id] || 0) > c.limit);
    if (over && inRange(d.date, cw.start, cw.end)) toast(`Heads up: ${over.name} is over its weekly limit`);
    else toast(cw.left >= 0 ? `Saved · ${money(cw.left)} left this week` : `Saved · ${money(-cw.left)} over this week`);
  } else toast('Transaction updated');
  return true;
}

// ======================= Clicks =======================
async function onClick(ev) {
  const el = ev.target.closest('[data-action]');
  if (!el) { if (ev.target.id === 'modal') closeModal(); return; }
  const { action, id } = el.dataset;
  const form = el.closest('form');
  switch (action) {
    case 'add-expense': return expenseForm(id ? { date: id } : null);
    case 'edit-expense': return expenseForm(S.expenses.find((e) => e.id === id));
    case 'duplicate-expense': {
      const src = JSON.parse(JSON.stringify(S.expenses.find((e) => e.id === id)));
      delete src.id; delete src.createdAt; delete src.subId;
      return expenseForm({ ...src, date: today() }, { title: 'Duplicate expense' });
    }
    case 'delete-expense': {
      const i = S.expenses.findIndex((e) => e.id === id);
      const item = S.expenses[i];
      const ious = S.ious.filter((x) => x.expenseId === id);
      S.expenses.splice(i, 1);
      S.ious = S.ious.filter((x) => x.expenseId !== id);
      UI.undo = () => { S.expenses.push(item); S.ious.push(...ious); };
      save(); closeModal(); render();
      return toast('Transaction deleted', 'Undo');
    }
    case 'undo': { if (UI.undo) UI.undo(); UI.undo = null; save(); render(); hideToast(); return; }
    case 'close-modal': return closeModal();
    case 'ask-yes': case 'ask-no': { const r = UI.ask; UI.ask = null; $('#modal').hidden = true; if (r) r(action === 'ask-yes'); return; }
    case 'toggle-theme': { S.settings.theme = isDark() ? 'light' : 'dark'; save(); applyTheme(); renderTopActions(); return; }
    case 'pick-cat': {
      form.elements.categoryId.value = id;
      $$('.cat-opt', form).forEach((b) => b.classList.toggle('sel', b === el));
      return;
    }
    case 'pick-emoji': { form.elements[el.dataset.name].value = el.dataset.v; return; }
    case 'pick-color': { form.elements.color.value = el.dataset.v; $$('.swatch', form).forEach((b) => b.classList.toggle('sel', b === el)); return; }
    case 'seg': {
      form.elements[el.dataset.name].value = el.dataset.v;
      el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b === el));
      if (el.dataset.name === 'splitMode') refreshSplitUI(form);
      return;
    }
    case 'fill-amount': { form.elements.amount.value = el.dataset.v; return; }
    case 'fill-template': {
      const t = S.templates.find((x) => x.id === id);
      form.elements.amount.value = t.amount; form.elements.note.value = t.name; form.elements.method.value = t.method || '';
      form.elements.categoryId.value = t.categoryId;
      $$('.cat-opt', form).forEach((b) => b.classList.toggle('sel', b.dataset.id === t.categoryId));
      return;
    }
    case 'use-template': {
      const t = S.templates.find((x) => x.id === id);
      const e = { id: uid(), amount: t.amount, categoryId: t.categoryId, note: t.name, date: today(), method: t.method || '', tags: [], createdAt: Date.now() };
      S.expenses.push(e);
      S.noSpendMarks = S.noSpendMarks.filter((x) => x !== today());
      UI.undo = () => { S.expenses = S.expenses.filter((x) => x.id !== e.id); };
      save(); render();
      return toast(`${t.name} ${money(t.amount)} logged · ${money(stats().cw.left)} left`, 'Undo');
    }
    case 'delete-template': { S.templates = S.templates.filter((t) => t.id !== id); save(); return render(); }
    case 'toggle-parts': {
      const box = $('#parts-box', form), single = $('#single-cat', form);
      box.hidden = !box.hidden; single.hidden = !box.hidden;
      el.textContent = box.hidden ? 'Split across categories' : 'Use one category';
      if (!box.hidden) {
        const first = $('[data-part=cat]', form);
        if (first) first.value = form.elements.categoryId.value;
        const amt = $('[data-part=amt]', form);
        if (amt && !amt.value) amt.value = form.elements.amount.value;
      }
      return refreshParts(form);
    }
    case 'add-part': { $('#parts-rows', form).insertAdjacentHTML('beforeend', partRow({ categoryId: S.categories[0].id, amount: '' })); return refreshParts(form); }
    case 'remove-part': { if ($$('.part-row', form).length > 1) el.closest('.part-row').remove(); return refreshParts(form); }
    case 'toggle-split': { $('#split-box', form).hidden = false; el.remove(); return refreshSplitUI(form); }
    case 'split-person': {
      const sp = form._split;
      sp.people = sp.people.includes(id) ? sp.people.filter((x) => x !== id) : [...sp.people, id];
      el.classList.toggle('sel', sp.people.includes(id));
      return refreshSplitUI(form);
    }
    case 'split-new-person': {
      const inp = $('#new-person', form);
      const name = inp.value.trim();
      if (!name) return;
      const p = { id: uid(), name, color: PALETTE[S.people.length % PALETTE.length] };
      S.people.push(p); save();
      form._split.people.push(p.id);
      $('#new-person-wrap', form).insertAdjacentHTML('beforebegin', `<button type="button" class="chip sel" data-action="split-person" data-id="${p.id}">${esc(name)}</button>`);
      inp.value = '';
      return refreshSplitUI(form);
    }
    case 'split-bill': return expenseForm(null, { split: true, title: 'Split a bill' });
    case 'act-cat': { UI.actFilter.cat = id; return render(); }
    case 'act-tag': { UI.actFilter.tag = UI.actFilter.tag === id ? '' : id; return render(); }
    case 'cal-nav': {
      const cur = UI.calMonth || today().slice(0, 7);
      UI.calMonth = id === '0' ? today().slice(0, 7) : addMonths(cur + '-01', Number(id)).slice(0, 7);
      return render();
    }
    case 'cal-day': return dayModal(id);
    case 'add-category': return categoryForm();
    case 'edit-category': return categoryForm(S.categories.find((c) => c.id === id));
    case 'delete-category': {
      const c = S.categories.find((x) => x.id === id);
      const n = S.expenses.filter((e) => parts(e).some((p) => p.categoryId === id)).length;
      const fallback = S.categories.find((x) => x.id !== id && x.name === 'Other') || S.categories.find((x) => x.id !== id);
      if (!(await ask(`Delete “${c.name}”?`, n ? `Its ${n} transaction(s) will move to “${esc(fallback.name)}”.` : 'This category has no transactions.', 'Delete'))) return;
      for (const e of S.expenses) { if (e.categoryId === id) e.categoryId = fallback.id; if (e.parts) e.parts.forEach((p) => { if (p.categoryId === id) p.categoryId = fallback.id; }); }
      for (const s of S.subscriptions) if (s.categoryId === id) s.categoryId = fallback.id;
      for (const t of S.templates) if (t.categoryId === id) t.categoryId = fallback.id;
      for (const c2 of S.cooling) if (c2.categoryId === id) c2.categoryId = fallback.id;
      S.categories = S.categories.filter((x) => x.id !== id);
      save(); render();
      return toast('Category deleted');
    }
    case 'add-sub': return subForm();
    case 'edit-sub': return subForm(S.subscriptions.find((s) => s.id === id));
    case 'delete-sub': {
      if (!(await ask('Delete this subscription?', 'Past payments stay in your history.', 'Delete'))) return;
      S.subscriptions = S.subscriptions.filter((s) => s.id !== id);
      save(); render(); return;
    }
    case 'log-sub': {
      const s = S.subscriptions.find((x) => x.id === id);
      logSubCharge(s, today());
      if (s.nextDate && s.nextDate <= addDays(today(), 7)) { s.trial = false; advanceSub(s); }
      save(); closeModal(); render();
      return toast(`Logged ${money(s.amount)} for ${s.name}`);
    }
    case 'add-income': return incomeForm(id ? { date: id } : null, false);
    case 'edit-income': return incomeForm(S.income.find((x) => x.id === id), false);
    case 'delete-income': { S.income = S.income.filter((x) => x.id !== id); save(); closeModal(); render(); return toast('Income deleted'); }
    case 'add-recurring-income': return incomeForm(null, true);
    case 'edit-recurring-income': return incomeForm(S.recurringIncome.find((x) => x.id === id), true);
    case 'delete-recurring-income': {
      if (!(await ask('Delete this recurring income?', 'Payments already logged stay in your history.', 'Delete'))) return;
      S.recurringIncome = S.recurringIncome.filter((x) => x.id !== id); save(); render(); return;
    }
    case 'add-goal': return goalForm();
    case 'edit-goal': return goalForm(S.goals.find((g) => g.id === id));
    case 'delete-goal': {
      if (!(await ask('Delete this goal?', 'Its savings history will be removed too.', 'Delete'))) return;
      S.goals = S.goals.filter((g) => g.id !== id); save(); render(); return;
    }
    case 'contribute-goal': return contributeForm(S.goals.find((g) => g.id === id), false);
    case 'withdraw-goal': return contributeForm(S.goals.find((g) => g.id === id), true);
    case 'goals-tab': { UI.goalsTab = id; return render(); }
    case 'goto-cooling': { closeModal(); UI.goalsTab = 'cooling'; if (location.hash !== '#goals') location.hash = 'goals'; else render(); return; }
    case 'add-cooling': return coolingForm();
    case 'cool-skip': {
      const c = S.cooling.find((x) => x.id === id);
      c.status = 'skipped'; c.decidedAt = Date.now();
      save(); render();
      return toast(`Nice. ${money(c.price)} not spent.`);
    }
    case 'cool-buy': {
      const c = S.cooling.find((x) => x.id === id);
      return expenseForm({ amount: c.price, note: c.name, categoryId: c.categoryId }, { coolId: c.id, title: `Buy ${c.name}` });
    }
    case 'cool-goal': {
      const c = S.cooling.find((x) => x.id === id);
      UI.pendingCool = c.id;
      return goalForm({ name: c.name, price: c.price });
    }
    case 'cool-delete': { S.cooling = S.cooling.filter((x) => x.id !== id); save(); return render(); }
    case 'add-person': return personForm();
    case 'open-person': return personModal(id);
    case 'iou-add': return iouForm(id, el.dataset.kind);
    case 'iou-delete': { const x = S.ious.find((i) => i.id === id); S.ious = S.ious.filter((i) => i.id !== id); save(); render(); return personModal(x.personId); }
    case 'settle': {
      const b = iouBalance(id), p = personById(id);
      if (!(await ask(`Settle up with ${p.name}?`, b > 0 ? `Record that ${esc(p.name)} paid you back ${money(b)}.` : `Record that you paid ${esc(p.name)} back ${money(-b)}.`, 'Settle up', false))) return personModal(id);
      S.ious.push({ id: uid(), personId: id, amount: -b, date: today(), note: 'Settled up', type: 'settle' });
      save(); render(); personModal(id);
      return toast('All square 🤝');
    }
    case 'delete-person': {
      const p = personById(id);
      if (iouBalance(id) !== 0) { toast(`Settle up with ${p.name} first`); return; }
      if (!(await ask(`Remove ${p.name}?`, 'Their history will be removed. Split expenses keep your share.', 'Remove'))) return personModal(id);
      S.people = S.people.filter((x) => x.id !== id);
      S.ious = S.ious.filter((x) => x.personId !== id);
      save(); render(); return;
    }
    case 'no-spend': {
      const t = today();
      if (S.noSpendMarks.includes(t)) S.noSpendMarks = S.noSpendMarks.filter((x) => x !== t);
      else { S.noSpendMarks.push(t); toast('No-spend day logged 🧘'); }
      save(); closeModal(); render(); return;
    }
    case 'afford': return affordModal();
    case 'afford-buy': case 'afford-cool': case 'afford-goal': {
      const price = round2($('#afford-price').value);
      if (action === 'afford-buy') return expenseForm({ amount: price });
      if (action === 'afford-cool') return coolingForm({ price });
      return goalForm({ price });
    }
    case 'scan-receipt': {
      if (!Cap.images) return toast('Receipt scanning works when you open the app from your Claude link');
      return pickReceipt();
    }
    case 'open-reminders': return remindersModal();
    case 'dismiss-reminder': {
      DEV.dismissed = DEV.dismissed || {};
      DEV.dismissed[el.dataset.key] = today();
      for (const [k, d] of Object.entries(DEV.dismissed)) if (daysBetween(d, today()) > 60) delete DEV.dismissed[k];
      saveDev();
      el.closest('.reminder').remove();
      if ($('#modal').hidden) render(); else renderTopActions();
      return;
    }
    case 'set-pin': return openModal('Set a PIN', `<form data-form="pin"><p class="muted small" style="margin-top:0">This PIN locks the app on this device only. If you forget it, clear this site's data in your browser to remove it. Your synced data stays safe in your account.</p>
      <div class="row-2"><div class="field"><label for="pin1">New PIN</label><input class="input num" id="pin1" name="pin" type="password" inputmode="numeric" maxlength="4" required autofocus /></div>
      <div class="field"><label for="pin2">Repeat PIN</label><input class="input num" id="pin2" name="pin2" type="password" inputmode="numeric" maxlength="4" required /></div></div>
      <div class="form-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Turn on PIN lock</button></div></form>`);
    case 'remove-pin': { delete DEV.pinHash; saveDev(); render(); return toast('PIN lock is off'); }
    case 'pin-key': return pinKey(el.dataset.v);
    case 'export-json': { await saveFile(`pocketwise-backup-${today()}.json`, JSON.stringify(S, null, 2), 'application/json'); DEV.lastBackup = today(); saveDev(); return; }
    case 'import-json': return $('#import-file').click();
    case 'export-csv': return exportCSV(filteredExpenses());
    case 'export-csv-all': return exportCSV([...S.expenses].sort((a, b) => b.date.localeCompare(a.date)));
    case 'export-ics': return saveFile('pocketwise-renewals.ics', buildICS(), 'text/calendar');
    case 'load-demo': {
      if (S.expenses.length && !(await ask('Load sample data?', 'This replaces your current data with made-up sample data. Export a backup first if you want to keep it.', 'Replace with sample'))) return;
      S = demoData(); save(); applyTheme(); closeModal(); render();
      return toast('Sample data loaded. Erase it anytime in Settings.');
    }
    case 'reset': {
      if (!(await ask('Erase everything?', `This deletes all your data${Sync.db ? ' on every device' : ''}. It can't be undone. Export a backup first if you're unsure.`, 'Erase everything'))) return;
      S = freshState(); save(); render(); onboarding();
      return;
    }
  }
}

function onInput(ev) {
  const t = ev.target;
  if (t.dataset.input === 'act-q') {
    UI.actFilter.q = t.value;
    const list = filteredExpenses();
    $('#act-list').innerHTML = activityList(list);
    $('#view-sub').textContent = activitySub(list);
    return;
  }
  if (t.dataset.input === 'afford') { $('#afford-out').innerHTML = affordHTML(round2(t.value)); return; }
  const form = t.closest('form[data-form=expense]');
  if (form) {
    if (t.dataset.share) form._split.shares[t.dataset.share] = t.value;
    const summary = $('#split-summary', form);
    if (summary && !$('#split-box', form).hidden) summary.innerHTML = splitSummaryHTML(form);
    refreshParts(form);
  }
}
function onChange(ev) {
  const t = ev.target;
  const k = t.dataset.change;
  if (k === 'act-period') { UI.actFilter.period = t.value; render(); }
  if (k === 'cat-range') { UI.catRange = t.value; render(); }
  if (k === 'report-key') { UI.reportKey = t.value; render(); }
  if (t.name === 'paidBy') { const form = t.closest('form'); form._split.paidBy = t.value; refreshSplitUI(form); }
  if (t.id === 'import-file' && t.files[0]) {
    const r = new FileReader();
    r.onload = async () => {
      try {
        const data = JSON.parse(r.result);
        if (!data || !Array.isArray(data.expenses) || !data.settings) throw new Error('bad file');
        if (!(await ask('Restore this backup?', `It has ${data.expenses.length} transactions. Your current data will be replaced${Sync.db ? ' on every device' : ''}.`, 'Restore', false))) return;
        S = normalize(data); save(); applyTheme(); render(); toast('Backup restored');
      } catch { toast("That file isn't a valid Pocketwise backup"); }
    };
    r.readAsText(t.files[0]);
    t.value = '';
  }
}

// ======================= PIN lock =======================
async function hashPin(pin) {
  const data = new TextEncoder().encode('pocketwise:' + pin);
  try { const buf = await crypto.subtle.digest('SHA-256', data); return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
  catch { let h = 0; for (const b of data) h = (h * 31 + b) | 0; return 'x' + h; }
}
let pinBuf = '';
function showLock() {
  if (!DEV.pinHash || $('#lock')) return;
  pinBuf = '';
  document.body.insertAdjacentHTML('beforeend', `<div class="lock" id="lock"><div class="lock-box">
    <img src="${document.querySelector('.brand img')?.getAttribute('src') || ''}" alt="" width="56" height="56" style="border-radius:16px" />
    <h2 style="margin:12px 0 0">Enter your PIN</h2><div class="pin-dots" id="pin-dots">${'<i></i>'.repeat(4)}</div>
    <div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k) => k === '' ? '<span></span>' : `<button data-action="pin-key" data-v="${k}" aria-label="${k === '⌫' ? 'Delete' : k}">${k}</button>`).join('')}</div></div></div>`);
}
async function pinKey(k) {
  if (k === '⌫') pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 4) pinBuf += k;
  $$('#pin-dots i').forEach((d, i) => d.classList.toggle('on', i < pinBuf.length));
  if (pinBuf.length === 4) {
    if ((await hashPin(pinBuf)) === DEV.pinHash) { $('#lock').remove(); DEV.lastActive = Date.now(); saveDev(); }
    else { const dots = $('#pin-dots'); dots.classList.add('shake'); setTimeout(() => { dots.classList.remove('shake'); pinBuf = ''; $$('#pin-dots i').forEach((d) => d.classList.remove('on')); }, 400); }
  }
}

// ======================= Utilities =======================
let toastTimer;
function toast(msg, actionLabel) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button data-action="undo">${esc(actionLabel)}</button>` : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 5000 : 2800);
}
function hideToast() { $('#toast').hidden = true; }

async function saveFile(name, content, type) {
  if (Cap.downloads) {
    try { await Cap.downloads.save({ filename: name, data: new Blob([content], { type }) }); toast('Saved'); }
    catch (e) { if (e?.code !== 'declined') toast(e?.code === 'rejected_extension' ? "That file type can't be saved from here" : "Couldn't save the file"); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportCSV(list) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Amount', 'Category', 'Note', 'Paid with', 'Tags', 'Subscription', 'Split bill total'].join(',')]
    .concat(list.map((e) => [e.date, e.amount.toFixed(2), q(parts(e).map((p) => catById(p.categoryId).name + (parts(e).length > 1 ? ` (${p.amount})` : '')).join('; ')), q(e.note), q(e.method), q((e.tags || []).map((t) => '#' + t).join(' ')), e.subId ? 'yes' : '', e.split ? e.split.total : ''].join(',')));
  saveFile(`pocketwise-transactions-${today()}.csv`, rows.join('\n'), 'text/csv');
}
function buildICS() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const dt = (s) => s.replace(/-/g, '');
  const rule = { weekly: 'FREQ=WEEKLY', biweekly: 'FREQ=WEEKLY;INTERVAL=2', monthly: 'FREQ=MONTHLY', quarterly: 'FREQ=MONTHLY;INTERVAL=3', yearly: 'FREQ=YEARLY' };
  const escI = (s) => String(s).replace(/[,;\\]/g, (m) => '\\' + m);
  const ev = [];
  for (const s of S.subscriptions.filter((x) => x.active && x.nextDate)) {
    ev.push(['BEGIN:VEVENT', `UID:${s.id}@pocketwise`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${dt(s.nextDate)}`, `DTEND;VALUE=DATE:${dt(addDays(s.nextDate, 1))}`,
      s.trial ? '' : `RRULE:${rule[s.cycle] || rule.monthly}`, `SUMMARY:${escI(s.trial ? `${s.name} free trial ends - cancel?` : `${s.name} renews (${money(s.amount)})`)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escI(s.name)}`, `TRIGGER:-P${Number(S.settings.reminderDays) || 1}D`, 'END:VALARM', 'END:VEVENT'].filter(Boolean).join('\r\n'));
  }
  for (const g of S.goals.filter((x) => x.targetDate && x.saved < x.price)) ev.push(['BEGIN:VEVENT', `UID:${g.id}@pocketwise`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${dt(g.targetDate)}`, `SUMMARY:${escI(`Goal deadline: ${g.name}`)}`, 'END:VEVENT'].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pocketwise//Budget//EN', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n');
}
function applyTheme() {
  const t = S.settings.theme;
  const root = document.documentElement;
  // Only touch data-theme when the user picked one here; "system" leaves the viewer's own setting alone.
  if (t === 'dark' || t === 'light') { root.dataset.theme = t; root.dataset.pwTheme = '1'; }
  else if (root.dataset.pwTheme) { delete root.dataset.theme; delete root.dataset.pwTheme; }
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', isDark() ? '#0b0d12' : '#f4f5f9');
}

// ======================= Sample data =======================
function demoData() {
  const s = freshState();
  const t = today();
  s.settings = { ...s.settings, weeklyBudget: 350, onboarded: true, startDate: addDays(t, -7 * 14), weekStart: S.settings.weekStart, theme: S.settings.theme };
  const c = Object.fromEntries(s.categories.map((x) => [x.name, x.id]));
  s.categories.find((x) => x.name === 'Food & Dining').limit = 90;
  s.categories.find((x) => x.name === 'Shopping').limit = 60;
  s.categories.find((x) => x.name === 'Entertainment').limit = 40;
  const prevS = S; S = s;
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
      s.expenses.push({ id: uid(), amount: round2(lo + rnd() * (hi - lo)), categoryId: c[cat], note: pick(notes), date, method: pick(['Card', 'Card', 'Apple Pay', 'Cash']), tags: rnd() < 0.12 ? ['weekend'] : [], createdAt: Date.now() + day * 1000 + i });
    }
  }
  s.expenses.push({ id: uid(), amount: -24.99, categoryId: c.Shopping, note: 'Amazon return', date: addDays(t, -3), tags: [], createdAt: Date.now() });
  s.expenses.push({ id: uid(), amount: 64.3, categoryId: c.Groceries, parts: [{ categoryId: c.Groceries, amount: 48.1 }, { categoryId: c.Health, amount: 16.2 }], note: 'Target run', date: addDays(t, -2), method: 'Card', tags: [], scanned: true, createdAt: Date.now() });
  s.people = [{ id: 'p1', name: 'Sam', color: PALETTE[0] }, { id: 'p2', name: 'Alex', color: PALETTE[4] }];
  const dinner = { id: uid(), amount: 30, categoryId: c['Food & Dining'], note: 'Dinner at Nando’s', date: addDays(t, -16), method: 'Card', tags: [], split: { total: 90, paidBy: 'me', people: ['p1', 'p2'], shares: { p1: 30, p2: 30 }, mode: 'equal' }, createdAt: Date.now() };
  s.expenses.push(dinner);
  s.ious.push({ id: uid(), personId: 'p1', amount: 30, date: dinner.date, note: dinner.note, type: 'split', expenseId: dinner.id }, { id: uid(), personId: 'p2', amount: 30, date: dinner.date, note: dinner.note, type: 'split', expenseId: dinner.id }, { id: uid(), personId: 'p2', amount: -30, date: addDays(t, -9), note: 'Settled up', type: 'settle' });
  const subs = [['Netflix', 15.49, 'monthly', '🎬'], ['Spotify', 11.99, 'monthly', '🎵'], ['Gym', 40, 'monthly', '🏋️'], ['iCloud', 2.99, 'monthly', '☁️'], ['Amazon Prime', 139, 'yearly', '📦']];
  subs.forEach(([name, amount, cycle, icon], i) => {
    const start = addDays(t, -95 + i * 9);
    s.subscriptions.push({ id: uid(), name, amount, cycle, nextDate: start, anchorDay: parse(start).getDate(), categoryId: c.Subscriptions, active: true, autoLog: true, icon });
  });
  s.subscriptions.push({ id: uid(), name: 'Disney+', amount: 13.99, cycle: 'monthly', nextDate: addDays(t, 2), anchorDay: parse(addDays(t, 2)).getDate(), categoryId: c.Subscriptions, active: true, autoLog: true, icon: '🏰', trial: true });
  s.recurringIncome.push({ id: 'ri1', name: 'Allowance', amount: 50, type: 'allowance', cycle: 'weekly', nextDate: addDays(t, -7 * 8), anchorDay: 1, autoLog: true, active: true, addToBudget: false });
  s.income.push({ id: uid(), amount: 100, name: 'Birthday money', type: 'gift', date: addDays(t, -20), addToBudget: true, createdAt: Date.now() });
  s.income.push({ id: uid(), amount: 45, name: 'Sold old headphones', type: 'sold', date: addDays(t, -5), addToBudget: false, createdAt: Date.now() });
  s.goals = [
    { id: uid(), name: 'New iPhone', price: 1099, saved: 420, targetDate: addDays(t, 7 * 12), icon: '📱', contributions: [{ date: addDays(t, -40), amount: 300 }, { date: addDays(t, -14), amount: 70 }, { date: addDays(t, -6), amount: 50 }] },
    { id: uid(), name: 'Summer trip', price: 2400, saved: 650, targetDate: addDays(t, 7 * 30), icon: '🏖️', contributions: [{ date: addDays(t, -30), amount: 500 }, { date: addDays(t, -10), amount: 150 }] },
    { id: uid(), name: 'Emergency fund', price: 3000, saved: 1200, targetDate: '', icon: '🛟', contributions: [{ date: addDays(t, -20), amount: 1200 }] },
  ];
  const now = Date.now();
  s.cooling = [
    { id: uid(), name: 'Noise-cancelling headphones', price: 249, categoryId: c.Shopping, addedAt: now - 30 * 36e5, until: now + 18 * 36e5, status: 'waiting' },
    { id: uid(), name: 'Sneakers', price: 120, categoryId: c.Shopping, addedAt: now - 60 * 36e5, until: now - 12 * 36e5, status: 'waiting' },
    { id: uid(), name: 'Gaming chair', price: 180, categoryId: c.Shopping, addedAt: now - 300 * 36e5, until: now - 250 * 36e5, status: 'skipped', decidedAt: now - 240 * 36e5 },
  ];
  s.templates = [{ id: uid(), name: 'Starbucks', amount: 6.25, categoryId: c['Food & Dining'], method: 'Apple Pay' }, { id: uid(), name: 'Metro card', amount: 2.9, categoryId: c.Transport, method: 'Card' }];
  for (const sub of s.subscriptions) { if (sub.trial) continue; let g = 0; while (sub.nextDate <= t && g++ < 50) { logSubCharge(sub, sub.nextDate); advanceSub(sub); } }
  for (const r of s.recurringIncome) { let g = 0; while (r.nextDate <= t && g++ < 50) { logRecurringIncome(r, r.nextDate); advanceSub(r); } }
  S = prevS;
  return s;
}

// ======================= Boot =======================
function afterSyncReady() {
  processRecurring();
  render();
  if (!S.settings.onboarded && $('#modal').hidden) onboarding();
}
document.addEventListener('click', (e) => { onClick(e).catch((err) => console.error(err)); });
document.addEventListener('submit', onSubmit);
document.addEventListener('input', onInput);
document.addEventListener('change', onChange);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  if (e.key === 'n' && $('#modal').hidden && !$('#lock') && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); expenseForm(); }
});
window.addEventListener('hashchange', route);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { applyTheme(); renderTopActions(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { DEV.lastActive = Date.now(); saveDev(); return; }
  if (DEV.pinHash && Date.now() - (DEV.lastActive || 0) > 60000) showLock();
  if (Sync.readyResolved) processRecurring();
  if ($('#modal').hidden) render();
});
setInterval(() => {
  if (document.hidden || !$('#modal').hidden) return;
  if (UI.view === 'goals' && UI.goalsTab === 'cooling') render(); else renderTopActions();
}, 60000);

applyTheme();
showLock();
if (!Cap.inArtifact) Sync.resolveReady();
route();
initCaps();
if (!Cap.inArtifact) {
  afterSyncReady();
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
}
