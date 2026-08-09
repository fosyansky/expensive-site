const API = '/api';
const PLANS = [
  { id: '7', name: '7 дней', day: '36₽ /день', price: '249₽', sale: null, badge: null },
  { id: '30', name: '30 дней', day: '14₽ /день', price: '429₽', sale: '−60%', badge: { text: 'Популярный', cls: '' }, popular: true },
  { id: '90', name: '90 дней', day: '10₽ /день', price: '899₽', sale: '−72%', badge: { text: '+1', cls: 'green' } },
  { id: '180', name: '180 дней', day: '8₽ /день', price: '1 399₽', sale: '−78%', badge: { text: '+2', cls: 'green' } },
];

const state = {
  token: localStorage.getItem('ex_token') || '',
  user: null,
  plan: '30',
};

const $ = (id) => document.getElementById(id);

function setStatus(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API}/${path.replace(/^\//, '')}`, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function hashView() {
  const h = (location.hash || '#home').replace(/^#/, '').split('?')[0];
  const map = {
    home: 'home',
    login: 'auth',
    auth: 'auth',
    register: 'auth',
    purchase: 'purchase',
    subscribe: 'purchase',
    cabinet: 'cabinet',
    me: 'cabinet',
    key: 'key',
    hwid: 'hwid',
    docs: 'docs',
    documents: 'docs',
  };
  return map[h] || 'home';
}

function show(view) {
  document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
  const node = document.getElementById(`view-${view}`);
  if (node) node.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (view === 'cabinet') fillCabinet();
}

function route() {
  show(hashView());
  $('mobile-menu').classList.add('hidden');
}

function renderPrices(containerId, summaryIds) {
  const root = $(containerId);
  if (!root) return;
  root.innerHTML = '';
  for (const p of PLANS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `price-row${p.id === state.plan ? ' active' : ''}`;
    btn.innerHTML = `
      <div>
        <span class="name">${p.name}${p.badge ? `<span class="badge ${p.badge.cls}">${p.badge.text}</span>` : ''}</span>
      </div>
      <span class="day">${p.day}</span>
      <div class="cost">${p.price}${p.sale ? `<span class="sale">${p.sale}</span>` : ''}</div>
    `;
    btn.onclick = () => {
      state.plan = p.id;
      renderPrices('price-list-home', { label: 'sum-label', price: 'sum-price', day: 'sum-day' });
      renderPrices('price-list', { label: 'buy-label', price: 'buy-price' });
    };
    root.appendChild(btn);
  }
  const cur = PLANS.find((x) => x.id === state.plan) || PLANS[1];
  if (summaryIds.label && $(summaryIds.label)) $(summaryIds.label).textContent = cur.name;
  if (summaryIds.price && $(summaryIds.price)) $(summaryIds.price).textContent = cur.price;
  if (summaryIds.day && $(summaryIds.day)) $(summaryIds.day).textContent = `~${cur.day.replace(' /день', '')} /день`;
}

function setAuthUi() {
  const on = Boolean(state.user);
  $('nav-guest').classList.toggle('hidden', on);
  $('nav-authed').classList.toggle('hidden', !on);
  if (on) $('nav-login').textContent = state.user.login;
}

function fillCabinet() {
  if (!state.user) {
    location.hash = '#login';
    return;
  }
  $('cab-login').textContent = state.user.login || '—';
  $('cab-email').textContent = state.user.email || '—';
}

async function refreshMe() {
  if (!state.token) {
    state.user = null;
    setAuthUi();
    return;
  }
  try {
    const data = await api('me');
    state.user = data.user;
    setAuthUi();
    setStatus('auth-status', `Ты вошёл как ${data.user.login}`, 'ok');
  } catch (_) {
    state.token = '';
    localStorage.removeItem('ex_token');
    state.user = null;
    setAuthUi();
  }
}

document.querySelectorAll('[data-view]').forEach((el) => {
  el.addEventListener('click', (e) => {
    const view = el.getAttribute('data-view');
    const hashMap = {
      home: 'home',
      auth: 'login',
      purchase: 'purchase',
      cabinet: 'cabinet',
      key: 'key',
      hwid: 'hwid',
      docs: 'docs',
    };
    const h = hashMap[view] || view;
    if (location.hash !== `#${h}`) location.hash = `#${h}`;
    else route();
    e.preventDefault();
  });
});

$('btn-menu').onclick = () => $('mobile-menu').classList.toggle('hidden');
$('btn-logout').onclick = () => {
  state.token = '';
  state.user = null;
  localStorage.removeItem('ex_token');
  setAuthUi();
  location.hash = '#home';
};

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('login', {
      method: 'POST',
      body: { login: $('login-id').value, password: $('login-pass').value },
    });
    state.token = data.token;
    localStorage.setItem('ex_token', data.token);
    state.user = data.user;
    setAuthUi();
    setStatus('auth-status', `Ок, ${data.user.login}`, 'ok');
    location.hash = '#cabinet';
  } catch (err) {
    setStatus('auth-status', err.message, 'err');
  }
});

$('reg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('register', {
      method: 'POST',
      body: {
        login: $('reg-login').value,
        email: $('reg-email').value,
        password: $('reg-pass').value,
      },
    });
    state.token = data.token;
    localStorage.setItem('ex_token', data.token);
    state.user = data.user;
    setAuthUi();
    setStatus('auth-status', `Аккаунт создан: ${data.user.login}`, 'ok');
    location.hash = '#cabinet';
  } catch (err) {
    setStatus('auth-status', err.message, 'err');
  }
});

$('key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.token) {
    location.hash = '#login';
    return;
  }
  setStatus('key-status', 'Ключ принят (локально). Оплата/валидация — через кабинет.', 'ok');
});

$('btn-hwid').onclick = () => {
  if (!state.token) {
    location.hash = '#login';
    return;
  }
  setStatus('hwid-status', 'Запрос на сброс HWID отправлен.', 'ok');
};

window.addEventListener('hashchange', route);

renderPrices('price-list-home', { label: 'sum-label', price: 'sum-price', day: 'sum-day' });
renderPrices('price-list', { label: 'buy-label', price: 'buy-price' });
refreshMe().then(route);
window.addEventListener('load', () => {
  setTimeout(() => $('preloader').classList.add('hide'), 400);
});
