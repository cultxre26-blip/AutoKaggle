(async () => {
  const [plans, config] = await Promise.all([api('/plans'), api('/config')]);

  document.getElementById('year').textContent = new Date().getFullYear();
  for (const n of document.querySelectorAll('[data-company]')) n.textContent = config.companyName;
  for (const n of document.querySelectorAll('[data-email]')) {
    if (config.supportEmail) n.href = `mailto:${config.supportEmail}`; else n.remove();
  }

  const box = document.getElementById('plans');
  for (const [key, p] of Object.entries(plans)) {
    const every = p.minIntervalSec >= 60 ? `${p.minIntervalSec / 60} minute${p.minIntervalSec > 60 ? 's' : ''}` : `${p.minIntervalSec} seconds`;
    const items = [`${p.maxSites} monitored site${p.maxSites > 1 ? 's' : ''}`, `Checks as often as every ${every}`, 'Email and webhook alerts', 'SSL expiry warnings', 'Failure diagnosis and content checks', 'Public status pages'];
    const card = el('div', { class: `card plan${key === 'pro' ? ' featured' : ''}` });
    if (key === 'pro') card.append(el('span', { class: 'badge plain flag brand' }, 'Best value'));
    card.append(el('h3', {}, p.name), el('div', { class: 'price' }, `$${p.priceUsd}`, el('small', {}, ' /month')), el('ul', {}, ...items.map((t) => el('li', {}, t))),
      el('a', { class: `btn ${key === 'pro' ? '' : 'secondary'} block`, href: '#signup' }, key === 'free' ? 'Start free' : `Choose ${p.name}`));
    box.append(card);
  }

  let mode = 'signup';
  const form = document.getElementById('authForm');
  const setMode = (m) => {
    mode = m;
    const signup = m === 'signup';
    document.getElementById('formTitle').textContent = signup ? 'Create your account' : 'Welcome back';
    document.getElementById('formSub').textContent = signup ? 'Free forever for one site. Takes under a minute.' : 'Sign in to your dashboard.';
    document.getElementById('authBtn').textContent = signup ? 'Create free account' : 'Sign in';
    document.getElementById('toggle').textContent = signup ? 'I already have an account' : 'Create an account';
    document.getElementById('consent').hidden = !signup;
    form.elements.password.autocomplete = signup ? 'new-password' : 'current-password';
    document.getElementById('authErr').textContent = '';
  };
  document.getElementById('toggle').onclick = (e) => { e.preventDefault(); setMode(mode === 'signup' ? 'login' : 'signup'); };
  const fromHash = () => {
    if (location.hash === '#signin') { setMode('login'); document.getElementById('account').scrollIntoView(); form.elements.email.focus({ preventScroll: true }); }
    if (location.hash === '#signup') { setMode('signup'); document.getElementById('account').scrollIntoView(); form.elements.email.focus({ preventScroll: true }); }
  };
  window.addEventListener('hashchange', fromHash);
  fromHash();
  if (new URLSearchParams(location.search).has('reset')) { setMode('login'); document.getElementById('formSub').textContent = 'Password changed. Sign in with your new password.'; }

  let captchaToken = '';
  if (config.captchaSiteKey) {
    const sc = document.createElement('script');
    sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    sc.onload = () => window.turnstile.render('#captcha', { sitekey: config.captchaSiteKey, callback: (t) => { captchaToken = t; } });
    document.head.append(sc);
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('authBtn');
    const err = document.getElementById('authErr');
    err.textContent = '';
    const data = Object.fromEntries(new FormData(form));
    if (!data.email || !data.password) { err.textContent = 'Enter your email and password.'; return; }
    if (captchaToken) data.captchaToken = captchaToken;
    btn.disabled = true;
    try {
      await api(mode === 'signup' ? '/signup' : '/login', 'POST', data);
      location.href = '/dashboard.html';
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      if (window.turnstile && config.captchaSiteKey) { captchaToken = ''; window.turnstile.reset(); }
    }
  };
})();
