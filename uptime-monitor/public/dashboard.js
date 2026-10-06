const DAY = 24 * 3600 * 1000;
const open = new Set(); // monitors whose detail panel is open, kept across refreshes
let me;

const ago = (ms) => {
  if (!ms) return 'not checked yet';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const duration = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

function sparkline(values) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 150 36');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Response time over the last 24 hours');
  const nums = values.filter((v) => v !== null);
  if (!values.length) return svg;
  const max = Math.max(...nums, 1);
  const step = values.length > 1 ? 146 / (values.length - 1) : 0;
  const y = (v) => 32 - (v / max) * 26;
  let run = [];
  const flush = () => {
    if (run.length) {
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('class', 'line');
      line.setAttribute('points', run.length === 1 ? `${run[0][0] - 1},${run[0][1]} ${run[0][0] + 1},${run[0][1]}` : run.map((p) => p.join(',')).join(' '));
      svg.append(line);
    }
    run = [];
  };
  values.forEach((v, i) => {
    const x = 2 + i * step;
    if (v === null) {
      flush();
      const tick = document.createElementNS(ns, 'line');
      tick.setAttribute('class', 'line fail');
      Object.entries({ x1: x, x2: x, y1: 4, y2: 32 }).forEach(([k, val]) => tick.setAttribute(k, val));
      svg.append(tick);
    } else run.push([x.toFixed(1), y(v).toFixed(1)]);
  });
  flush();
  return svg;
}

function badge(s) {
  if (s.paused) return el('span', { class: 'badge' }, 'Paused');
  if (s.status === 'up') return el('span', { class: 'badge up' }, 'Up');
  if (s.status === 'down') return el('span', { class: 'badge down' }, 'Down');
  return el('span', { class: 'badge' }, 'Pending');
}

async function showDetails(s, panel) {
  const d = await api(`/sites/${s.id}/checks`);
  const parts = [];
  if (d.stats) parts.push(el('p', { class: 'muted small' }, `Response time over the last ${d.checks.length} checks: average ${d.stats.avgMs} ms, 95th percentile ${d.stats.p95Ms} ms.`));
  parts.push(el('strong', {}, 'Incidents'));
  if (!d.incidents.length) parts.push(el('p', { class: 'muted small' }, 'No incidents recorded.'));
  for (const i of d.incidents) {
    parts.push(el('div', { class: `incident${i.resolved_at ? ' resolved' : ''}` },
      el('strong', {}, i.diagnosis.title),
      el('span', { class: 'muted small' }, `${new Date(i.started_at).toLocaleString()} · ${i.resolved_at ? `resolved after ${duration(i.durationMs)}` : `ongoing for ${duration(i.durationMs)}`}`),
      el('div', { class: 'small' }, `What to try: ${i.diagnosis.fix}`)));
  }
  panel.replaceChildren(...parts);
}

function monitorRow(s) {
  const panel = el('div', { class: 'detail' });
  const checkNow = el('button', { class: 'btn secondary sm' }, 'Check now');
  checkNow.onclick = async () => {
    checkNow.disabled = true;
    try {
      const r = await api(`/sites/${s.id}/check`, 'POST', {});
      panel.replaceChildren(r.ok
        ? el('p', { class: 'ok-text' }, `Up. HTTP ${r.statusCode} in ${r.responseMs} ms.`)
        : el('div', { class: 'incident' }, el('strong', {}, r.diagnosis.title), el('div', { class: 'small' }, `What to try: ${r.diagnosis.fix}`)));
      setTimeout(render, 1500);
    } catch (err) { panel.replaceChildren(el('p', { class: 'err' }, err.message)); }
    checkNow.disabled = false;
  };
  const details = el('button', { class: 'btn ghost sm', 'aria-expanded': String(open.has(s.id)) }, 'Details');
  details.onclick = async () => {
    if (open.has(s.id)) { open.delete(s.id); panel.replaceChildren(); details.setAttribute('aria-expanded', 'false'); return; }
    open.add(s.id); details.setAttribute('aria-expanded', 'true');
    await showDetails(s, panel);
  };
  const pause = el('button', { class: 'btn ghost sm' }, s.paused ? 'Resume' : 'Pause');
  pause.onclick = async () => { await api(`/sites/${s.id}`, 'PATCH', { paused: !s.paused }); render(); };
  const del = el('button', { class: 'btn danger sm' }, 'Delete');
  del.onclick = async () => { if (confirm(`Delete “${s.name}” and its history?`)) { open.delete(s.id); await api(`/sites/${s.id}`, 'DELETE'); render(); } };

  const meta = el('div', { class: 'monitor-meta' }, el('span', {}, `Checked ${ago(s.lastCheckedAt)}`), el('span', {}, `Every ${Math.round(s.intervalSec / 60)} min`));
  if (s.keyword) meta.append(el('span', {}, `Must contain “${s.keyword}”`));
  if (s.sslExpiresAt) {
    const days = Math.floor((s.sslExpiresAt - Date.now()) / DAY);
    meta.append(el('span', { class: days <= 14 ? 'badge warn plain' : '' }, days < 0 ? 'SSL certificate expired' : `SSL expires in ${days} days`));
  }
  meta.append(el('a', { href: `/status/${s.slug}`, target: '_blank', rel: 'noopener' }, 'Public status page'));

  if (open.has(s.id)) showDetails(s, panel);
  return el('div', { class: 'monitor' },
    el('div', { class: 'monitor-main' },
      el('div', {}, el('div', { class: 'monitor-name' }, s.name, badge(s)), el('div', { class: 'monitor-url' }, s.url)),
      sparkline(s.spark),
      el('div', { class: 'metric' }, el('strong', {}, s.uptime24h === null ? '–' : `${s.uptime24h}%`), el('span', { class: 'sub' }, 'uptime, 24h'), el('span', { class: 'sub' }, s.avgMs === null ? 'no response data' : `${s.avgMs} ms average`)),
      el('div', { class: 'actions' }, checkNow, details, pause, del)),
    meta, panel);
}

async function render() {
  me = await api('/me').catch(() => { location.href = '/'; });
  if (!me) return;
  const sites = await api('/sites');
  document.getElementById('who').textContent = me.email;
  const hook = document.querySelector('#hookForm input');
  if (document.activeElement !== hook) hook.value = me.alertWebhookUrl;
  document.getElementById('verifyBox').hidden = me.emailVerified;
  document.getElementById('planLine').textContent = `${me.limits.name} plan · ${sites.length} of ${me.limits.maxSites} monitors used`;

  const actions = document.getElementById('planActions');
  actions.replaceChildren();
  if (me.billingEnabled) {
    if (me.plan === 'free') {
      for (const p of ['pro', 'team']) {
        const b = el('button', { class: p === 'pro' ? 'btn sm' : 'btn secondary sm' }, `Upgrade to ${p[0].toUpperCase() + p.slice(1)}`);
        b.onclick = async () => { b.disabled = true; try { location.href = (await api('/billing/checkout', 'POST', { plan: p })).url; } catch (err) { alert(err.message); b.disabled = false; } };
        actions.append(b);
      }
    } else {
      const b = el('button', { class: 'btn secondary sm' }, 'Manage billing');
      b.onclick = async () => { b.disabled = true; try { location.href = (await api('/billing/portal', 'POST', {})).url; } catch (err) { alert(err.message); b.disabled = false; } };
      actions.append(b);
    }
  }

  const live = sites.filter((s) => !s.paused);
  const avgs = sites.map((s) => s.avgMs).filter((v) => v !== null);
  const stat = (label, value, cls = '') => el('div', { class: 'stat' }, el('div', { class: 'label' }, label), el('div', { class: `value ${cls}` }, String(value)));
  document.getElementById('stats').replaceChildren(
    stat('Monitors', `${sites.length} / ${me.limits.maxSites}`),
    stat('Up', live.filter((s) => s.status === 'up').length, 'up'),
    stat('Down', live.filter((s) => s.status === 'down').length, live.some((s) => s.status === 'down') ? 'down' : ''),
    stat('Avg response', avgs.length ? `${Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length)} ms` : '–'));

  const list = document.getElementById('sites');
  list.replaceChildren(...(sites.length
    ? sites.map(monitorRow)
    : [el('div', { class: 'empty' }, el('strong', {}, 'No monitors yet'), el('p', { style: 'margin:6px 0 0' }, 'Add your first site above and the first check runs within a minute.'))]));
}

document.getElementById('year').textContent = new Date().getFullYear();
api('/config').then((c) => {
  for (const n of document.querySelectorAll('[data-company]')) n.textContent = c.companyName;
  for (const n of document.querySelectorAll('[data-email]')) { if (c.supportEmail) { n.textContent = 'Support'; n.href = `mailto:${c.supportEmail}`; } else n.remove(); }
});

document.getElementById('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button');
  btn.disabled = true;
  try { await api('/sites', 'POST', Object.fromEntries(new FormData(f))); f.reset(); document.getElementById('addErr').textContent = ''; await render(); }
  catch (err) { document.getElementById('addErr').textContent = err.message; }
  btn.disabled = false;
};
document.getElementById('hookForm').onsubmit = async (e) => {
  e.preventDefault();
  const msg = document.getElementById('hookErr');
  try { await api('/me', 'PATCH', { alertWebhookUrl: new FormData(e.target).get('alertWebhookUrl') }); msg.textContent = 'Saved.'; msg.className = 'small ok-text'; }
  catch (err) { msg.textContent = err.message; msg.className = 'small err'; }
};
document.getElementById('resend').onclick = async () => {
  const msg = document.getElementById('resendMsg');
  try { await api('/verify/resend', 'POST', {}); msg.textContent = 'Sent. Check your inbox.'; }
  catch (err) { msg.textContent = err.message; }
};
document.getElementById('logout').onclick = async () => { await api('/logout', 'POST', {}); location.href = '/'; };
document.getElementById('deleteAcct').onclick = async () => {
  if (confirm('Permanently delete your account and all monitoring data? This cannot be undone.')) { await api('/me', 'DELETE'); location.href = '/'; }
};
if (new URLSearchParams(location.search).get('billing') === 'success') document.getElementById('planLine').textContent = 'Thanks! Your subscription is being activated…';
render();
setInterval(() => { if (!document.hidden) render(); }, 60_000);
