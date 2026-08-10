const {
  loadDb, saveDb, publicUser, authUser, json, readBody, bcrypt, uuidv4, partyCode, dbBackend,
} = require('./store');
const prot = require('./protection');
const fs = require('fs');

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
  if (!Array.isArray(db.subKeys)) db.subKeys = [];
  prot.ensureProtectionDb(db);
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

function makeSubKeyCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chunk = () => {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  };
  return `EXPA-${chunk()}-${chunk()}-${chunk()}`;
}

function normalizeSubKey(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function applySubscriptionDays(user, days) {
  const n = Math.max(1, Math.min(3650, Number(days) || 0));
  if (!n) return 0;
  const base = user.subEndsAt && new Date(user.subEndsAt).getTime() > Date.now()
    ? new Date(user.subEndsAt).getTime()
    : Date.now();
  user.subEndsAt = new Date(base + n * 86400000).toISOString();
  return n;
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
  const now = Date.now();
  const cmd = {
    id: uuidv4(),
    to,
    type,
    payload: payload == null ? '' : String(payload).slice(0, 400),
    by: by || 'system',
    at: new Date(now).toISOString(),
    atMs: now,
    done: false,
  };
  db.commands.push(cmd);
  if (db.commands.length > 400) db.commands = db.commands.slice(-400);
  return cmd;
}

const COMMAND_TTL_MS = 45000;

function pendingCommands(db, login) {
  const now = Date.now();
  let changed = false;
  const live = [];
  for (const c of db.commands) {
    if (!c || c.to !== login || c.done) continue;
    const age = now - (Number(c.atMs) || Date.parse(c.at) || 0);
    if (!Number.isFinite(age) || age > COMMAND_TTL_MS) {
      c.done = true;
      c.doneAt = new Date().toISOString();
      c.expired = true;
      changed = true;
      continue;
    }
    live.push(c);
  }
  return { live, changed };
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
      const bootstrapAdmin = String(process.env.PROTECTION_BOOTSTRAP_ADMIN_LOGIN || '').trim().toLowerCase();
      const makeAdmin = Boolean(bootstrapAdmin) && login === bootstrapAdmin && !db.users.some((u) => u.role === 'admin');
      const user = {
        uid: db.nextUid++,
        login,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        role: makeAdmin ? 'admin' : 'user',
        balance: makeAdmin ? 999999 : 0,
        banned: false,
        hwid: null,
        subEndsAt: makeAdmin ? '9999-12-31T23:59:59.000Z' : null,
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
      if (user.banned) {
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
        const bannedPending = pendingCommands(db, user.login);
        await saveDb(db);
        return json(res, 200, {
          ok: false,
          banned: true,
          commands: bannedPending.live,
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
        launchSessionId: body.launchSessionId ? String(body.launchSessionId) : null,
        installationId: body.installationId ? String(body.installationId) : null,
        buildId: body.buildId ? String(body.buildId) : null,
      };
      let protectionStatus = 'ACTIVE';
      const requireSession = Boolean(
        prot.activeBuild(db, prot.CHANNEL_STABLE) || prot.activeBuild(db, prot.CHANNEL_DEVELOPER)
        || prot.ensureDefaultBuild(db, prot.CHANNEL_STABLE),
      );
      if (requireSession && !body.launchSessionId) {
        protectionStatus = 'NO_VALID_LAUNCH_SESSION';
      } else if (body.launchSessionId) {
        const ls = prot.getLaunchSession(db, String(body.launchSessionId));
        if (!ls || ls.login !== user.login) {
          protectionStatus = 'INVALID_SESSION';
        } else {
          prot.touchLaunchSession(ls);
          if (ls.status === 'REVOKED') protectionStatus = 'REVOKED';
          else if (ls.status === 'EXPIRED' || (ls.expiresAtMs && Date.now() > ls.expiresAtMs)
            || (ls.hardExpiresAtMs && Date.now() > ls.hardExpiresAtMs)) {
            ls.status = 'EXPIRED';
            protectionStatus = 'SESSION_EXPIRED';
          } else if (!hasActiveSub(user)) {
            protectionStatus = 'EXPIRED';
            ls.status = 'REVOKED';
            ls.revokedAt = new Date().toISOString();
            ls.revokeReason = 'NO_SUB';
          } else {
            const inst = prot.findActiveInstallation(db, user.login, ls.installationId);
            if (!inst) protectionStatus = 'INSTALLATION_REVOKED';
            else {
              inst.lastSeenAt = new Date().toISOString();
              protectionStatus = 'ACTIVE';
            }
          }
        }
      }
      if (protectionStatus !== 'ACTIVE') {
        enqueue(db, user.login, 'quit', '', 'system');
      }
      const pending = pendingCommands(db, user.login);
      await saveDb(db);
      return json(res, 200, {
        ok: true,
        commands: pending.live,
        user: publicUser(u || user),
        daysLeft: daysLeft(u || user),
        protectionStatus,
        forceClose: protectionStatus !== 'ACTIVE',
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
        prot.revokeLaunchSessionsForLogin(db, login, 'BANNED');
        prot.resetInstallation(db, login);
        prot.pushProtectionEvent(db, {
          login,
          type: 'BANNED',
          severity: 'critical',
          action: `by:${admin.login}`,
        });
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

    if (action === 'admin' && parts[1] === 'set-role' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const role = String(body.role || '').trim().toLowerCase() === 'admin' ? 'admin' : 'user';
      if (!login) return json(res, 400, { error: 'Нужен login' });
      const db = await loadDb();
      ensureExtras(db);
      const user = db.users.find((u) => u.login === login);
      if (!user) return json(res, 404, { error: 'Юзер не найден' });
      if (role === 'user' && user.role === 'admin') {
        const admins = db.users.filter((u) => u.role === 'admin');
        if (admins.length <= 1) {
          return json(res, 400, { error: 'Нельзя снять последнего админа' });
        }
        if (user.login === admin.login) {
          return json(res, 400, { error: 'Нельзя снять админку у себя' });
        }
      }
      user.role = role;
      if (role === 'admin') user.subEndsAt = '9999-12-31T23:59:59.000Z';
      await saveDb(db);
      return json(res, 200, { ok: true, user: publicUser(user) });
    }

    if (action === 'admin' && parts[1] === 'promote-dev-payload' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const db = await loadDb();
      ensureExtras(db);
      let build;
      try {
        build = prot.promoteDeveloperToStable(db);
      } catch (e) {
        return json(res, 400, { error: e.message || 'promote failed', code: e.code });
      }
      await saveDb(db);
      return json(res, 200, {
        ok: true,
        build: {
          buildId: build.buildId,
          channel: build.channel,
          clientVersion: build.clientVersion,
          plaintextSha256: build.plaintextSha256,
          payloadSha256: build.payloadSha256,
        },
      });
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
      applySubscriptionDays(user, days);
      await saveDb(db);
      return json(res, 200, { ok: true, user: publicUser(user), daysLeft: daysLeft(user) });
    }

    if (action === 'admin' && parts[1] === 'generate-key' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const days = Math.max(1, Math.min(3650, Number(body.days) || 0));
      if (!days) return json(res, 400, { error: 'Укажи количество дней' });
      const db = await loadDb();
      ensureExtras(db);
      let code = makeSubKeyCode();
      while (db.subKeys.some((k) => k.code === code)) code = makeSubKeyCode();
      const row = {
        code,
        days,
        createdAt: new Date().toISOString(),
        createdBy: admin.login,
      };
      db.subKeys.push(row);
      await saveDb(db);
      return json(res, 200, { ok: true, key: row });
    }

    if (action === 'admin' && parts[1] === 'list-keys' && req.method === 'GET') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const db = await loadDb();
      ensureExtras(db);
      return json(res, 200, {
        keys: (db.subKeys || []).slice().reverse().map((k) => ({
          code: k.code,
          days: k.days,
          createdAt: k.createdAt,
          createdBy: k.createdBy,
        })),
      });
    }

    if (action === 'key' && parts[1] === 'activate' && req.method === 'POST') {
      const user = await requireUser(req);
      if (!user) return json(res, 401, { error: 'Сначала войди' });
      if (user.banned) return json(res, 403, { error: 'Аккаунт заблокирован' });
      const body = await readBody(req);
      const code = normalizeSubKey(body.code || body.key || '');
      if (!code) return json(res, 400, { error: 'Введи ключ' });
      const db = await loadDb();
      ensureExtras(db);
      const idx = db.subKeys.findIndex((k) => normalizeSubKey(k.code) === code);
      if (idx < 0) return json(res, 404, { error: 'Ключ не найден или уже использован' });
      const keyRow = db.subKeys[idx];
      const target = db.users.find((u) => u.login === user.login);
      if (!target) return json(res, 404, { error: 'Юзер не найден' });
      const days = applySubscriptionDays(target, keyRow.days);
      db.subKeys.splice(idx, 1);
      await saveDb(db);
      return json(res, 200, {
        ok: true,
        days,
        user: publicUser(target),
        daysLeft: daysLeft(target),
      });
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

    if (action === 'protection' && parts[1] === 'public-key' && req.method === 'GET') {
      const keys = prot.loadOrCreateSigningKeys();
      return json(res, 200, prot.ok({ keyId: keys.keyId, publicKeySpkiB64: keys.publicKeySpkiB64 }));
    }

    if (action === 'protection' && parts[1] === 'installation' && parts[2] === 'enroll' && req.method === 'POST') {
      const user = await requireUser(req);
      if (!user) return json(res, 401, prot.fail('INVALID_SESSION', 'Не авторизован'));
      if (!prot.rateLimit(`enroll:${user.login}`, 10, 60000)) {
        return json(res, 429, prot.fail('PROTECTION_FAILURE', 'Слишком много запросов'));
      }
      if (!hasActiveSub(user)) return json(res, 403, prot.fail('NO_SUB', 'Вы ещё не приобрели подписку.'));
      const body = await readBody(req);
      const db = await loadDb();
      ensureExtras(db);
      let row;
      try {
        row = prot.enrollInstallation(db, user, { ...body, hwid: body.deviceBinding || user.hwid });
      } catch (e) {
        return json(res, 403, prot.fail(e.code || 'INVALID_INSTALLATION', e.message || 'Installation fail'));
      }
      await saveDb(db);
      return json(res, 200, prot.ok({ installation: row }));
    }

    if (action === 'protection' && parts[1] === 'authorize' && req.method === 'POST') {
      const user = await requireUser(req);
      if (!user) return json(res, 401, prot.fail('INVALID_SESSION', 'Не авторизован'));
      if (user.banned) return json(res, 403, prot.fail('BANNED', 'Вы были заблокированы в expensive dlc'));
      if (!prot.rateLimit(`authorize:${user.login}`, 20, 60000)) {
        return json(res, 429, prot.fail('PROTECTION_FAILURE', 'Слишком много запросов'));
      }
      if (!hasActiveSub(user)) return json(res, 403, prot.fail('NO_SUB', 'Вы ещё не приобрели подписку.'));
      const body = await readBody(req);
      const channel = prot.normalizeChannel(
        body.channel || body.clientChannel || (
          /developer/i.test(String(body.clientVersion || '')) ? prot.CHANNEL_DEVELOPER : prot.CHANNEL_STABLE
        ),
      );
      if (channel === prot.CHANNEL_DEVELOPER && user.role !== 'admin') {
        return json(res, 403, prot.fail(
          'DEV_ONLY',
          'Бротишко, ета версия для розробитчикаф, если ты разрабитчик, то напешы главнаму автаритету фасанскаму и он выдаст тебе права.',
        ));
      }
      const db = await loadDb();
      ensureExtras(db);
      const build = prot.ensureDefaultBuild(db, channel);
      if (!build) return json(res, 503, prot.fail('UNSUPPORTED_BUILD', 'Protected build недоступен'));
      if (body.buildId && String(body.buildId) !== build.buildId) {
        return json(res, 403, prot.fail('UNSUPPORTED_BUILD', 'Неподдерживаемый build'));
      }
      const installationId = String(body.installationId || '');
      let installation = prot.findActiveInstallation(db, user.login, installationId);
      if (!installation) {
        return json(res, 403, prot.fail('INVALID_INSTALLATION', 'Installation недействительна'));
      }
      const binding = String(body.deviceBinding || '').trim().slice(0, 128);
      if (!binding || !installation.deviceBinding || installation.deviceBinding !== binding) {
        prot.pushProtectionEvent(db, {
          login: user.login,
          accountId: user.uid,
          installationId,
          type: 'INSTALLATION_MISMATCH',
          severity: 'warn',
        });
        await saveDb(db);
        return json(res, 403, prot.fail('INVALID_INSTALLATION', 'Device binding mismatch'));
      }
      for (const s of Object.values(db.launchSessions)) {
        if (s.installationId === installation.installationId && (s.status === 'ACTIVE' || s.status === 'AUTHORIZED' || s.status === 'PAYLOAD_ISSUED')) {
          s.status = 'REVOKED';
          s.revokedAt = new Date().toISOString();
        }
      }
      let session;
      try {
        session = prot.createLaunchSession(db, user, installation, build);
      } catch (e) {
        return json(res, 500, prot.fail(e.code || 'PROTECTION_FAILURE', e.message || 'session create failed'));
      }
      if (!session.attestation || !session.attestation.signature) {
        return json(res, 500, prot.fail('ATTESTATION_REQUIRED', 'attestation missing'));
      }
      installation.lastSeenAt = new Date().toISOString();
      installation.launcherVersion = String(body.launcherVersion || installation.launcherVersion || '1.0.0');
      await saveDb(db);
      return json(res, 200, prot.ok({
        launchSession: prot.publicSessionView(session),
        payloadKeyB64: session.payloadKeyB64,
        build: {
          buildId: build.buildId,
          channel: prot.buildChannel(build),
          plaintextSha256: build.plaintextSha256,
          payloadSha256: build.payloadSha256,
          payloadId: build.payloadId,
          payloadSize: build.payloadSize,
        },
      }));
    }

    if (action === 'protection' && parts[1] === 'manifest' && req.method === 'GET') {
      const user = await requireUser(req);
      if (!user) return json(res, 401, prot.fail('INVALID_SESSION', 'Не авторизован'));
      if (!hasActiveSub(user)) return json(res, 403, prot.fail('NO_SUB', 'Вы ещё не приобрели подписку.'));
      if (!prot.rateLimit(`manifest:${user.login}`, 30, 60000)) {
        return json(res, 429, prot.fail('PROTECTION_FAILURE', 'Слишком много запросов'));
      }
      const urlQ = new URL(req.url || '/', 'http://localhost');
      const channel = prot.normalizeChannel(
        (req.query && req.query.channel) || urlQ.searchParams.get('channel') || 'stable',
      );
      if (channel === prot.CHANNEL_DEVELOPER && user.role !== 'admin') {
        return json(res, 403, prot.fail(
          'DEV_ONLY',
          'Бротишко, ета версия для розробитчикаф, если ты разрабитчик, то напешы главнаму автаритету фасанскаму и он выдаст тебе права.',
        ));
      }
      const db = await loadDb();
      ensureExtras(db);
      const build = prot.ensureDefaultBuild(db, channel);
      if (!build) return json(res, 503, prot.fail('UNSUPPORTED_BUILD', 'Build недоступен'));
      const body = {
        schemaVersion: 1,
        manifestVersion: build.manifestVersion || 1,
        buildId: build.buildId,
        channel: prot.buildChannel(build),
        clientVersion: build.clientVersion,
        minecraftVersion: build.minecraftVersion,
        fabricVersion: build.fabricLoader,
        payloadId: build.payloadId,
        payloadSize: build.payloadSize,
        sha256: build.payloadSha256,
        plaintextSha256: build.plaintextSha256,
        createdAt: build.createdAt,
        supportedLauncherVersion: '1.2.0',
        files: [
          {
            path: channel === prot.CHANNEL_DEVELOPER
              ? 'expensive/protected/client.payload.dev.enc.json'
              : 'expensive/protected/client.payload.enc.json',
            size: build.payloadSize,
            sha256: build.payloadSha256,
            required: true,
            runtimeOnly: false,
          },
        ],
      };
      const signed = prot.signManifestBody(body);
      return json(res, 200, prot.ok({ manifest: signed }));
    }

    if (action === 'protection' && parts[1] === 'payload' && req.method === 'GET') {
      const user = await requireUser(req);
      if (!user) return json(res, 401, prot.fail('INVALID_SESSION', 'Не авторизован'));
      if (!hasActiveSub(user)) return json(res, 403, prot.fail('NO_SUB', 'Вы ещё не приобрели подписку.'));
      if (!prot.rateLimit(`payload:${user.login}`, 10, 60000)) {
        return json(res, 429, prot.fail('PROTECTION_FAILURE', 'Слишком много запросов'));
      }
      const urlQ = new URL(req.url || '/', 'http://localhost');
      const sessionId = String(
        (req.query && req.query.sessionId) || urlQ.searchParams.get('sessionId') || '',
      );
      const db = await loadDb();
      ensureExtras(db);
      const ls = sessionId ? prot.getLaunchSession(db, sessionId) : null;
      if (!ls || ls.login !== user.login) {
        return json(res, 403, prot.fail('INVALID_SESSION', 'Нужна launch session'));
      }
      if (ls.status === 'REVOKED' || ls.status === 'EXPIRED') {
        return json(res, 403, prot.fail('INVALID_SESSION', ls.status));
      }
      if (ls.payloadConsumed || ls.payloadIssuedAt || ls.nonceUsedAt) {
        return json(res, 403, prot.fail('SESSION_ALREADY_USED', 'SESSION_ALREADY_USED'));
      }
      if (prot.normalizeChannel(ls.channel) === prot.CHANNEL_DEVELOPER && user.role !== 'admin') {
        return json(res, 403, prot.fail(
          'DEV_ONLY',
          'Бротишко, ета версия для розробитчикаф, если ты разрабитчик, то напешы главнаму автаритету фасанскаму и он выдаст тебе права.',
        ));
      }
      prot.touchLaunchSession(ls);
      if (ls.status === 'EXPIRED') return json(res, 403, prot.fail('INVALID_SESSION', 'Session истекла'));
      const channel = prot.normalizeChannel(ls.channel || prot.CHANNEL_STABLE);
      const build = db.builds.find((b) => b.buildId === ls.buildId)
        || prot.ensureDefaultBuild(db, channel);
      if (!build) return json(res, 503, prot.fail('UNSUPPORTED_BUILD', 'Build недоступен'));
      let sessionPayload;
      try {
        prot.claimPayloadIssue(ls);
        await saveDb(db);
        sessionPayload = prot.buildSessionBoundPayload(ls, build);
      } catch (e) {
        prot.pushProtectionEvent(db, {
          login: user.login,
          accountId: user.uid,
          sessionId: ls.sessionId,
          installationId: ls.installationId,
          buildId: ls.buildId,
          type: e.code === 'SESSION_ALREADY_USED' ? 'REPLAY' : (e.code || 'CORRUPT_PAYLOAD'),
          severity: 'critical',
        });
        await saveDb(db);
        return json(res, 403, prot.fail(e.code || 'CORRUPT_PAYLOAD', e.message || 'payload issue failed'));
      }
      await saveDb(db);
      return json(res, 200, prot.ok({
        payload: sessionPayload,
        meta: {
          buildId: build.buildId,
          plaintextSha256: build.plaintextSha256,
          payloadId: sessionPayload.payloadId,
          sessionBound: true,
        },
      }));
    }

    if (action === 'protection' && parts[1] === 'heartbeat' && req.method === 'POST') {
      const user = await authAny(req);
      if (!user) return json(res, 401, prot.fail('INVALID_SESSION', 'Не авторизован'));
      const body = await readBody(req);
      const db = await loadDb();
      ensureExtras(db);
      if (user.banned) {
        prot.revokeLaunchSessionsForLogin(db, user.login, 'BANNED');
        await saveDb(db);
        return json(res, 200, prot.ok({ status: 'BANNED', forceClose: true, serverTime: new Date().toISOString() }));
      }
      if (!hasActiveSub(user)) {
        prot.revokeLaunchSessionsForLogin(db, user.login, 'NO_SUB');
        await saveDb(db);
        return json(res, 200, prot.ok({ status: 'EXPIRED', forceClose: true, serverTime: new Date().toISOString() }));
      }
      const ls = prot.getLaunchSession(db, String(body.sessionId || ''));
      if (!ls || ls.login !== user.login) {
        return json(res, 200, prot.ok({ status: 'INVALID_SESSION', forceClose: true, serverTime: new Date().toISOString() }));
      }
      prot.touchLaunchSession(ls);
      if (ls.status === 'REVOKED') return json(res, 200, prot.ok({ status: 'REVOKED', forceClose: true, serverTime: new Date().toISOString() }));
      if (ls.status === 'EXPIRED') return json(res, 200, prot.ok({ status: 'SESSION_EXPIRED', forceClose: true, serverTime: new Date().toISOString() }));
      if (ls.status === 'AUTHORIZED') {
        return json(res, 200, prot.ok({ status: 'UNAUTHORIZED_RUNTIME', forceClose: true, serverTime: new Date().toISOString() }));
      }
      if (ls.status !== 'ACTIVE' && ls.status !== 'PAYLOAD_ISSUED') {
        return json(res, 200, prot.ok({ status: 'INVALID_SESSION', forceClose: true, serverTime: new Date().toISOString() }));
      }
      if (ls.hardExpiresAtMs && Date.now() > ls.hardExpiresAtMs) {
        ls.status = 'EXPIRED';
        await saveDb(db);
        return json(res, 200, prot.ok({ status: 'SESSION_EXPIRED', forceClose: true, serverTime: new Date().toISOString() }));
      }
      const inst = prot.findActiveInstallation(db, user.login, ls.installationId);
      if (!inst) return json(res, 200, prot.ok({ status: 'INSTALLATION_REVOKED', forceClose: true, serverTime: new Date().toISOString() }));
      ls.lastSeenAt = new Date().toISOString();
      const soft = Date.now() + prot.LAUNCH_SESSION_TTL_MS;
      ls.expiresAtMs = Math.min(soft, ls.hardExpiresAtMs || soft);
      ls.expiresAt = new Date(ls.expiresAtMs).toISOString();
      ls.status = 'ACTIVE';
      await saveDb(db);
      return json(res, 200, prot.ok({ status: 'ACTIVE', forceClose: false, serverTime: new Date().toISOString() }));
    }

    if (action === 'protection' && parts[1] === 'report' && req.method === 'POST') {
      const user = await authAny(req);
      if (!user) return json(res, 401, prot.fail('INVALID_SESSION', 'Не авторизован'));
      if (!prot.rateLimit(`report:${user.login}`, 30, 60000)) {
        return json(res, 429, prot.fail('PROTECTION_FAILURE', 'Слишком много запросов'));
      }
      const body = await readBody(req);
      const db = await loadDb();
      ensureExtras(db);
      prot.pushProtectionEvent(db, {
        login: user.login,
        accountId: user.uid,
        installationId: body.installationId,
        sessionId: body.sessionId,
        buildId: body.buildId,
        type: String(body.type || 'TAMPER_SIGNAL').slice(0, 64),
        severity: String(body.severity || 'warn').slice(0, 16),
        action: String(body.action || '').slice(0, 64),
      });
      await saveDb(db);
      return json(res, 200, prot.ok({}));
    }

    if (action === 'admin' && parts[1] === 'reset-installation' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const login = String(body.login || body.to || '').trim().toLowerCase();
      const db = await loadDb();
      ensureExtras(db);
      if (!db.users.some((u) => u.login === login)) return json(res, 404, { error: 'Юзер не найден' });
      prot.resetInstallation(db, login);
      prot.pushProtectionEvent(db, {
        login,
        type: 'INSTALLATION_RESET',
        severity: 'info',
        action: `by:${admin.login}`,
      });
      enqueue(db, login, 'quit', '', admin.login);
      await saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (action === 'admin' && parts[1] === 'revoke-session' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const db = await loadDb();
      ensureExtras(db);
      const sid = String(body.sessionId || '');
      const ls = prot.getLaunchSession(db, sid);
      if (!ls) return json(res, 404, { error: 'Session не найдена' });
      ls.status = 'REVOKED';
      ls.revokedAt = new Date().toISOString();
      enqueue(db, ls.login, 'quit', '', admin.login);
      await saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (action === 'admin' && parts[1] === 'revoke-all-sessions' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const login = String(body.login || body.to || '').trim().toLowerCase();
      const db = await loadDb();
      ensureExtras(db);
      for (const s of Object.values(db.launchSessions)) {
        if (s.login === login && s.status === 'ACTIVE') {
          s.status = 'REVOKED';
          s.revokedAt = new Date().toISOString();
        }
      }
      enqueue(db, login, 'quit', '', admin.login);
      await saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (action === 'admin' && parts[1] === 'protection-events' && req.method === 'GET') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const db = await loadDb();
      ensureExtras(db);
      return json(res, 200, { events: (db.protectionEvents || []).slice(-100).reverse() });
    }

    if (action === 'admin' && parts[1] === 'protection-status' && req.method === 'GET') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const login = String((req.query && req.query.login) || '').trim().toLowerCase();
      const db = await loadDb();
      ensureExtras(db);
      const installations = db.installations.filter((i) => !login || i.login === login).slice(-50);
      const sessions = Object.values(db.launchSessions)
        .filter((s) => !login || s.login === login)
        .slice(-50)
        .map((s) => prot.sanitizeSessionForAdmin(s));
      const buildStable = prot.ensureDefaultBuild(db, prot.CHANNEL_STABLE);
      const buildDev = prot.ensureDefaultBuild(db, prot.CHANNEL_DEVELOPER);
      const toPub = (build) => (build ? {
        buildId: build.buildId,
        channel: prot.buildChannel(build),
        state: build.state,
        plaintextSha256: build.plaintextSha256,
        payloadSha256: build.payloadSha256,
        payloadId: build.payloadId,
        clientVersion: build.clientVersion,
      } : null);
      return json(res, 200, {
        installations,
        sessions,
        build: toPub(buildStable),
        builds: {
          stable: toPub(buildStable),
          developer: toPub(buildDev),
        },
      });
    }

    if (action === 'admin' && parts[1] === 'revoke-build' && req.method === 'POST') {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: 'Только админ' });
      const body = await readBody(req);
      const db = await loadDb();
      ensureExtras(db);
      const buildId = String(body.buildId || '');
      for (const b of db.builds) {
        if (!buildId || b.buildId === buildId) b.state = 'REVOKED';
      }
      await saveDb(db);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'Not found', path: parts });
  } catch (e) {
    return json(res, 500, { error: e.message || 'server error' });
  }
}

module.exports = { handler, hasActiveSub, daysLeft };
