const {
  loadDb, saveDb, publicUser, authUser, json, readBody, bcrypt, uuidv4, partyCode, dbBackend,
} = require('./store');

function routeParts(req, forced) {
  if (forced && forced.length) return forced;
  const url = new URL(req.url || '/', 'http://localhost');
  if (Array.isArray(req.query && req.query.path)) {
    return req.query.path.map(String).filter(Boolean);
  }
  if (typeof (req.query && req.query.path) === 'string' && req.query.path) {
    return req.query.path.split('/').filter(Boolean);
  }
  const fromQuery = url.searchParams.get('__path');
  if (fromQuery) return fromQuery.split('/').filter(Boolean);
  return (url.pathname || '').replace(/^\/api\/?/, '').replace(/^index\/?/, '').split('/').filter(Boolean);
}

function ensureExtras(db) {
  if (!Array.isArray(db.chat)) db.chat = [];
  if (!db.presence || typeof db.presence !== 'object') db.presence = {};
  if (!Array.isArray(db.commands)) db.commands = [];
  for (const u of db.users) {
    if (u.balance == null) u.balance = 0;
    if (u.banned == null) u.banned = false;
    if (!u.role) u.role = 'user';
    if (u.hwid === undefined) u.hwid = null;
    if (u.subEndsAt === undefined) {
      u.subEndsAt = u.role === 'admin'
        ? '9999-12-31T23:59:59.000Z'
        : null;
    }
    if (u.role === 'admin') u.subEndsAt = '9999-12-31T23:59:59.000Z';
  }
}

function hasActiveSub(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!user.subEndsAt) return false;
  return new Date(user.subEndsAt).getTime() > Date.now();
}

function daysLeft(user) {
  if (!user) return 0;
  if (user.role === 'admin') return 99999;
  if (!user.subEndsAt) return 0;
  const ms = new Date(user.subEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

async function authAny(req) {
  return authUser(req);
}

async function requireUser(req) {
  const user = await authUser(req);
  if (!user) return null;
  if (user.banned) return null;
  return user;
}

async function requireAdmin(req) {
  const user = await requireUser(req);
  if (!user || user.role !== 'admin') return null;
  return user;
}

function pushChat(db, msg) {
  db.chat.push(msg);
  if (db.chat.length > 500) db.chat = db.chat.slice(-500);
}

function enqueue(db, to, type, payload, by) {
  const cmd = {
    id: uuidv4(),
    to,
    type,
    payload: payload == null ? '' : String(payload).slice(0, 400),
    by: by || 'system',
    at: new Date().toISOString(),
    done: false,
  };
  db.commands.push(cmd);
  if (db.commands.length > 400) db.commands = db.commands.slice(-400);
  return cmd;
}

function parseSayPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text.startsWith('/') || text.startsWith('!')) {
    const body = text.replace(/^[\/!]/, '').trim();
    return { type: 'command', payload: body };
  }
  return { type: 'say', payload: text };
}

async function handler(req, res, forcedPath) {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  const parts = routeParts(req, forcedPath);
  const action = parts[0] || '';

  try {
    if (action === 'health' || (!action && req.method === 'GET')) {
      return json(res, 200, { ok: true, name: 'expensive', db: dbBackend() });
    }

    if (action === 'register' && req.method === 'POST') {
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!login || !email || password.length < 4) {
        return json(res, 400, { error: 'Заполни логин, email и пароль (мин. 4)' });
      }
      const db = await loadDb();
      ensureExtras(db);
      if (db.users.some((u) => u.login === login || u.email === email)) {
        return json(res, 409, { error: 'Логин или email уже заняты' });
      }
      const user = {
        uid: db.nextUid++,
        login,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        role: login === 'human' ? 'admin' : 'user',
        balance: login === 'human' ? 999999 : 0,
        banned: false,
        hwid: null,
        subEndsAt: login === 'human' ? '9999-12-31T23:59:59.000Z' : null,
        registeredAt: new Date().toISOString(),
      };
      db.users.push(user);
      const token = uuidv4();
      db.sessions[token] = login;
      await saveDb(db);
      return json(res, 200, { token, user: publicUser(user) });
    }

    if (action === 'login' && req.method === 'POST') {
      const body = await readBody(req);
      const identity = String(body.login || body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const source = String(body.source || 'site').slice(0, 16);
      const db = await loadDb();
      ensureExtras(db);
      const user = db.users.find((u) => u.login === identity || u.email === identity);
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        return json(res, 401, { error: 'Неверный логин или пароль' });
      }
      if (user.banned && source === 'launcher') {
        return json(res, 403, {
          error: 'Вы были заблокированы в expensive dlc',
          banned: true,
          code: 'BANNED',
        });
      }
      const token = uuidv4();
      db.sessions[token] = user.login;
      await saveDb(db);
      return json(res, 200, {
        token,
        user: publicUser(user),
        banned: Boolean(user.banned),
      });
    }

    if (action === 'me' && req.method === 'GET') {
      const user = await authAny(req);
      if (!user) return json(res, 401, { error: 'Не авторизован' });
      ensureExtras(await loadDb());
      return json(res, 200, {
        user: publicUser(user),
        hasSub: hasActiveSub(user),
        daysLeft: daysLeft(user),
      });
    }

    if (action === 'logout' && req.method === 'POST') {
      const db = await loadDb();
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (token) delete db.sessions[token];
      await saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (action === 'hwid' && parts[1] === 'bind' && req.method === 'POST') {
      const user = await requireUser(req);
      if (!user) return json(res, 401, { error: 'Не авторизован' });
      const body = await readBody(req);
      const hwid = String(body.hwid || '').trim().slice(0, 128);
      if (!hwid) return json(res, 400, { error: 'Нет HWID' });
      const db = await loadDb();
      ensureExtras(db);
      const u = db.users.find((x) => x.login === user.login);
      if (!u) return json(res, 404, { error: 'Юзер не найден' });
      if (u.hwid && u.hwid !== hwid) {
        return json(res, 403, { error: 'HWID уже привязан к другому устройству. Сбрось в ЛК/у админа.' });
      }
      u.hwid = hwid;
      await saveDb(db);
      return json(res, 200, { ok: true, user: publicUser(u) });
    }

    if (action === 'hwid' && parts[1] === 'reset-self' && req.method === 'POST') {
      const user = await requireUser(req);
      if (!user) return json(res, 401, { error: 'Не авторизован' });
      if (!hasActiveSub(user) && user.role !== 'admin') {
        return json(res, 403, { error: 'Нужна активная подписка' });
      }
      const db = await loadDb();
      ensureExtras(db);
      const u = db.users.find((x) => x.login === user.login);
      if (!u) return json(res, 404, { error: 'Юзер не найден' });
      u.hwid = null;
      await saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (action === 'chat' && req.method === 'GET') {
      const user = await requireUser(req);
      if (!user) return json(res, 401, { error: 'Не авторизован' });
      const db = await loadDb();
      ensureExtras(db);
      const after = Number(new URL(req.url, 'http://x').searchParams.get('after') || 0);
      const list = db.chat.filter((m) => !after || m.atMs > after).slice(-100);
      return json(res, 200, { messages: list });
    }

    if (action === 'chat' && req.method === 'POST') {
      const user = await requireUser(req);
      if (!user) return json(res, 401, { error: 'Не авторизован' });
      const body = await readBody(req);
      const text = String(body.text || '').trim().slice(0, 400);
      if (!text) return json(res, 400, { error: 'Пустое сообщение' });
      const db = await loadDb();
      ensureExtras(db);
      const msg = {
        id: uuidv4(),
        login: user.login,
        role: user.role || 'user',
        text,
        source: String(body.source || 'site').slice(0, 16),
        at: new Date().toISOString(),
        atMs: Date.now(),
      };
      pushChat(db, msg);
      await saveDb(db);
      return json(res, 200, { message: msg, messages: db.chat.slice(-100) });
    }

    if (action === 'presence' && req.method === 'POST') {
      const user = await authAny(req);
      if (!user) return json(res, 401, { error: 'Не авторизован' });
      const body = await readBody(req);
      const db = await loadDb();
      ensureExtras(db);
      if (user.banned) {
        enqueue(db, user.login, 'ban', '', 'system');
        await saveDb(db);
        return json(res, 200, {
          ok: false,
          banned: true,
          commands: db.commands.filter((c) => c.to === user.login && !c.done),
        });
      }
      if (!hasActiveSub(user)) {
        return json(res, 403, { error: 'Нет подписки', code: 'NO_SUB' });
      }
      const hwid = String(body.hwid || '').trim().slice(0, 128);
      const u = db.users.find((x) => x.login === user.login);
      if (u && hwid) {
        if (u.hwid && u.hwid !== hwid) {
          return json(res, 403, { error: 'HWID mismatch', code: 'HWID' });
        }
        if (!u.hwid) u.hwid = hwid;
      }
      db.presence[user.login] = {
        login: user.login,
        role: user.role,
        online: true,
        server: String(body.server || '').slice(0, 64),
        version: String(body.version || '').slice(0, 32),
        at: new Date().toISOString(),
        atMs: Date.now(),
      };
      await saveDb(db);
      const cmds = db.commands.filter((c) => c.to === user.login && !c.done);
      return json(res, 200, {
        ok: true,
        commands: cmds,
        user: publicUser(u || user),
        daysLeft: daysLeft(u || user),
      });
    }

    if (action === 'commands' && parts[1] === 'ack' && req.method === 'POST') {
      const user = await authAny(req);
      if (!user) return json(res, 401, { error: 'Не авторизован' });
      const body = await readBody(req);
      const id = String(body.id || '');
      const db = await loadDb();
      ensureExtras(db);
      const cmd = db.commands.find((c) => c.id === id && c.to === user.login);
      if (cmd) {
        cmd.done = true;
        cmd.doneAt = new Date().toISOString();
        await saveDb(db);
      }
      return json(res, 200, { ok: true });
    }

    if (action === 'launcher' && req.method === 'GET') {
      const user = await authAny(req);
      if (!user) return json(res, 401, { error: 'Войди в аккаунт' });
      if (user.banned) return json(res, 403, { error: 'Вы были заблокированы в expensive dlc', banned: true });
      if (!hasActiveSub(user)) {
        return json(res, 403, { error: 'Сначала купи подписку', code: 'NO_SUB' });
      }
      const url = String(process.env.LAUNCHER_DOWNLOAD_URL || '').trim()
        || 'https://github.com/fosyansky/expensive-site/releases/latest/download/Expensive-Party-Launcher.exe';
      return json(res, 200, { url, name: 'Expensive-Launcher.exe' });
    }

    if (action === 'admin' && parts[1] === 'users' && req.method === 'GET') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const db = await loadDb();
      ensureExtras(db);
      const now = Date.now();
      const users = db.users.map((u) => {
        const p = db.presence[u.login];
        const active = Boolean(p && p.atMs && now - p.atMs < 90000);
        return {
          ...publicUser(u),
          active,
          presence: active ? p : null,
          hasSub: hasActiveSub(u),
          daysLeft: daysLeft(u),
        };
      });
      return json(res, 200, { users });
    }

    if (action === 'admin' && parts[1] === 'ban' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const banned = Boolean(body.banned);
      const db = await loadDb();
      ensureExtras(db);
      const user = db.users.find((u) => u.login === login);
      if (!user) return json(res, 404, { error: 'Юзер не найден' });
      if (user.role === 'admin') return json(res, 400, { error: 'Нельзя банить админа' });
      user.banned = banned;
      if (banned) {
        for (const [tok, l] of Object.entries(db.sessions)) {
          if (l === login) delete db.sessions[tok];
        }
        enqueue(db, login, 'ban', '', admin.login);
        enqueue(db, login, 'quit', '', admin.login);
      }
      await saveDb(db);
      return json(res, 200, { ok: true, user: publicUser(user) });
    }

    if (action === 'admin' && parts[1] === 'balance' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const amount = Number(body.amount);
      if (!Number.isFinite(amount)) return json(res, 400, { error: 'Неверная сумма' });
      const db = await loadDb();
      ensureExtras(db);
      const user = db.users.find((u) => u.login === login);
      if (!user) return json(res, 404, { error: 'Юзер не найден' });
      user.balance = Math.max(0, Math.floor((user.balance || 0) + amount));
      await saveDb(db);
      return json(res, 200, { ok: true, user: publicUser(user) });
    }

    if (action === 'admin' && parts[1] === 'set-balance' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const balance = Number(body.balance);
      if (!Number.isFinite(balance) || balance < 0) return json(res, 400, { error: 'Неверный баланс' });
      const db = await loadDb();
      ensureExtras(db);
      const user = db.users.find((u) => u.login === login);
      if (!user) return json(res, 404, { error: 'Юзер не найден' });
      user.balance = Math.floor(balance);
      await saveDb(db);
      return json(res, 200, { ok: true, user: publicUser(user) });
    }

    if (action === 'admin' && parts[1] === 'grant-sub' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const days = Math.max(1, Math.min(3650, Number(body.days) || 30));
      const db = await loadDb();
      ensureExtras(db);
      const user = db.users.find((u) => u.login === login);
      if (!user) return json(res, 404, { error: 'Юзер не найден' });
      const base = user.subEndsAt && new Date(user.subEndsAt).getTime() > Date.now()
        ? new Date(user.subEndsAt).getTime()
        : Date.now();
      user.subEndsAt = new Date(base + days * 86400000).toISOString();
      await saveDb(db);
      return json(res, 200, { ok: true, user: publicUser(user), daysLeft: daysLeft(user) });
    }

    if (action === 'admin' && parts[1] === 'reset-hwid' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const db = await loadDb();
      ensureExtras(db);
      const user = db.users.find((u) => u.login === login);
      if (!user) return json(res, 404, { error: 'Юзер не найден' });
      user.hwid = null;
      await saveDb(db);
      return json(res, 200, { ok: true, user: publicUser(user) });
    }

    if (action === 'admin' && parts[1] === 'kick-session' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const db = await loadDb();
      ensureExtras(db);
      let n = 0;
      for (const [tok, l] of Object.entries(db.sessions)) {
        if (l === login) {
          delete db.sessions[tok];
          n += 1;
        }
      }
      enqueue(db, login, 'quit', '', admin.login);
      await saveDb(db);
      return json(res, 200, { ok: true, cleared: n });
    }

    if (action === 'admin' && parts[1] === 'reset-password' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (password.length < 4) return json(res, 400, { error: 'Пароль мин. 4 символа' });
      const db = await loadDb();
      ensureExtras(db);
      const user = db.users.find((u) => u.login === login);
      if (!user) return json(res, 404, { error: 'Юзер не найден' });
      user.passwordHash = await bcrypt.hash(password, 10);
      for (const [tok, l] of Object.entries(db.sessions)) {
        if (l === login) delete db.sessions[tok];
      }
      await saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (action === 'admin' && parts[1] === 'clear-chat' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const db = await loadDb();
      ensureExtras(db);
      db.chat = [];
      await saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (action === 'admin' && parts[1] === 'command' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const to = String(body.to || '').trim().toLowerCase();
      let type = String(body.type || '').trim();
      let payload = String(body.payload || '').slice(0, 400);
      const allowed = ['blindness', 'say', 'command', 'quit', 'kick', 'resetconfig', 'aspect', 'console', 'ban'];
      if (type === 'proxy') {
        const parsed = parseSayPayload(payload);
        if (!parsed) return json(res, 400, { error: 'Пустой текст' });
        type = parsed.type;
        payload = parsed.payload;
      }
      if (type === 'kick') type = 'quit';
      if (!allowed.includes(type)) return json(res, 400, { error: 'Неизвестный тип' });
      const db = await loadDb();
      ensureExtras(db);
      if (!db.users.some((u) => u.login === to)) return json(res, 404, { error: 'Юзер не найден' });
      const cmd = enqueue(db, to, type, payload, admin.login);
      await saveDb(db);
      return json(res, 200, { ok: true, command: cmd });
    }

    if (action === 'admin' && parts[1] === 'presence' && req.method === 'GET') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const db = await loadDb();
      ensureExtras(db);
      const now = Date.now();
      const active = Object.values(db.presence).filter((p) => p && p.atMs && now - p.atMs < 90000);
      return json(res, 200, { active });
    }

    return json(res, 404, { error: 'Not found', path: parts });
  } catch (e) {
    return json(res, 500, { error: e.message || 'server error' });
  }
}

module.exports = { handler, hasActiveSub, daysLeft };
