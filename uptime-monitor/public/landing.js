(async () => {
  const plans = await api('/plans');
  const box = document.getElementById('plans');
  for (const p of Object.values(plans)) {
    box.append(el('div', { class: 'card' },
      el('h3', {}, p.name),
      el('div', { class: 'price' }, p.priceUsd ? `$${p.priceUsd}/mo` : 'Free'),
      el('p', { class: 'muted' }, `${p.maxSites} site${p.maxSites > 1 ? 's' : ''}, checks every ${p.minIntervalSec / 60} min or faster`)));
  }
  let mode = 'signup';
  const form = document.getElementById('authForm');
  document.getElementById('toggle').onclick = () => {
    mode = mode === 'signup' ? 'login' : 'signup';
    document.getElementById('formTitle').textContent = mode === 'signup' ? 'Create your account' : 'Sign in';
    document.getElementById('authBtn').textContent = mode === 'signup' ? 'Sign up free' : 'Sign in';
    document.getElementById('toggle').textContent = mode === 'signup' ? 'I already have an account' : 'Create an account';
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try { await api(mode === 'signup' ? '/signup' : '/login', 'POST', data); location.href = '/dashboard.html'; }
    catch (err) { document.getElementById('authErr').textContent = err.message; }
  };
})();
