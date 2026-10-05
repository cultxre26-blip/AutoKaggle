(async () => {
  const c = await api('/config');
  for (const n of document.querySelectorAll('[data-company]')) n.textContent = c.companyName;
  for (const n of document.querySelectorAll('[data-email]')) { n.textContent = c.supportEmail || 'the support address on our website'; if (c.supportEmail) n.href = `mailto:${c.supportEmail}`; }
})();
