document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msg');
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    await api('/password/forgot', 'POST', Object.fromEntries(new FormData(e.target)));
    msg.textContent = 'If an account exists for that email, a reset link is on its way. Check your inbox.';
    msg.className = 'ok-text small';
  } catch (err) { msg.textContent = err.message; msg.className = 'err'; btn.disabled = false; }
};
