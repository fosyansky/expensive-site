const { handler } = require('./_lib/handler');

module.exports = (req, res) => {
  const path = Array.isArray(req.query.path)
    ? req.query.path
    : String(req.query.path || '')
      .split('/')
      .filter(Boolean);
  return handler(req, res, path.length ? path : ['party']);
};
