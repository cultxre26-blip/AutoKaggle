document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msg');
  try {
    await api('/password/forgot', 'POST', Object.fromEntries(new FormData(e.target)));
    msg.textContent = 'If an account exists for that email, a reset link is on its way.';
  } catch (err) { msg.textContent = err.message; }
};
