const {
  loadDb, saveDb, publicUser, authUser, json, readBody, bcrypt, uuidv4, partyCode,
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

async function handler(req, res, forcedPath) {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  const parts = routeParts(req, forcedPath);
  const action = parts[0] || '';

  try {
    if (action === 'health' || (!action && req.method === 'GET')) {
      return json(res, 200, { ok: true, name: 'expensive' });
    }

    if (action === 'register' && req.method === 'POST') {
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!login || !email || password.length < 4) {
        return json(res, 400, { error: 'Заполни логин, email и пароль (мин. 4)' });
      }
      const db = loadDb();
      if (db.users.some((u) => u.login === login || u.email === email)) {
        return json(res, 409, { error: 'Логин или email уже заняты' });
      }
      const user = {
        uid: db.nextUid++,
        login,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        role: 'user',
        registeredAt: new Date().toISOString(),
      };
      db.users.push(user);
      const token = uuidv4();
      db.sessions[token] = login;
      saveDb(db);
      return json(res, 200, { token, user: publicUser(user) });
    }

    if (action === 'login' && req.method === 'POST') {
      const body = await readBody(req);
      const identity = String(body.login || body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const db = loadDb();
      const user = db.users.find((u) => u.login === identity || u.email === identity);
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        return json(res, 401, { error: 'Неверный логин или пароль' });
      }
      const token = uuidv4();
      db.sessions[token] = user.login;
      saveDb(db);
      return json(res, 200, { token, user: publicUser(user) });
    }

    if (action === 'me' && req.method === 'GET') {
      const user = authUser(req);
      if (!user) return json(res, 401, { error: 'Не авторизован' });
      return json(res, 200, { user: publicUser(user) });
    }

    if (action === 'logout' && req.method === 'POST') {
      const db = loadDb();
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (token) delete db.sessions[token];
      saveDb(db);
      return json(res, 200, { ok: true });
    }

    if (action === 'party' && parts[1] === 'create' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return json(res, 401, { error: 'Войди в аккаунт' });
      const body = await readBody(req);
      const db = loadDb();
      let code = partyCode();
      while (db.parties[code]) code = partyCode();
      const party = {
        code,
        name: String(body.name || `${user.login}'s party`).slice(0, 48),
        owner: user.login,
        members: [user.login],
        createdAt: new Date().toISOString(),
        server: String(body.server || '').slice(0, 64),
        note: String(body.note || '').slice(0, 140),
      };
      db.parties[code] = party;
      db.messages[code] = [{
        id: uuidv4(),
        login: 'system',
        text: `Пати ${party.name} создана. Код: ${code}`,
        at: new Date().toISOString(),
      }];
      saveDb(db);
      return json(res, 200, { party, messages: db.messages[code] });
    }

    if (action === 'party' && parts[1] === 'join' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return json(res, 401, { error: 'Войди в аккаунт' });
      const body = await readBody(req);
      const code = String(body.code || '').trim().toUpperCase();
      const db = loadDb();
      const party = db.parties[code];
      if (!party) return json(res, 404, { error: 'Пати не найдена' });
      if (!party.members.includes(user.login)) {
        party.members.push(user.login);
        db.messages[code] = db.messages[code] || [];
        db.messages[code].push({
          id: uuidv4(),
          login: 'system',
          text: `${user.login} зашёл в пати`,
          at: new Date().toISOString(),
        });
        saveDb(db);
      }
      return json(res, 200, { party, messages: db.messages[code] || [] });
    }

    if (action === 'party' && parts[1] && parts[2] === 'message' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return json(res, 401, { error: 'Войди в аккаунт' });
      const code = String(parts[1]).toUpperCase();
      const body = await readBody(req);
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return json(res, 400, { error: 'Пустое сообщение' });
      const db = loadDb();
      const party = db.parties[code];
      if (!party || !party.members.includes(user.login)) {
        return json(res, 403, { error: 'Нет доступа к пати' });
      }
      db.messages[code] = db.messages[code] || [];
      const msg = {
        id: uuidv4(),
        login: user.login,
        text,
        at: new Date().toISOString(),
      };
      db.messages[code].push(msg);
      if (db.messages[code].length > 200) {
        db.messages[code] = db.messages[code].slice(-200);
      }
      saveDb(db);
      return json(res, 200, { message: msg, messages: db.messages[code] });
    }

    if (action === 'party' && parts[1] && req.method === 'GET') {
      const user = authUser(req);
      if (!user) return json(res, 401, { error: 'Войди в аккаунт' });
      const code = String(parts[1]).toUpperCase();
      const db = loadDb();
      const party = db.parties[code];
      if (!party) return json(res, 404, { error: 'Пати не найдена' });
      if (!party.members.includes(user.login)) {
        return json(res, 403, { error: 'Ты не в этой пати' });
      }
      return json(res, 200, { party, messages: db.messages[code] || [] });
    }

    return json(res, 404, { error: 'Not found', path: parts });
  } catch (e) {
    return json(res, 500, { error: e.message || 'server error' });
  }
}

module.exports = { handler };
