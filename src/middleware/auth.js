const jwt  = require('jsonwebtoken');
const db   = require('../config/database');
const i18n = require('../services/i18nService');

// ✅ V14.5.3 i18n : helper pour résoudre la langue dans les middlewares
// Fallback sur Accept-Language header si pas d'user identifié
async function _resolveLang(req, userId) {
  if (userId) {
    try { return await i18n.getUserLang(userId); } catch (e) {}
  }
  const accept = req.headers['accept-language'] || '';
  const code = accept.split(',')[0]?.slice(0, 2).toLowerCase();
  if (['fr', 'en', 'de'].includes(code)) return code;
  return 'fr';
}

// ── Vérifier token JWT
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      const L = await _resolveLang(req);
      return res.status(401).json({ error: await i18n.t('auth_error_token_missing', L, 'Token manquant') });
    }
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Vérifier que l'user existe toujours
    const { data: user, error } = await db
      .from('users')
      .select('id, name, email, role, active')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      const L = await _resolveLang(req, decoded.userId);
      return res.status(401).json({ error: await i18n.t('auth_error_user_not_found', L, 'Utilisateur introuvable') });
    }
    if (!user.active) {
      const L = await _resolveLang(req, user.id);
      return res.status(401).json({ error: await i18n.t('auth_error_account_disabled', L, 'Compte désactivé') });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      const L = await _resolveLang(req);
      return res.status(401).json({ error: await i18n.t('auth_error_token_expired', L, 'Token expiré'), code: 'TOKEN_EXPIRED' });
    }
    const L = await _resolveLang(req);
    return res.status(401).json({ error: await i18n.t('auth_error_token_invalid', L, 'Token invalide') });
  }
};

// ── Vérifier rôle admin
const requireAdmin = async (req, res, next) => {
  if (req.user?.role !== 'admin') {
    const L = await _resolveLang(req, req.user?.id);
    return res.status(403).json({ error: await i18n.t('auth_error_admin_required', L, 'Accès refusé — Admin requis') });
  }
  next();
};

// ── Vérifier rôle partenaire ou admin
const requirePartner = async (req, res, next) => {
  if (!['partner', 'admin'].includes(req.user?.role)) {
    const L = await _resolveLang(req, req.user?.id);
    return res.status(403).json({ error: await i18n.t('auth_error_partner_required', L, 'Accès refusé — Partenaire requis') });
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
