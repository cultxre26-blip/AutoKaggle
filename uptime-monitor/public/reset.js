document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const token = new URLSearchParams(location.search).get('token');
  try {
    await api('/password/reset', 'POST', { token, password: new FormData(e.target).get('password') });
    location.href = '/?reset=1';
  } catch (err) { document.getElementById('msg').textContent = err.message; }
};
