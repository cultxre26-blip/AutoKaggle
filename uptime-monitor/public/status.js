const ICONS = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v6M12 17h.01"/></svg>',
  unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 8v4l3 2"/></svg>',
};
(async () => {
  const state = document.getElementById('state');
  try {
    const d = await api(`/status/${location.pathname.split('/').pop()}`);
    const kind = d.status === 'up' ? 'up' : d.status === 'down' ? 'down' : 'unknown';
    document.title = `${d.name} status — PingWatch`;
    document.getElementById('name').textContent = d.name;
    state.textContent = { up: 'All systems operational', down: 'Outage detected', unknown: 'Waiting for the first check' }[kind];
    const icon = document.getElementById('icon');
    icon.className = `status-icon ${kind}`;
    icon.innerHTML = ICONS[kind]; // static markup defined above, no user data
    document.getElementById('uptime').textContent = d.uptime30d === null ? 'No data yet' : `${d.uptime30d}% uptime`;
    const bars = document.getElementById('bars');
    for (const day of d.days) {
      const cls = day.uptime === null ? '' : day.uptime >= 99.5 ? 'good' : day.uptime >= 95 ? 'some' : 'bad';
      bars.append(el('span', { class: cls, title: `${day.date}: ${day.uptime === null ? 'no data' : `${day.uptime}% uptime`}` }));
    }
    if (d.lastCheckedAt) document.getElementById('checked').textContent = `Last checked ${new Date(d.lastCheckedAt).toLocaleString()}`;
  } catch { state.textContent = 'This status page does not exist.'; }
})();
