const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');
let me;
async function render() {
  me = await api('/me').catch(() => { location.href = '/'; });
  if (!me) return;
  document.getElementById('who').textContent = me.email;
  document.querySelector('#hookForm input').value = me.alertWebhookUrl;
  const pb = document.getElementById('planBox');
  pb.replaceChildren(el('div', { class: 'row' },
    el('span', {}, `Plan: ${me.limits.name} (${me.limits.maxSites} site${me.limits.maxSites > 1 ? 's' : ''})`)));
  const row = pb.firstChild;
  if (me.billingEnabled) {
    if (me.plan === 'free') {
      for (const p of ['pro', 'team']) {
        const b = el('button', {}, `Upgrade to ${p[0].toUpperCase() + p.slice(1)}`);
        b.onclick = async () => { location.href = (await api('/billing/checkout', 'POST', { plan: p })).url; };
        row.append(b);
      }
    } else {
      const b = el('button', { class: 'secondary' }, 'Manage billing');
      b.onclick = async () => { location.href = (await api('/billing/portal', 'POST', {})).url; };
      row.append(b);
    }
  }
  const sites = await api('/sites');
  const list = document.getElementById('sites');
  list.replaceChildren(...sites.map((s) => {
    const pause = el('button', { class: 'secondary' }, s.paused ? 'Resume' : 'Pause');
    pause.onclick = async () => { await api(`/sites/${s.id}`, 'PATCH', { paused: !s.paused }); render(); };
    const del = el('button', { class: 'danger' }, 'Delete');
    del.onclick = async () => { if (confirm(`Delete ${s.name}?`)) { await api(`/sites/${s.id}`, 'DELETE'); render(); } };
    const ssl = s.sslExpiresAt ? ` · SSL expires ${new Date(s.sslExpiresAt).toLocaleDateString()}` : '';
    const detail = el('div', { class: 'muted' });
    const checkNow = el('button', { class: 'secondary' }, 'Check now');
    checkNow.onclick = async () => {
      checkNow.disabled = true;
      try {
        const r = await api(`/sites/${s.id}/check`, 'POST', {});
        detail.replaceChildren(el('p', { class: r.ok ? '' : 'err' }, r.ok ? `Up (HTTP ${r.statusCode}, ${r.responseMs} ms)` : `${r.diagnosis.title}. ${r.diagnosis.fix}`));
        setTimeout(render, 1500);
      } catch (err) { detail.replaceChildren(el('p', { class: 'err' }, err.message)); }
      checkNow.disabled = false;
    };
    const history = el('button', { class: 'secondary' }, 'Details');
    history.onclick = async () => {
      const d = await api(`/sites/${s.id}/checks`);
      const parts = [];
      if (d.stats) parts.push(el('p', {}, `Response time: avg ${d.stats.avgMs} ms, p95 ${d.stats.p95Ms} ms (last ${d.checks.length} checks)`));
      parts.push(el('strong', {}, 'Incidents'));
      if (!d.incidents.length) parts.push(el('p', {}, 'No incidents recorded.'));
      for (const i of d.incidents) {
        const mins = Math.max(1, Math.round(i.durationMs / 60000));
        parts.push(el('div', { class: 'card' },
          el('strong', { class: i.resolved_at ? '' : 'err' }, `${i.diagnosis.title} — ${i.resolved_at ? `resolved after ${mins} min` : `ongoing for ${mins} min`}`),
          el('div', {}, `Started ${fmt(i.started_at)}`),
          el('div', {}, `What to try: ${i.diagnosis.fix}`)));
      }
      detail.replaceChildren(...parts);
    };
    return el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('strong', {}, el('span', { class: `dot ${s.status}` }), s.name),
        el('span', {}, checkNow, ' ', history, ' ', pause, ' ', del)),
      el('div', { class: 'muted' }, `${s.url}${s.keyword ? ` · must contain "${s.keyword}"` : ''} · ${s.paused ? 'paused' : s.status} · last checked ${fmt(s.lastCheckedAt)}${ssl}`),
      el('div', { class: 'muted' }, el('a', { href: `/status/${s.slug}` }, 'Public status page')),
      detail);
  }));
}
document.getElementById('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try { await api('/sites', 'POST', Object.fromEntries(new FormData(f))); f.reset(); document.getElementById('addErr').textContent = ''; render(); }
  catch (err) { document.getElementById('addErr').textContent = err.message; }
};
document.getElementById('hookForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/me', 'PATCH', { alertWebhookUrl: new FormData(e.target).get('alertWebhookUrl') }); document.getElementById('hookErr').textContent = 'Saved'; }
  catch (err) { document.getElementById('hookErr').textContent = err.message; }
};
document.getElementById('logout').onclick = async () => { await api('/logout', 'POST', {}); location.href = '/'; };
document.getElementById('deleteAcct').onclick = async () => {
  if (confirm('Permanently delete your account and all monitoring data?')) { await api('/me', 'DELETE'); location.href = '/'; }
};
render();
