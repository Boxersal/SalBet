const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Fail loudly rather than silently signing tokens with a guessable default.
  throw new Error('JWT_SECRET is not set. Add it to your .env file (see .env.example).');
}

function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10);
}
function checkPassword(pw, hash) {
  return bcrypt.compareSync(pw, hash);
}
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
    expiresIn: '30d',
  });
}
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}
function ownerRequired(req, res, next) {
  if (!req.auth || req.auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  next();
}

module.exports = { hashPassword, checkPassword, signToken, authRequired, ownerRequired, JWT_SECRET };
