(async () => {
  try {
    const d = await api(`/status/${location.pathname.split('/').pop()}`);
    document.getElementById('name').textContent = d.name;
    document.getElementById('state').textContent = d.status === 'up' ? 'All systems operational' : d.status === 'down' ? 'Outage detected' : 'Awaiting first check';
    document.getElementById('uptime').textContent = d.uptime30d === null ? '' : `30-day uptime: ${d.uptime30d}%`;
  } catch { document.getElementById('state').textContent = 'Status page not found'; }
})();
