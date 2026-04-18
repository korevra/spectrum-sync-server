/* ===========================================================================
 * SPECTRUM REPORTS — Server-side runner
 * ---------------------------------------------------------------------------
 * Runs on the sync server. Exposes HTTP endpoints that the admin portal and
 * Reports Center call into, and drives cron jobs that:
 *   - produce daily / weekly / monthly reports from the persisted state snapshot
 *   - render an executive HTML document
 *   - email the document to every configured recipient via nodemailer
 *   - save a copy of the report into the `reports` table so it appears in the
 *     Reports Center portal page for anyone to download
 *
 * Configuration is pulled from the persisted state:
 *   state.policies.reports        → schedule / transport / recipients config
 *   state.smtpConfig              → SMTP host, port, creds, from identity
 *   state.users                   → default recipients (admin/manager/cfo)
 *
 * HTTP endpoints registered by attach(httpServer, stateRef, hooks):
 *   POST /reports/send            — run + email one report on demand
 *   POST /reports/config          — save schedule + SMTP override
 *   GET  /reports/list            — list saved report ids
 *   GET  /reports/preview?type=…  — dry-run a report and return HTML
 *   GET  /reports/cron            — inspect active cron jobs
 *
 * Cron jobs:
 *   daily      — 0 {dailyAt.hour} * * *
 *   weekly     — 0 {weeklyAt.hour} * * {weeklyDay}
 *   monthly    — 0 {monthlyAt.hour} {monthlyDay} * *
 *
 * Requires node-cron and nodemailer (declared in package.json).
 * If the packages aren't installed (dev env), HTTP endpoints still work but
 * cron scheduling gracefully no-ops with a clear log message.
 * ======================================================================= */
'use strict';

let cron, nodemailer;
try { cron = require('node-cron'); } catch (e) { cron = null; }
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

let _state = null;
let _persist = null;
let _broadcast = null;
let _activeJobs = { daily: null, weekly: null, monthly: null };
let _lastRun = { daily: null, weekly: null, monthly: null };
let _log = (msg) => console.log('[reports] ' + msg);

/* ------------------------------------------------------------------ *
 * Date helpers
 * ------------------------------------------------------------------ */
const isoDate = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay   = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const weekAnchor = (d) => { const x = startOfDay(d || new Date()); x.setDate(x.getDate() - x.getDay()); return x; };
const weekEnd    = (a) => { const x = new Date(a); x.setDate(x.getDate() + 6); x.setHours(23, 59, 59, 999); return x; };
const monthKey   = (d) => { const x = d instanceof Date ? d : new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0'); };
const monthStart = (k) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1, 0, 0, 0, 0); };
const monthEnd   = (k) => { const [y, m] = k.split('-').map(Number); return new Date(y, m, 0, 23, 59, 59, 999); };
const inRange = (iso, a, b) => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= a.getTime() && t <= b.getTime();
};
const sum = (arr, f) => arr.reduce((s, r) => s + (Number(f ? f(r) : r) || 0), 0);
const avg = (arr, f) => arr.length ? sum(arr, f) / arr.length : 0;
const pct = (num, den) => den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
const money = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG');
const r1 = (n) => Math.round(Number(n) * 10) / 10;

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ------------------------------------------------------------------ *
 * Section builders  — identical outputs to the browser engine so the
 * server-produced HTML looks identical to the portal preview.
 * ------------------------------------------------------------------ */
function sectionAttendance (db, start, end, prevStart, prevEnd) {
  const a    = (db.attendance || []).filter(r => inRange(r.clockIn, start, end));
  const prev = (db.attendance || []).filter(r => inRange(r.clockIn, prevStart, prevEnd));
  const users = db.users || [];
  const activeStaff = users.filter(u => u.status !== 'inactive' && u.role !== 'admin').length;
  const presentByDay = {};
  a.forEach(r => { presentByDay[r.date] = (presentByDay[r.date] || new Set()); presentByDay[r.date].add(r.userId); });
  const uniqueDays = Object.keys(presentByDay).length || 1;
  const avgPresent = Object.values(presentByDay).reduce((s, set) => s + set.size, 0) / uniqueDays;
  const avgPresentRate = pct(avgPresent, activeStaff);
  const late = a.filter(r => r.late).length;
  const latePct = pct(late, a.length);
  const prevLatePct = pct(prev.filter(r => r.late).length, prev.length);
  const withHours = a.filter(r => r.clockIn && r.clockOut);
  const avgHours = avg(withHours, r => (new Date(r.clockOut) - new Date(r.clockIn)) / 3_600_000);
  const byBranch = {};
  a.forEach(r => {
    byBranch[r.branchId] = byBranch[r.branchId] || { total: 0, late: 0 };
    byBranch[r.branchId].total++;
    if (r.late) byBranch[r.branchId].late++;
  });
  const branchRows = Object.entries(byBranch).map(([id, v]) => {
    const b = (db.branches || []).find(x => x.id === id);
    return { branch: b ? b.name : id, clockins: v.total, late: v.late, punctuality: pct(v.total - v.late, v.total) };
  }).sort((x, y) => y.punctuality - x.punctuality);
  const insights = [];
  if (avgPresentRate < 70 && activeStaff > 5) insights.push({ tone: 'warn', text: `Attendance rate of ${avgPresentRate}% is below the 70% operational threshold.` });
  if (latePct > 15) insights.push({ tone: 'warn', text: `${latePct}% of clock-ins were late — review shift scheduling and commute.` });
  if (prev.length && Math.abs(latePct - prevLatePct) >= 5) {
    const delta = (latePct - prevLatePct).toFixed(1);
    insights.push({ tone: delta < 0 ? 'good' : 'warn', text: `Late arrivals ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} pts vs the prior period.` });
  }
  if (avgHours && avgHours < 6) insights.push({ tone: 'warn', text: `Average dwell time of ${r1(avgHours)}h is short — possible early exits or partial shifts.` });
  if (branchRows[0]) insights.push({ tone: 'good', text: `${branchRows[0].branch} leads on punctuality at ${branchRows[0].punctuality}%.` });
  if (branchRows.length > 1) {
    const worst = branchRows[branchRows.length - 1];
    if (worst.punctuality < 80) insights.push({ tone: 'warn', text: `${worst.branch} trails on punctuality at ${worst.punctuality}%.` });
  }
  return {
    key: 'attendance', title: 'Attendance & Punctuality', icon: '📋',
    metrics: [
      { label: 'Active staff', value: activeStaff },
      { label: 'Avg daily presence', value: avgPresentRate + '%' },
      { label: 'Clock-ins', value: a.length },
      { label: 'Late arrivals', value: `${late} (${latePct}%)` },
      { label: 'Avg dwell hours', value: r1(avgHours) + ' h' }
    ],
    table: { heads: ['Branch', 'Clock-ins', 'Late', 'Punctuality'], rows: branchRows.map(r => [r.branch, r.clockins, r.late, r.punctuality + '%']) },
    insights
  };
}

function sectionKpi (db, start, end) {
  const all = db.kpi || [];
  const sub = all.filter(r => inRange(r.submittedAt, start, end));
  const approved = sub.filter(r => r.status === 'approved');
  const avgScore = avg(approved, r => r.score);
  const users = db.users || [];
  const byUser = {};
  approved.forEach(r => {
    byUser[r.userId] = byUser[r.userId] || { total: 0, n: 0 };
    byUser[r.userId].total += Number(r.score || 0);
    byUser[r.userId].n++;
  });
  const ranked = Object.entries(byUser).map(([uid, v]) => {
    const u = users.find(x => x.id === uid);
    return { name: u?.name || uid, branch: (db.branches || []).find(b => b.id === u?.branchId)?.name || '—', avg: r1(v.total / v.n), n: v.n };
  }).sort((a, b) => b.avg - a.avg);
  const top = ranked.slice(0, 5);
  const bot = ranked.slice(-3).reverse();
  const groups = db.kpiGroups || {};
  const roleKeys = Object.keys(groups);
  const submittedRoles = new Set(sub.map(r => r.groupId));
  const roleCoverage = pct(submittedRoles.size, roleKeys.length || 1);
  const insights = [];
  if (avgScore) insights.push({ tone: avgScore >= 80 ? 'good' : avgScore >= 65 ? 'info' : 'warn', text: `Average approved KPI score is ${r1(avgScore)} out of 100.` });
  if (top[0]) insights.push({ tone: 'good', text: `Top performer: ${top[0].name} (${top[0].branch}) at ${top[0].avg}.` });
  if (bot[0] && bot[0].avg < 60) insights.push({ tone: 'warn', text: `${bot[0].name} at ${bot[0].avg} — may need coaching or role review.` });
  if (!sub.length) insights.push({ tone: 'warn', text: 'No KPI entries were submitted this period.' });
  if (sub.length && approved.length / sub.length < 0.6) insights.push({ tone: 'warn', text: 'Less than 60% of submitted KPI entries have been approved — approvals backlog.' });
  if (roleCoverage < 70 && sub.length) insights.push({ tone: 'info', text: `Only ${roleCoverage}% of roles submitted KPI entries — broaden participation.` });
  return {
    key: 'kpi', title: 'KPI Performance', icon: '🎯',
    metrics: [
      { label: 'Entries submitted', value: sub.length },
      { label: 'Approved', value: approved.length },
      { label: 'Avg score', value: r1(avgScore) + ' / 100' },
      { label: 'Role coverage', value: roleCoverage + '%' },
      { label: 'Top performer', value: top[0]?.name || '—' }
    ],
    table: { heads: ['Rank', 'Name', 'Branch', 'Avg Score', 'Entries'], rows: top.map((r, i) => [i + 1, r.name, r.branch, r.avg, r.n]) },
    insights
  };
}

function sectionSales (db, start, end) {
  const psi = (db.psi || []).filter(r => inRange(r.at, start, end) && r.movement === 'sold');
  const products = db.products || [];
  const priceOf = (pid) => products.find(p => p.id === pid)?.price || 0;
  const marginOf = (pid) => { const p = products.find(x => x.id === pid); if (!p) return 0; const cost = p.cost || p.buyPrice || (p.price * 0.75); return Math.max(0, p.price - cost); };
  const revenue = sum(psi, r => r.qty * priceOf(r.productId));
  const grossMargin = sum(psi, r => r.qty * marginOf(r.productId));
  const units = sum(psi, r => r.qty);
  const avgTicket = psi.length ? revenue / psi.length : 0;
  const marginPct = revenue > 0 ? pct(grossMargin, revenue) : 0;
  const byBranch = {};
  psi.forEach(r => { byBranch[r.branchId] = (byBranch[r.branchId] || 0) + r.qty * priceOf(r.productId); });
  const branchRows = Object.entries(byBranch).map(([id, v]) => {
    const b = (db.branches || []).find(x => x.id === id);
    return { branch: b ? b.name : id, revenue: v };
  }).sort((a, b) => b.revenue - a.revenue);
  const byProduct = {};
  psi.forEach(r => { byProduct[r.productId] = byProduct[r.productId] || { qty: 0, rev: 0 }; byProduct[r.productId].qty += r.qty; byProduct[r.productId].rev += r.qty * priceOf(r.productId); });
  const topProducts = Object.entries(byProduct).map(([pid, v]) => { const p = products.find(x => x.id === pid); return { name: p?.name || pid, qty: v.qty, revenue: v.rev }; }).sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  const insights = [];
  if (revenue > 0) {
    insights.push({ tone: 'good', text: `Total sales of ${money(revenue)} across ${units.toLocaleString('en-NG')} units.` });
    insights.push({ tone: marginPct >= 20 ? 'good' : 'warn', text: `Gross margin is ${marginPct}% (${money(grossMargin)}).` });
  } else {
    insights.push({ tone: 'warn', text: 'No sales movements were recorded in this period.' });
  }
  if (branchRows[0]) insights.push({ tone: 'good', text: `${branchRows[0].branch} is the top-grossing branch at ${money(branchRows[0].revenue)}.` });
  if (topProducts[0]) insights.push({ tone: 'info', text: `Top SKU: ${topProducts[0].name} — ${topProducts[0].qty} units, ${money(topProducts[0].revenue)}.` });
  return {
    key: 'sales', title: 'Sales & Revenue', icon: '💰',
    metrics: [
      { label: 'Revenue', value: money(revenue) },
      { label: 'Units sold', value: units.toLocaleString('en-NG') },
      { label: 'Transactions', value: psi.length },
      { label: 'Avg ticket', value: money(avgTicket) },
      { label: 'Gross margin', value: marginPct + '%' }
    ],
    table: { heads: ['Product', 'Units', 'Revenue'], rows: topProducts.map(r => [r.name, r.qty, money(r.revenue)]) },
    insights
  };
}

function sectionInventory (db, start, end) {
  const catalog = db.psiCatalog || [];
  const movements = (db.psi || []).filter(r => inRange(r.at, start, end));
  const lowStock = catalog.filter(r => r.onHand < r.minLevel);
  const stockOut = catalog.filter(r => r.onHand === 0);
  const totalValue = sum(catalog, r => r.onHand * ((db.products || []).find(p => p.id === r.productId)?.price || 0));
  const purchases = movements.filter(r => r.movement === 'purchase');
  const sold = movements.filter(r => r.movement === 'sold');
  const soldIds = new Set(sold.map(r => r.productId));
  const slow = catalog.filter(r => r.onHand > 0 && !soldIds.has(r.productId)).slice(0, 5);
  const insights = [];
  if (stockOut.length) insights.push({ tone: 'warn', text: `${stockOut.length} SKUs are out of stock — immediate reorder recommended.` });
  if (lowStock.length) insights.push({ tone: 'warn', text: `${lowStock.length} SKUs are below minimum level.` });
  if (!movements.length) insights.push({ tone: 'info', text: 'No inventory movements recorded in this period.' });
  if (sold.length && purchases.length && sold.length > purchases.length * 2) insights.push({ tone: 'info', text: 'Sales volume is significantly outpacing purchases — check reorder cadence.' });
  if (slow.length) insights.push({ tone: 'info', text: `${slow.length} SKUs had no sales this period — consider promotions.` });
  insights.push({ tone: 'good', text: `Inventory on hand valued at ${money(totalValue)}.` });
  const rows = [...stockOut, ...lowStock].slice(0, 10).map(r => {
    const p = (db.products || []).find(x => x.id === r.productId);
    const b = (db.branches || []).find(x => x.id === r.branchId);
    return [p?.name || r.productId, b?.name || r.branchId, r.onHand, r.minLevel, r.onHand === 0 ? 'Out' : 'Low'];
  });
  return {
    key: 'inventory', title: 'Inventory & Stock Health', icon: '📦',
    metrics: [
      { label: 'SKUs tracked', value: catalog.length },
      { label: 'On-hand value', value: money(totalValue) },
      { label: 'Stock-outs', value: stockOut.length },
      { label: 'Below minimum', value: lowStock.length },
      { label: 'Movements', value: movements.length }
    ],
    table: { heads: ['Product', 'Branch', 'On hand', 'Min level', 'Status'], rows },
    insights
  };
}

function sectionHr (db, start, end) {
  const leave = (db.leave || []).filter(r => inRange(r.submittedAt, start, end));
  const approved = leave.filter(r => r.status === 'approved');
  const pending  = leave.filter(r => r.status === 'pending');
  const totalDays = sum(approved, r => r.days);
  const byType = {};
  approved.forEach(r => { byType[r.type] = (byType[r.type] || 0) + Number(r.days || 0); });
  const users = db.users || [];
  const headcount = users.filter(u => u.status === 'active').length;
  const onLeaveToday = (db.leave || []).filter(r => r.status === 'approved' && r.startDate && r.endDate && new Date(r.startDate) <= endOfDay(end) && new Date(r.endDate) >= startOfDay(end)).length;
  const insights = [];
  if (pending.length) insights.push({ tone: 'warn', text: `${pending.length} leave request${pending.length > 1 ? 's' : ''} pending manager decision.` });
  if (onLeaveToday) insights.push({ tone: 'info', text: `${onLeaveToday} staff are currently on approved leave.` });
  if (totalDays > headcount * 0.5) insights.push({ tone: 'warn', text: `High leave utilization — ${totalDays} approved leave days this period.` });
  if (!leave.length) insights.push({ tone: 'info', text: 'No leave requests submitted this period.' });
  return {
    key: 'hr', title: 'Human Resources', icon: '👥',
    metrics: [
      { label: 'Headcount', value: headcount },
      { label: 'On leave today', value: onLeaveToday },
      { label: 'Requests', value: leave.length },
      { label: 'Approved days', value: totalDays },
      { label: 'Pending', value: pending.length }
    ],
    table: { heads: ['Type', 'Days taken'], rows: Object.entries(byType).map(([t, d]) => [t, d]) },
    insights
  };
}

function sectionFinance (db, start, end) {
  const expenses = (db.expense || []).filter(r => inRange(r.submittedAt, start, end));
  const approved = expenses.filter(r => r.status === 'approved' || r.status === 'paid');
  const pending  = expenses.filter(r => r.status === 'pending' || r.status === 'review-cfo');
  const rejected = expenses.filter(r => r.status === 'rejected');
  const totalApproved = sum(approved, r => r.amount);
  const totalPending  = sum(pending, r => r.amount);
  const cap = db.policies?.expenseCap || 50000;
  const overCap = expenses.filter(r => Number(r.amount || 0) > cap);
  const byCat = {};
  approved.forEach(r => { byCat[r.category] = (byCat[r.category] || 0) + Number(r.amount || 0); });
  const insights = [];
  insights.push({ tone: 'info', text: `Approved expenses totaled ${money(totalApproved)} across ${approved.length} claims.` });
  if (pending.length) insights.push({ tone: 'warn', text: `${pending.length} expense claim${pending.length > 1 ? 's' : ''} awaiting approval (${money(totalPending)}).` });
  if (overCap.length) insights.push({ tone: 'warn', text: `${overCap.length} claim${overCap.length > 1 ? 's' : ''} exceed the ${money(cap)} cap — CFO sign-off required.` });
  if (rejected.length > approved.length * 0.2) insights.push({ tone: 'warn', text: 'High rejection rate — policy clarity review recommended.' });
  const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  if (topCat) insights.push({ tone: 'info', text: `Largest category: ${topCat[0]} at ${money(topCat[1])}.` });
  return {
    key: 'finance', title: 'Finance & Expenses', icon: '💼',
    metrics: [
      { label: 'Claims', value: expenses.length },
      { label: 'Approved total', value: money(totalApproved) },
      { label: 'Pending total', value: money(totalPending) },
      { label: 'Over-cap', value: overCap.length },
      { label: 'Rejection rate', value: (expenses.length ? pct(rejected.length, expenses.length) : 0) + '%' }
    ],
    table: { heads: ['Category', 'Approved total'], rows: Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => [c, money(v)]) },
    insights
  };
}

function sectionOps (db, start, end) {
  const tickets = (db.tickets || []).filter(r => inRange(r.createdAt, start, end));
  const resolved = tickets.filter(r => r.status === 'resolved' || r.status === 'closed');
  const open = tickets.filter(r => r.status === 'open' || r.status === 'in-progress');
  const avgResolveHrs = avg(resolved.filter(r => r.createdAt && r.updatedAt), r => (new Date(r.updatedAt) - new Date(r.createdAt)) / 3_600_000);
  const urgent = tickets.filter(r => r.priority === 'urgent' || r.priority === 'high').length;
  const slaBreach = resolved.filter(r => { if (!r.sla || !r.createdAt || !r.updatedAt) return false; const hrs = (new Date(r.updatedAt) - new Date(r.createdAt)) / 3_600_000; return hrs > r.sla; }).length;
  const byCat = {};
  tickets.forEach(r => { byCat[r.category] = (byCat[r.category] || 0) + 1; });
  const insights = [];
  insights.push({ tone: 'info', text: `${tickets.length} ticket${tickets.length === 1 ? '' : 's'} logged, ${resolved.length} resolved.` });
  if (open.length) insights.push({ tone: open.length > 20 ? 'warn' : 'info', text: `${open.length} ticket${open.length === 1 ? '' : 's'} still open.` });
  if (avgResolveHrs) insights.push({ tone: avgResolveHrs < 24 ? 'good' : 'warn', text: `Average resolution time: ${r1(avgResolveHrs)} hours.` });
  if (urgent) insights.push({ tone: 'warn', text: `${urgent} high/urgent priority ticket${urgent > 1 ? 's' : ''}.` });
  if (slaBreach) insights.push({ tone: 'warn', text: `${slaBreach} SLA breach${slaBreach > 1 ? 'es' : ''} on resolved tickets.` });
  return {
    key: 'ops', title: 'Operations & Tickets', icon: '🛠️',
    metrics: [
      { label: 'Logged', value: tickets.length },
      { label: 'Resolved', value: resolved.length },
      { label: 'Open', value: open.length },
      { label: 'Avg resolve', value: r1(avgResolveHrs) + ' h' },
      { label: 'SLA breaches', value: slaBreach }
    ],
    table: { heads: ['Category', 'Count'], rows: Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => [c, n]) },
    insights
  };
}

function sectionCustomer (db, start, end) {
  const intel = (db.marketIntel || []).filter(r => inRange(r.reportedAt, start, end));
  const resp = (db.surveyResponses || []).filter(r => inRange(r.submittedAt, start, end));
  const verified = intel.filter(r => r.verified).length;
  const byType = {};
  intel.forEach(r => { byType[r.type] = (byType[r.type] || 0) + 1; });
  const scores = resp.map(r => Number(r.score || r.rating || 0)).filter(n => n > 0);
  const avgScore = avg(scores);
  const nps = scores.length ? Math.round(((scores.filter(s => s >= 9).length - scores.filter(s => s <= 6).length) / scores.length) * 100) : null;
  const insights = [];
  if (intel.length) insights.push({ tone: 'info', text: `${intel.length} market signals captured, ${verified} verified.` });
  if (nps !== null) insights.push({ tone: nps >= 30 ? 'good' : nps >= 0 ? 'info' : 'warn', text: `Customer NPS proxy: ${nps}.` });
  if (resp.length) insights.push({ tone: 'info', text: `${resp.length} survey response${resp.length === 1 ? '' : 's'} received.` });
  if (!intel.length && !resp.length) insights.push({ tone: 'info', text: 'No customer-facing signals captured in this period.' });
  return {
    key: 'customer', title: 'Customer Voice', icon: '🗣️',
    metrics: [
      { label: 'Market signals', value: intel.length },
      { label: 'Verified', value: verified },
      { label: 'Survey responses', value: resp.length },
      { label: 'Avg rating', value: scores.length ? r1(avgScore) : '—' },
      { label: 'NPS proxy', value: nps === null ? '—' : nps }
    ],
    table: { heads: ['Signal type', 'Count'], rows: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => [t, n]) },
    insights
  };
}

function buildExecSummary (sections, prevSections) {
  const bySection = Object.fromEntries(sections.map(s => [s.key, s]));
  const prev = prevSections ? Object.fromEntries(prevSections.map(s => [s.key, s])) : {};
  const revNow = parseFloat((bySection.sales?.metrics.find(m => m.label === 'Revenue')?.value || '₦0').replace(/[^0-9.-]/g, ''));
  const revPrev = parseFloat((prev.sales?.metrics.find(m => m.label === 'Revenue')?.value || '₦0').replace(/[^0-9.-]/g, ''));
  const revDelta = revPrev ? Math.round(((revNow - revPrev) / revPrev) * 1000) / 10 : null;
  const attNow = parseFloat((bySection.attendance?.metrics.find(m => m.label === 'Avg daily presence')?.value || '0').replace('%', ''));
  const attPrev = parseFloat((prev.attendance?.metrics.find(m => m.label === 'Avg daily presence')?.value || '0').replace('%', ''));
  const attDelta = attPrev ? Math.round((attNow - attPrev) * 10) / 10 : null;
  const kpiNow = parseFloat((bySection.kpi?.metrics.find(m => m.label === 'Avg score')?.value || '0').toString().split(' ')[0]);
  const kpiPrev = parseFloat((prev.kpi?.metrics.find(m => m.label === 'Avg score')?.value || '0').toString().split(' ')[0]);
  const kpiDelta = kpiPrev ? Math.round((kpiNow - kpiPrev) * 10) / 10 : null;
  const hero = [
    { label: 'Revenue', value: money(revNow), delta: revDelta, unit: '%' },
    { label: 'Attendance', value: attNow + '%', delta: attDelta, unit: 'pts' },
    { label: 'KPI score', value: (kpiNow || 0) + '/100', delta: kpiDelta, unit: 'pts' },
    { label: 'Open tickets', value: bySection.ops?.metrics.find(m => m.label === 'Open')?.value || 0 },
    { label: 'Pending expenses', value: bySection.finance?.metrics.find(m => m.label === 'Pending total')?.value || '₦0' },
    { label: 'Stock alerts', value: (bySection.inventory?.metrics.find(m => m.label === 'Stock-outs')?.value || 0) + ' / ' + (bySection.inventory?.metrics.find(m => m.label === 'Below minimum')?.value || 0) }
  ];
  const top = [];
  if (revDelta !== null) top.push({ tone: revDelta >= 0 ? 'good' : 'warn', text: `Revenue ${revDelta >= 0 ? 'up' : 'down'} ${Math.abs(revDelta)}% vs prior period.` });
  if (attDelta !== null) top.push({ tone: attDelta >= 0 ? 'good' : 'warn', text: `Attendance ${attDelta >= 0 ? 'up' : 'down'} ${Math.abs(attDelta)} pts vs prior period.` });
  if (kpiDelta !== null) top.push({ tone: kpiDelta >= 0 ? 'good' : 'warn', text: `KPI average ${kpiDelta >= 0 ? 'up' : 'down'} ${Math.abs(kpiDelta)} pts.` });
  sections.forEach(s => {
    const first = (s.insights || []).find(i => i.tone === 'warn') || (s.insights || [])[0];
    if (first) top.push({ ...first, source: s.title });
  });
  return { hero, insights: top.slice(0, 8) };
}

/* ------------------------------------------------------------------ *
 * Compute
 * ------------------------------------------------------------------ */
const fmtDateFull = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
const fmtDateShort = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
const fmtMonthFull = (d) => new Date(d).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const daysBack = (d, n) => { const x = new Date(d); x.setDate(x.getDate() - n); return x; };

function computeDaily (db, date) {
  const d = date ? new Date(date) : new Date();
  const start = startOfDay(d), end = endOfDay(d);
  const prev = new Date(d); prev.setDate(prev.getDate() - 1);
  const prevStart = startOfDay(prev), prevEnd = endOfDay(prev);
  const sections = [
    sectionAttendance(db, start, end, prevStart, prevEnd),
    sectionSales(db, start, end),
    sectionOps(db, start, end),
    sectionFinance(db, start, end),
    sectionHr(db, start, end),
    sectionInventory(db, start, end),
    sectionKpi(db, start, end),
    sectionCustomer(db, start, end)
  ];
  const prevSections = [sectionAttendance(db, prevStart, prevEnd, startOfDay(daysBack(d, 2)), endOfDay(daysBack(d, 2))), sectionSales(db, prevStart, prevEnd), sectionKpi(db, prevStart, prevEnd)];
  const exec = buildExecSummary(sections, prevSections);
  return {
    id: 'rpt_d_' + isoDate(d), type: 'daily', title: `Daily Performance Report — ${fmtDateFull(d)}`,
    subtitle: 'Spectrum Innovation Technologies',
    period: { start: start.toISOString(), end: end.toISOString(), label: fmtDateFull(d) },
    generatedAt: new Date().toISOString(), executiveSummary: exec, sections,
    signature: 'Generated automatically by Spectrum Reports Engine'
  };
}

function computeWeekly (db, anchorStr) {
  const anchor = anchorStr ? weekAnchor(new Date(anchorStr)) : weekAnchor(new Date());
  const start = anchor, end = weekEnd(anchor);
  const prevA = new Date(anchor); prevA.setDate(prevA.getDate() - 7);
  const prevS = prevA, prevE = weekEnd(prevA);
  const sections = [
    sectionAttendance(db, start, end, prevS, prevE),
    sectionSales(db, start, end),
    sectionKpi(db, start, end),
    sectionHr(db, start, end),
    sectionFinance(db, start, end),
    sectionOps(db, start, end),
    sectionInventory(db, start, end),
    sectionCustomer(db, start, end)
  ];
  const prevSections = [sectionAttendance(db, prevS, prevE, daysBack(prevA, 7), daysBack(prevE, 7)), sectionSales(db, prevS, prevE), sectionKpi(db, prevS, prevE)];
  const exec = buildExecSummary(sections, prevSections);
  return {
    id: 'rpt_w_' + isoDate(anchor), type: 'weekly',
    title: `Weekly Performance Report — Week of ${fmtDateFull(anchor)}`,
    subtitle: 'Spectrum Innovation Technologies',
    period: { start: start.toISOString(), end: end.toISOString(), label: `${fmtDateShort(start)} – ${fmtDateShort(end)}` },
    generatedAt: new Date().toISOString(), executiveSummary: exec, sections,
    signature: 'Generated automatically by Spectrum Reports Engine'
  };
}

function computeMonthly (db, monthStr) {
  const key = monthStr || monthKey(new Date());
  const start = monthStart(key), end = monthEnd(key);
  const prevKey = (() => { const d = new Date(start); d.setMonth(d.getMonth() - 1); return monthKey(d); })();
  const prevS = monthStart(prevKey), prevE = monthEnd(prevKey);
  const sections = [
    sectionAttendance(db, start, end, prevS, prevE),
    sectionSales(db, start, end),
    sectionKpi(db, start, end),
    sectionFinance(db, start, end),
    sectionHr(db, start, end),
    sectionOps(db, start, end),
    sectionInventory(db, start, end),
    sectionCustomer(db, start, end)
  ];
  const prevSections = [sectionAttendance(db, prevS, prevE, daysBack(prevS, 30), daysBack(prevE, 30)), sectionSales(db, prevS, prevE), sectionKpi(db, prevS, prevE), sectionFinance(db, prevS, prevE)];
  const exec = buildExecSummary(sections, prevSections);
  return {
    id: 'rpt_m_' + key, type: 'monthly',
    title: `Monthly Performance Report — ${fmtMonthFull(start)}`,
    subtitle: 'Spectrum Innovation Technologies',
    period: { start: start.toISOString(), end: end.toISOString(), label: fmtMonthFull(start) },
    generatedAt: new Date().toISOString(), executiveSummary: exec, sections,
    signature: 'Generated automatically by Spectrum Reports Engine'
  };
}

/* ------------------------------------------------------------------ *
 * HTML renderer — must produce the same executive look as the browser.
 * ------------------------------------------------------------------ */
function renderHtml (report) {
  const CY='#00b5e2',GR='#8dc63f',OR='#e8622a',BG='#03080f',S1='#0b1220',S2='#0f1a2e',TX='#e6ecf5',TX2='#97a6bf',MT='#687692',BD='#1f2e4a',OK='#30d158',WA='#ffab2d',ER='#ff5a5a';
  const periodLabel = report.period?.label || '';
  const tag = report.type === 'daily' ? 'Daily' : report.type === 'weekly' ? 'Weekly' : 'Monthly';

  const css = `body,html{margin:0;padding:0;background:${BG};color:${TX};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.55}.rpt{max-width:680px;margin:0 auto;padding:32px 24px}.rpt-hdr{border-bottom:2px solid ${CY};padding-bottom:18px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:16px}.rpt-hdr h1{margin:0 0 4px;font-size:24px;letter-spacing:-.4px;color:${TX};font-weight:800}.rpt-hdr .sub{font-size:12px;color:${MT};letter-spacing:.5px;text-transform:uppercase;font-weight:700}.rpt-hdr .tag{background:linear-gradient(135deg,${CY},#0094c7);color:#fff;padding:6px 12px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase}.rpt-hdr .gen{font-size:11px;color:${MT};margin-top:8px;display:block}.rpt-exec{background:linear-gradient(160deg,${S2},${S1});border:1px solid ${BD};border-radius:16px;padding:22px;margin-bottom:24px}.rpt-exec h2{margin:0 0 14px;font-size:14px;letter-spacing:.8px;text-transform:uppercase;color:${CY};font-weight:800}.hero{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px}.hero-cell{background:rgba(255,255,255,.03);border:1px solid ${BD};border-radius:12px;padding:12px 14px}.hero-lb{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:${MT};font-weight:800}.hero-v{font-size:20px;font-weight:900;color:${TX};margin-top:4px;letter-spacing:-.3px}.hero-d{font-size:11px;margin-top:2px;font-weight:700}.hero-d.up{color:${OK}}.hero-d.dn{color:${ER}}.insights{display:flex;flex-direction:column;gap:8px}.ins{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:rgba(0,181,226,.06);border-left:3px solid ${CY};border-radius:8px;font-size:13px;color:${TX}}.ins.warn{background:rgba(255,171,45,.08);border-left-color:${WA}}.ins.good{background:rgba(48,209,88,.08);border-left-color:${OK}}.ins .dot{flex-shrink:0;width:10px;height:10px;border-radius:50%;margin-top:5px;background:${CY}}.ins.good .dot{background:${OK}}.ins.warn .dot{background:${WA}}.ins .src{color:${MT};font-size:11px;display:block;margin-top:2px;font-weight:700}.sec{background:${S1};border:1px solid ${BD};border-radius:16px;padding:20px;margin-bottom:18px}.sec h3{margin:0 0 14px;font-size:15px;color:${TX};font-weight:800;display:flex;align-items:center;gap:10px}.sec-metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px}.m{background:rgba(255,255,255,.02);border:1px solid ${BD};border-radius:10px;padding:10px 12px}.m-lb{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:${MT};font-weight:700}.m-v{font-size:16px;font-weight:800;color:${TX};margin-top:3px;letter-spacing:-.2px}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid ${BD}}th{color:${MT};font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:800}td{color:${TX2}}.sec-ins{margin-top:12px;display:flex;flex-direction:column;gap:6px}.ftr{border-top:1px solid ${BD};padding-top:14px;margin-top:20px;font-size:11px;color:${MT};text-align:center;line-height:1.6}.ftr b{color:${CY}}@media (max-width:640px){.sec-metrics{grid-template-columns:repeat(2,1fr)}.hero{grid-template-columns:repeat(2,1fr)}}`;

  const heroHtml = (report.executiveSummary?.hero || []).map(h => {
    const d = h.delta;
    const dStr = (d === null || d === undefined || isNaN(d)) ? '' : `<div class="hero-d ${d >= 0 ? 'up' : 'dn'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}${h.unit || ''}</div>`;
    return `<div class="hero-cell"><div class="hero-lb">${escapeHtml(h.label)}</div><div class="hero-v">${escapeHtml(String(h.value))}</div>${dStr}</div>`;
  }).join('');
  const execInsights = (report.executiveSummary?.insights || []).map(i =>
    `<div class="ins ${i.tone || 'info'}"><span class="dot"></span><div>${escapeHtml(i.text)}${i.source ? `<span class="src">${escapeHtml(i.source)}</span>` : ''}</div></div>`
  ).join('');
  const sectionsHtml = (report.sections || []).map(s => {
    const metrics = (s.metrics || []).map(m => `<div class="m"><div class="m-lb">${escapeHtml(m.label)}</div><div class="m-v">${escapeHtml(String(m.value))}</div></div>`).join('');
    const rows = (s.table?.rows || []).map(row => `<tr>${row.map(cell => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>`).join('');
    const heads = (s.table?.heads || []).map(h => `<th>${escapeHtml(h)}</th>`).join('');
    const insHtml = (s.insights || []).map(i => `<div class="ins ${i.tone || 'info'}"><span class="dot"></span><div>${escapeHtml(i.text)}</div></div>`).join('');
    const tableHtml = rows ? `<table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>` : '';
    return `<div class="sec"><h3>${s.icon || '📊'} ${escapeHtml(s.title)}</h3><div class="sec-metrics">${metrics}</div>${tableHtml}<div class="sec-ins">${insHtml}</div></div>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.title)}</title><style>${css}</style></head><body><div class="rpt"><div class="rpt-hdr"><div><div class="sub">${escapeHtml(report.subtitle || 'Spectrum Innovation Technologies')}</div><h1>${escapeHtml(report.title)}</h1><span class="gen">Generated ${new Date(report.generatedAt).toLocaleString('en-GB')}</span></div><div class="tag">${tag} · ${escapeHtml(periodLabel)}</div></div><div class="rpt-exec"><h2>Executive Summary</h2><div class="hero">${heroHtml}</div><div class="insights">${execInsights}</div></div>${sectionsHtml}<div class="ftr"><b>Spectrum Reports Engine</b> · ${escapeHtml(report.signature || '')}<br>This report was generated automatically. For questions, contact <b>data@spectrumonline.ng</b>.</div></div></body></html>`;
}

function renderText (report) {
  const lines = [];
  lines.push(report.title);
  lines.push('='.repeat(Math.min(80, report.title.length)));
  lines.push(`Period: ${report.period?.label || ''}`);
  lines.push(`Generated: ${new Date(report.generatedAt).toLocaleString('en-GB')}`);
  lines.push('');
  lines.push('EXECUTIVE SUMMARY');
  (report.executiveSummary?.hero || []).forEach(h => lines.push(`  ${h.label}: ${h.value}${h.delta != null ? ` (${h.delta >= 0 ? '+' : ''}${h.delta}${h.unit || ''})` : ''}`));
  lines.push('');
  (report.executiveSummary?.insights || []).forEach(i => lines.push('  * ' + i.text));
  lines.push('');
  (report.sections || []).forEach(s => {
    lines.push(s.title.toUpperCase());
    (s.metrics || []).forEach(m => lines.push(`  ${m.label}: ${m.value}`));
    if (s.insights?.length) { lines.push(''); s.insights.forEach(i => lines.push('  * ' + i.text)); }
    lines.push('');
  });
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Recipients
 * ------------------------------------------------------------------ */
function resolveRecipients (db) {
  const settings = db.policies?.reports || {};
  const base = (db.users || [])
    .filter(u => u.status !== 'inactive' && u.email && ['admin', 'manager', 'cfo', 'coo', 'ceo'].includes(u.role))
    .map(u => ({ name: u.name, email: u.email }));
  const extra = (settings.extraRecipients || []).map(e => {
    const m = /^(.+?)<([^>]+)>$/.exec(String(e).trim());
    if (m) return { name: m[1].trim(), email: m[2].trim() };
    return { name: e, email: e };
  });
  const seen = new Set();
  return [...base, ...extra].filter(r => {
    const k = (r.email || '').toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * SMTP transport
 * ------------------------------------------------------------------ */
function makeTransport (db) {
  if (!nodemailer) {
    _log('nodemailer not installed — emails will be logged only');
    return null;
  }
  const cfg = db.smtpConfig || {};

  // Prefer environment variables when present — safer for production
  const host = process.env.SMTP_HOST || cfg.host;
  const port = Number(process.env.SMTP_PORT || cfg.port || 587);
  const user = process.env.SMTP_USER || cfg.username;
  const pass = process.env.SMTP_PASS || cfg.password;
  const secure = (process.env.SMTP_SECURE || cfg.security) === 'TLS';
  if (!host || !user || !pass) {
    _log('SMTP credentials incomplete — skipping transport creation');
    return null;
  }
  try {
    return nodemailer.createTransport({
      host, port, secure,
      auth: { user, pass },
      tls: { rejectUnauthorized: false }
    });
  } catch (e) {
    _log('SMTP transport error: ' + e.message);
    return null;
  }
}

async function sendEmail (db, mail) {
  const cfg = db.smtpConfig || {};
  const from = process.env.SMTP_FROM || `${cfg.fromName || 'Spectrum Innovation'} <${cfg.fromAddress || 'noreply@spectrumonline.ng'}>`;
  const transport = makeTransport(db);
  if (!transport) {
    _log(`📭 (would send) to=${mail.to} subject="${mail.subject}"`);
    return { ok: false, err: 'No SMTP transport available' };
  }
  try {
    const res = await transport.sendMail({
      from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      replyTo: mail.replyTo || cfg.replyTo || 'support@spectrumonline.ng'
    });
    return { ok: true, messageId: res.messageId };
  } catch (e) {
    _log(`Email to ${mail.to} failed: ${e.message}`);
    return { ok: false, err: e.message };
  }
}

/* ------------------------------------------------------------------ *
 * Persistence — write reports into the state.reports table
 * ------------------------------------------------------------------ */
function saveReport (state, report) {
  state.reports = state.reports || [];
  const idx = state.reports.findIndex(r => r.id === report.id);
  const stored = {
    id: report.id,
    type: report.type,
    title: report.title,
    period: report.period,
    generatedAt: report.generatedAt,
    executiveSummary: report.executiveSummary,
    sections: report.sections,
    signature: report.signature,
    _syncTs: Date.now(),
    _syncCid: 'server'
  };
  if (idx >= 0) state.reports[idx] = stored; else state.reports.push(stored);
  if (_persist) _persist();
  if (_broadcast) _broadcast({
    v: 1, type: 'put', clientId: 'server', userId: null,
    msgId: 'srv_rpt_' + report.id, ts: Date.now(),
    payload: { table: 'reports', record: stored }
  });
}

/* ------------------------------------------------------------------ *
 * Run a report end-to-end
 * ------------------------------------------------------------------ */
async function runAndSend (type, opts) {
  opts = opts || {};
  const db = _state || {};
  let report;
  if (type === 'daily')   report = computeDaily(db, opts.date);
  else if (type === 'weekly')  report = computeWeekly(db, opts.anchor);
  else if (type === 'monthly') report = computeMonthly(db, opts.month);
  else throw new Error('bad type: ' + type);

  const html = renderHtml(report);
  const text = renderText(report);

  saveReport(db, report);

  const recipients = opts.recipients?.length ? opts.recipients : resolveRecipients(db);
  const results = [];
  for (const r of recipients) {
    const res = await sendEmail(db, {
      to: r.email,
      subject: report.title,
      html,
      text
    });
    // Append to emails log
    db.emails = db.emails || [];
    db.emails.push({
      id: 'em_srv_' + Date.now() + Math.random().toString(36).slice(2, 6),
      from: (db.smtpConfig?.fromName || 'Spectrum Innovation') + ' <' + (db.smtpConfig?.fromAddress || 'noreply@spectrumonline.ng') + '>',
      to: r.email,
      subject: report.title,
      body: text.slice(0, 500),
      type: 'report',
      meta: { reportId: report.id, automated: true },
      status: res.ok ? 'sent' : 'failed',
      at: new Date().toISOString(),
      deliveryMs: res.ok ? 200 : null,
      messageId: res.messageId || null,
      err: res.err || null
    });
    results.push({ recipient: r, ...res });
  }
  if (_persist) _persist();
  _lastRun[type] = { at: new Date().toISOString(), recipients: recipients.length, delivered: results.filter(r => r.ok).length };
  _log(`Report (${type}) sent: ${_lastRun[type].delivered}/${_lastRun[type].recipients}`);
  return { report, results, lastRun: _lastRun[type] };
}

/* ------------------------------------------------------------------ *
 * Cron scheduling
 * ------------------------------------------------------------------ */
const DAY_NAME_TO_NUM = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
};

function parseHhMm (s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return fallback;
  return { h: Math.min(23, Math.max(0, Number(m[1]))), m: Math.min(59, Math.max(0, Number(m[2]))) };
}

function scheduleAll () {
  if (!cron) {
    _log('node-cron not installed — scheduled delivery disabled');
    return;
  }
  // Clear existing
  Object.keys(_activeJobs).forEach(k => {
    try { _activeJobs[k]?.stop?.(); _activeJobs[k]?.destroy?.(); } catch (e) {}
    _activeJobs[k] = null;
  });

  const sched = (_state?.policies?.reports) || {};
  if (sched.enabled === false) {
    _log('Report scheduling disabled in admin config');
    return;
  }

  const daily = parseHhMm(sched.dailyAt, { h: 1, m: 0 });
  const weekly = parseHhMm(sched.weeklyAt, { h: 1, m: 0 });
  const monthly = parseHhMm(sched.monthlyAt, { h: 1, m: 0 });
  const weeklyDay = DAY_NAME_TO_NUM[(sched.weeklyDay || 'sunday').toLowerCase()] ?? 0;
  const monthlyDay = Math.min(28, Math.max(1, Number(sched.monthlyDay || 1)));

  // Daily — every day at {daily}
  const dailyExp = `${daily.m} ${daily.h} * * *`;
  _activeJobs.daily = cron.schedule(dailyExp, () => {
    runAndSend('daily').catch(e => _log('Daily run error: ' + e.message));
  }, { timezone: process.env.TZ || 'Africa/Lagos' });
  _log(`Daily cron scheduled: ${dailyExp} (TZ=${process.env.TZ || 'Africa/Lagos'})`);

  // Weekly
  const weeklyExp = `${weekly.m} ${weekly.h} * * ${weeklyDay}`;
  _activeJobs.weekly = cron.schedule(weeklyExp, () => {
    runAndSend('weekly').catch(e => _log('Weekly run error: ' + e.message));
  }, { timezone: process.env.TZ || 'Africa/Lagos' });
  _log(`Weekly cron scheduled: ${weeklyExp}`);

  // Monthly
  const monthlyExp = `${monthly.m} ${monthly.h} ${monthlyDay} * *`;
  _activeJobs.monthly = cron.schedule(monthlyExp, () => {
    runAndSend('monthly').catch(e => _log('Monthly run error: ' + e.message));
  }, { timezone: process.env.TZ || 'Africa/Lagos' });
  _log(`Monthly cron scheduled: ${monthlyExp}`);
}

/* ------------------------------------------------------------------ *
 * HTTP handler — attaches to the existing httpServer instance
 * ------------------------------------------------------------------ */
function handle (req, res) {
  if (!req.url.startsWith('/reports')) return false;

  // CORS — same as main server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /reports/list
  if (req.method === 'GET' && url.pathname === '/reports/list') {
    const list = (_state?.reports || []).map(r => ({ id: r.id, type: r.type, title: r.title, period: r.period, generatedAt: r.generatedAt }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, reports: list }));
    return true;
  }

  // GET /reports/preview?type=daily&date=2026-04-17
  if (req.method === 'GET' && url.pathname === '/reports/preview') {
    const type = url.searchParams.get('type') || 'daily';
    const date = url.searchParams.get('date');
    let report;
    try {
      if (type === 'daily')   report = computeDaily(_state, date);
      else if (type === 'weekly')  report = computeWeekly(_state, date);
      else if (type === 'monthly') report = computeMonthly(_state, date);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, err: e.message }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHtml(report));
    return true;
  }

  // GET /reports/cron
  if (req.method === 'GET' && url.pathname === '/reports/cron') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      active: Object.fromEntries(Object.entries(_activeJobs).map(([k, v]) => [k, !!v])),
      lastRun: _lastRun,
      cronAvailable: !!cron,
      nodemailerAvailable: !!nodemailer,
      schedule: _state?.policies?.reports || null
    }));
    return true;
  }

  // POST /reports/send  { type, date?, recipients? }
  // POST /reports/config { enabled, dailyAt, weeklyAt, weeklyDay, monthlyAt, monthlyDay, extraRecipients, smtp, recipients, smtpConfig }
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, err: 'invalid JSON' }));
        return;
      }

      if (url.pathname === '/reports/send') {
        try {
          const out = await runAndSend(body.type || 'daily', {
            date: body.date, anchor: body.anchor, month: body.month,
            recipients: body.recipients
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, reportId: out.report.id, delivered: out.results.filter(r => r.ok).length, total: out.results.length, lastRun: out.lastRun }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, err: e.message }));
        }
        return;
      }

      if (url.pathname === '/reports/config') {
        // Persist schedule + SMTP overrides into state
        _state.policies = _state.policies || {};
        _state.policies.reports = {
          enabled: body.enabled,
          dailyAt: body.dailyAt || '01:00',
          weeklyAt: body.weeklyAt || '01:00',
          weeklyDay: body.weeklyDay || 'sunday',
          monthlyAt: body.monthlyAt || '01:00',
          monthlyDay: body.monthlyDay || 1,
          extraRecipients: body.extraRecipients || [],
          smtp: body.smtp || null
        };
        if (body.smtpConfig) _state.smtpConfig = { ..._state.smtpConfig, ...body.smtpConfig };
        if (_persist) _persist();
        scheduleAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, schedule: _state.policies.reports }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, err: 'unknown endpoint' }));
    });
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * Public: attach to an existing server.js runtime
 * ------------------------------------------------------------------ */
function attach ({ state, persist, broadcast, log }) {
  _state = state;
  _persist = persist;
  _broadcast = broadcast;
  if (log) _log = log;
  scheduleAll();
  return { handle, runAndSend, scheduleAll, computeDaily, computeWeekly, computeMonthly };
}

module.exports = { attach };
