const jwt  = require('jsonwebtoken');
const db   = require('../config/database');

// ── Vérifier token JWT
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token manquant' });
    }
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Vérifier que l'user existe toujours
    const { data: user, error } = await db
      .from('users')
      .select('id, name, email, role, active')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) return res.status(401).json({ error: 'Utilisateur introuvable' });
    if (!user.active)  return res.status(401).json({ error: 'Compte désactivé' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expiré', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token invalide' });
  }
};

// ── Vérifier rôle admin
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé — Admin requis' });
  }
  next();
};

// ── Vérifier rôle partenaire ou admin
const requirePartner = (req, res, next) => {
  if (!['partner', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Accès refusé — Partenaire requis' });
  }
  next();
};

// ── Optionnel (pas d'erreur si pas de token)
const optionalAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const token = header.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const { data: user } = await db.from('users').select('id, name, email, role').eq('id', decoded.userId).single();
      req.user = user;
    }
  } catch {}
  next();
};

// ── Générer tokens
const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );
  return { accessToken, refreshToken };
};

module.exports = { authenticate, requireAdmin, requirePartner, optionalAuth, generateTokens };
