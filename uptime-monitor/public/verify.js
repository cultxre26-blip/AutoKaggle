(async () => {
  const msg = document.getElementById('msg');
  const token = new URLSearchParams(location.search).get('token');
  try { await api('/verify', 'POST', { token }); msg.textContent = 'Your email is confirmed. You can now add sites.'; msg.className = 'ok-text'; }
  catch (err) { msg.textContent = err.message; msg.className = 'err'; }
})();
