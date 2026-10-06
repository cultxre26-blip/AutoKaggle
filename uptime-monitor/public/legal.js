(async () => {
  const c = await api('/config');
  for (const n of document.querySelectorAll('[data-company]')) n.textContent = c.companyName;
  for (const n of document.querySelectorAll('[data-email]')) {
    if (c.supportEmail) { n.textContent = n.textContent || c.supportEmail; n.href = `mailto:${c.supportEmail}`; } else n.remove();
  }
})();
