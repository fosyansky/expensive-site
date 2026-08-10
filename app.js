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
  chatTimer: null,
  adminTimer: null,
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
    chat: 'chat',
    admin: 'admin',
  };
  return map[h] || 'home';
}

function stopTimers() {
  if (state.chatTimer) clearInterval(state.chatTimer);
  if (state.adminTimer) clearInterval(state.adminTimer);
  state.chatTimer = null;
  state.adminTimer = null;
}

function show(view) {
  document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
  const node = document.getElementById(`view-${view}`);
  if (node) node.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'auto' });
  stopTimers();
  if (view === 'cabinet') fillCabinet();
  if (view === 'chat') {
    refreshChat();
    state.chatTimer = setInterval(refreshChat, 2500);
  }
  if (view === 'admin') {
    if (!state.user || state.user.role !== 'admin') {
      location.hash = '#login';
      return;
    }
    refreshAdmin();
    state.adminTimer = setInterval(refreshAdmin, 4000);
  }
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
  const isAdmin = on && state.user.role === 'admin';
  $('nav-guest').classList.toggle('hidden', on);
  $('nav-authed').classList.toggle('hidden', !on);
  $('nav-admin').classList.toggle('hidden', !isAdmin);
  $('cab-admin').classList.toggle('hidden', !isAdmin);
  if (on) $('nav-login').textContent = state.user.login;
}

function fillCabinet() {
  if (!state.user) {
    location.hash = '#login';
    return;
  }
  const banned = Boolean(state.user.banned);
  const overlay = $('cab-ban-overlay');
  const content = $('cab-content');
  if (overlay) overlay.classList.toggle('hidden', !banned);
  if (content) content.classList.toggle('cab-locked', banned);

  $('cab-login').textContent = state.user.login || '—';
  $('cab-email').textContent = state.user.email || '—';
  $('cab-group').textContent = state.user.role === 'admin' ? 'Администратор' : 'Пользователь';
  if ($('cab-uid')) $('cab-uid').textContent = state.user.uid != null ? String(state.user.uid) : '—';
  if ($('cab-hwid')) $('cab-hwid').textContent = state.user.hwidBound ? 'привязан' : 'не привязан';
  if ($('cab-days')) {
    $('cab-days').textContent = state.user.role === 'admin'
      ? '∞'
      : String(state.user.daysLeft != null ? state.user.daysLeft : 0);
  }
  if ($('cab-avatar')) $('cab-avatar').textContent = String(state.user.login || 'E').charAt(0).toUpperCase();
  if ($('cab-sub-pill')) {
    if (banned) $('cab-sub-pill').textContent = 'забанен';
    else if (state.user.role === 'admin') $('cab-sub-pill').textContent = 'подписка: ∞ admin';
    else if (state.user.hasSub) $('cab-sub-pill').textContent = `подписка: ${state.user.daysLeft} дн.`;
    else $('cab-sub-pill').textContent = 'подписка: нет';
  }
  if (state.user.role === 'admin') $('cab-group').classList.add('admin-tag');
  else $('cab-group').classList.remove('admin-tag');
  if (!banned) setupLauncherDownload();
}

async function setupLauncherDownload() {
  const a = $('cab-download-launcher');
  if (!a) return;
  try {
    const data = await api('launcher');
    a.href = data.url;
    a.setAttribute('download', data.name || 'Expensive-Launcher.exe');
    a.classList.remove('is-disabled');
    a.onclick = null;
  } catch (e) {
    a.href = '#';
    a.classList.add('is-disabled');
    a.onclick = (ev) => {
      ev.preventDefault();
      setStatus('cab-status', e.message || 'Скачивание недоступно', 'err');
    };
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatChatWho(m) {
  if (m.role === 'admin') {
    return `<span class="chat-who admin"><span class="chat-nick">${escapeHtml(m.login)}</span><span class="chat-role"> // администратор</span></span>`;
  }
  return `<span class="chat-who user">${escapeHtml(m.login)}</span>`;
}

async function refreshChat() {
  if (!state.token) {
    setStatus('chat-status', 'Войди, чтобы писать в общий чат', 'err');
    return;
  }
  try {
    const data = await api('chat');
    const box = $('global-chat');
    box.innerHTML = '';
    for (const m of data.messages || []) {
      const div = document.createElement('div');
      div.className = `msg${m.role === 'admin' ? ' msg-admin' : ' msg-user'}`;
      div.innerHTML = `${formatChatWho(m)}<span class="chat-text">${escapeHtml(m.text)}</span>`;
      box.appendChild(div);
    }
    if (!(data.messages || []).length) {
      box.innerHTML = '<p class="muted tiny chat-empty">Пока тихо — напиши первым</p>';
    }
    box.scrollTop = box.scrollHeight;
    setStatus('chat-status', '', '');
  } catch (e) {
    setStatus('chat-status', e.message, 'err');
  }
}

async function refreshAdmin() {
  try {
    if (state.user) $('admin-who').textContent = state.user.login;
    const data = await api('admin/users');
    const online = await api('admin/presence');
    const box = $('admin-users');
    box.innerHTML = '';
    const selected = $('admin-target').value;
    for (const u of data.users || []) {
      const row = document.createElement('div');
      row.className = `admin-row${selected === u.login ? ' selected' : ''}`;
      const roleLabel = u.role === 'admin' ? '<span class="admin-tag">админ</span>' : 'user';
      row.innerHTML = `
        <div>
          <div><b>${escapeHtml(u.login)}</b> · ${roleLabel}${u.active ? ' · <span style="color:#6ee7b7">online</span>' : ''}</div>
          <div class="meta">UID ${u.uid} · ${u.hasSub ? `${u.daysLeft}д` : 'нет сабки'} · ₽${u.balance || 0} · ${u.banned ? 'BANNED' : 'ok'}${u.hwidBound ? ' · HWID' : ''}</div>
        </div>
        <div class="acts">
          <button type="button" data-tgt="${escapeHtml(u.login)}">Выбрать</button>
        </div>
      `;
      box.appendChild(row);
    }
    box.querySelectorAll('[data-tgt]').forEach((btn) => {
      btn.onclick = () => {
        $('admin-target').value = btn.dataset.tgt;
        $('admin-target-label').textContent = btn.dataset.tgt;
        refreshAdmin();
      };
    });

    const onBox = $('admin-online');
    onBox.innerHTML = '';
    for (const p of online.active || []) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `<div><b>${escapeHtml(p.login)}</b><div class="meta">${escapeHtml(p.server || '—')} · ${escapeHtml(p.version || '')}</div></div>
        <div class="acts"><button type="button" data-tgt="${escapeHtml(p.login)}">Выбрать</button></div>`;
      onBox.appendChild(row);
    }
    if (!(online.active || []).length) {
      onBox.innerHTML = '<p class="muted tiny">Никого нет онлайн</p>';
    }
    onBox.querySelectorAll('[data-tgt]').forEach((btn) => {
      btn.onclick = () => {
        $('admin-target').value = btn.dataset.tgt;
        $('admin-target-label').textContent = btn.dataset.tgt;
      };
    });

    const chatData = await api('chat');
    const chatBox = $('admin-chat');
    if (chatBox) {
      chatBox.innerHTML = '';
      for (const m of chatData.messages || []) {
        const div = document.createElement('div');
        div.className = `msg${m.role === 'admin' ? ' msg-admin' : ' msg-user'}`;
        div.innerHTML = `${formatChatWho(m)}<span class="chat-text">${escapeHtml(m.text)}</span>`;
        chatBox.appendChild(div);
      }
      chatBox.scrollTop = chatBox.scrollHeight;
    }
    setStatus('admin-status', `Аккаунтов: ${(data.users || []).length}`, 'ok');
  } catch (e) {
    setStatus('admin-status', e.message, 'err');
  }
}

async function runAdminAct(act) {
  const to = $('admin-target').value.trim();
  if (!to) {
    setStatus('admin-status', 'Сначала выбери аккаунт слева', 'err');
    return;
  }
  try {
    if (act === 'ban' || act === 'unban') {
      await api('admin/ban', { method: 'POST', body: { login: to, banned: act === 'ban' } });
      setStatus('admin-status', act === 'ban' ? `Бан: ${to}` : `Разбан: ${to}`, 'ok');
    } else if (act === 'grant30') {
      await api('admin/grant-sub', { method: 'POST', body: { login: to, days: 30 } });
      setStatus('admin-status', `+30 дней → ${to}`, 'ok');
    } else if (act === 'resethwid') {
      await api('admin/reset-hwid', { method: 'POST', body: { login: to } });
      setStatus('admin-status', `HWID сброшен: ${to}`, 'ok');
    } else if (act === 'kick') {
      await api('admin/command', { method: 'POST', body: { to, type: 'quit', payload: '' } });
      setStatus('admin-status', `Закрыть клиент → ${to}`, 'ok');
    } else if (act === 'proxy') {
      const payload = $('admin-cmd-payload').value;
      await api('admin/command', { method: 'POST', body: { to, type: 'proxy', payload } });
      setStatus('admin-status', `От лица ${to}: отправлено`, 'ok');
      $('admin-cmd-payload').value = '';
    } else if (act === 'resetconfig' || act === 'aspect' || act === 'console') {
      await api('admin/command', { method: 'POST', body: { to, type: act, payload: act === 'aspect' ? '4:3' : '' } });
      setStatus('admin-status', `${act} → ${to}`, 'ok');
    } else {
      await api('admin/command', {
        method: 'POST',
        body: { to, type: act, payload: $('admin-cmd-payload') ? $('admin-cmd-payload').value : '' },
      });
      setStatus('admin-status', `В очередь: ${act} → ${to}`, 'ok');
    }
    refreshAdmin();
  } catch (e) {
    setStatus('admin-status', e.message, 'err');
  }
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
    if (data.user) {
      state.user.hasSub = data.hasSub != null ? data.hasSub : data.user.hasSub;
      state.user.daysLeft = data.daysLeft != null ? data.daysLeft : data.user.daysLeft;
    }
    setAuthUi();
    setStatus('auth-status', data.user.banned
      ? 'Аккаунт заблокирован'
      : `Ты вошёл как ${data.user.login}`, data.user.banned ? 'err' : 'ok');
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
      chat: 'chat',
      admin: 'admin',
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
    location.hash = data.user.role === 'admin' ? '#admin' : '#cabinet';
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

$('btn-hwid').onclick = async () => {
  if (!state.token) {
    location.hash = '#login';
    return;
  }
  try {
    await api('hwid/reset-self', { method: 'POST', body: {} });
    setStatus('hwid-status', 'HWID сброшен', 'ok');
    refreshMe();
  } catch (e) {
    setStatus('hwid-status', e.message, 'err');
  }
};

const cabResetHwid = $('cab-reset-hwid');
if (cabResetHwid) {
  cabResetHwid.onclick = async () => {
    try {
      await api('hwid/reset-self', { method: 'POST', body: {} });
      setStatus('cab-status', 'HWID сброшен', 'ok');
      refreshMe().then(fillCabinet);
    } catch (e) {
      setStatus('cab-status', e.message, 'err');
    }
  };
}

$('global-chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.token) {
    location.hash = '#login';
    return;
  }
  const text = $('global-chat-text').value.trim();
  if (!text) return;
  try {
    await api('chat', { method: 'POST', body: { text, source: 'site' } });
    $('global-chat-text').value = '';
    refreshChat();
  } catch (err) {
    setStatus('chat-status', err.message, 'err');
  }
});

$('admin-chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('admin-chat-text').value.trim();
  if (!text) return;
  try {
    await api('chat', { method: 'POST', body: { text, source: 'site' } });
    $('admin-chat-text').value = '';
    refreshAdmin();
  } catch (err) {
    setStatus('admin-status', err.message, 'err');
  }
});

const clearChatBtn = $('admin-clear-chat');
if (clearChatBtn) {
  clearChatBtn.addEventListener('click', async () => {
    try {
      await api('admin/clear-chat', { method: 'POST', body: {} });
      setStatus('admin-status', 'Чат очищен', 'ok');
      refreshAdmin();
    } catch (err) {
      setStatus('admin-status', err.message, 'err');
    }
  });
}

document.querySelectorAll('[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => runAdminAct(btn.getAttribute('data-act')));
});

window.addEventListener('hashchange', route);

renderPrices('price-list-home', { label: 'sum-label', price: 'sum-price', day: 'sum-day' });
renderPrices('price-list', { label: 'buy-label', price: 'buy-price' });
refreshMe().then(route);
window.addEventListener('load', () => {
  setTimeout(() => $('preloader').classList.add('hide'), 400);
});
