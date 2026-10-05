const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');
let me;
async function render() {
  me = await api('/me').catch(() => { location.href = '/'; });
  if (!me) return;
  document.getElementById('who').textContent = me.email;
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
    return el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('strong', {}, el('span', { class: `dot ${s.status}` }), s.name),
        el('span', {}, pause, ' ', del)),
      el('div', { class: 'muted' }, `${s.url} · ${s.paused ? 'paused' : s.status} · last checked ${fmt(s.lastCheckedAt)}${ssl}`),
      el('div', { class: 'muted' }, el('a', { href: `/status/${s.slug}` }, 'Public status page')));
  }));
}
document.getElementById('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try { await api('/sites', 'POST', Object.fromEntries(new FormData(f))); f.reset(); document.getElementById('addErr').textContent = ''; render(); }
  catch (err) { document.getElementById('addErr').textContent = err.message; }
};
document.getElementById('logout').onclick = async () => { await api('/logout', 'POST', {}); location.href = '/'; };
document.getElementById('deleteAcct').onclick = async () => {
  if (confirm('Permanently delete your account and all monitoring data?')) { await api('/me', 'DELETE'); location.href = '/'; }
};
render();
