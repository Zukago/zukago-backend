/**
 * ZUKAGO — routes/auth.js
 * SECURISE :
 * 1. Rate limiting login — 10 tentatives / 15 min
 * 2. Mot de passe minimum 8 caractères + 1 chiffre
 * 3. Refresh token expire après 30 jours
 * 4. Vérification email à l inscription
 */

const express   = require('express');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const db        = require('../config/database');
const { generateTokens, authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const emailService = require('../services/emailService');
const crypto    = require('crypto');

const router = express.Router();

// Rate limit login — 10 tentatives / 15 min par IP+email
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives. Reessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}_${req.body?.email || 'unknown'}`,
});

// Rate limit register — 5 inscriptions / heure par IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de comptes crees. Reessayez dans 1 heure.' },
});

// POST /api/auth/register
router.post('/register', registerLimiter, [
  body('name').trim().notEmpty().withMessage('Nom requis'),
  body('email').isEmail().normalizeEmail().withMessage('Email invalide'),
  body('password')
    .isLength({ min: 8 }).withMessage('Mot de passe minimum 8 caracteres')
    .matches(/\d/).withMessage('Le mot de passe doit contenir au moins 1 chiffre'),
  body('role').optional().isIn(['client', 'partner']),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, email, password, role = 'client' } = req.body;

  const { data: existing } = await db.from('users').select('id').eq('email', email).single();
  if (existing) return res.status(409).json({ error: 'Email deja utilise' });

  const hashedPassword = await bcrypt.hash(password, 12);

  const verifyToken   = crypto.randomBytes(32).toString('hex');
  const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const { data: user, error } = await db.from('users').insert({
    name, email,
    password: hashedPassword,
    role,
    provider:          'email',
    verified:          false,
    demande_verified:  false,
    verify_token:      verifyToken,
    verify_expires:    verifyExpires,
  }).select('id, name, email, role, verified, demande_verified').single();

  if (error) throw new Error(error.message);

  if (role === 'partner') {
    await db.from('partners').insert({ user_id: user.id, type: 'proprietaire', status: 'pending' });
  }

  try { await emailService.sendWelcome(user); } catch(e) {}

  const tokens = generateTokens(user.id);
  const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.from('users').update({
    refresh_token:         tokens.refreshToken,
    refresh_token_expires: refreshExpires,
  }).eq('id', user.id);

  res.status(201).json({ user, ...tokens });
}));

// POST /api/auth/login
router.post('/login', loginLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;

  const { data: user } = await db
    .from('users')
    .select('id, name, email, role, password, active, avatar, verified, demande_verified')
    .eq('email', email)
    .single();

  if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  if (!user.active) return res.status(401).json({ error: 'Compte desactive. Contactez le support.' });
  if (!user.password) return res.status(401).json({ error: 'Utilisez la connexion Google.' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

  const tokens = generateTokens(user.id);
  const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.from('users').update({
    refresh_token:         tokens.refreshToken,
    refresh_token_expires: refreshExpires,
  }).eq('id', user.id);

  const { password: _, ...userSafe } = user;
  res.json({ user: userSafe, ...tokens });
}));

// GET /api/auth/verify-email?token=xxx
router.get('/verify-email', asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token manquant' });

  const { data: user } = await db.from('users')
    .select('id, verify_expires')
    .eq('verify_token', token)
    .single();

  if (!user) return res.status(400).json({ error: 'Token invalide ou deja utilise' });

  if (new Date(user.verify_expires) < new Date()) {
    return res.status(400).json({ error: 'Token expire. Demandez un nouveau lien.' });
  }

  await db.from('users').update({
    verified:       true,
    verify_token:   null,
    verify_expires: null,
  }).eq('id', user.id);

  res.json({ message: 'Email verifie avec succes.' });
}));

// POST /api/auth/google
router.post('/google', asyncHandler(async (req, res) => {
  const { googleToken, name, email, avatar } = req.body;

  let verifiedEmail  = email;
  let verifiedName   = name;
  let verifiedAvatar = avatar;

  if (googleToken) {
    try {
      const verifyRes  = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`);
      const verifyData = await verifyRes.json();
      if (verifyData.error) return res.status(401).json({ error: 'Token Google invalide' });
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (clientId && verifyData.aud !== clientId) return res.status(401).json({ error: 'Token Google non autorise' });
      verifiedEmail  = verifyData.email;
      verifiedName   = verifyData.name || verifyData.email?.split('@')[0];
      verifiedAvatar = verifyData.picture;
    } catch (e) {
      return res.status(401).json({ error: 'Impossible de verifier le token Google' });
    }
  }

  if (!verifiedEmail) return res.status(400).json({ error: 'Email Google manquant' });

  let { data: user } = await db.from('users').select('*').eq('email', verifiedEmail).single();

  if (!user) {
    const { data: newUser, error } = await db.from('users').insert({
      name:              verifiedName || verifiedEmail.split('@')[0],
      email:             verifiedEmail,
      avatar:            verifiedAvatar,
      provider:          'google',
      role:              'client',
      verified:          true,
      demande_verified:  false,
    }).select('id, name, email, role, avatar, verified, demande_verified').single();
    if (error) throw new Error(error.message);
    user = newUser;
    try { await emailService.sendWelcome(user); } catch(e) {}
  } else {
    if (verifiedAvatar && !user.avatar) {
      await db.from('users').update({ avatar: verifiedAvatar }).eq('id', user.id);
    }
  }

  const tokens = generateTokens(user.id);
  const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.from('users').update({
    refresh_token:         tokens.refreshToken,
    refresh_token_expires: refreshExpires,
  }).eq('id', user.id);

  const { password: _, ...userSafe } = user;
  res.json({ user: userSafe, ...tokens });
}));

// POST /api/auth/refresh
router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token manquant' });

  const { data: user } = await db.from('users')
    .select('id, name, email, role, refresh_token_expires')
    .eq('refresh_token', refreshToken)
    .single();

  if (!user) return res.status(401).json({ error: 'Refresh token invalide' });

  if (user.refresh_token_expires && new Date(user.refresh_token_expires) < new Date()) {
    await db.from('users').update({ refresh_token: null }).eq('id', user.id);
    return res.status(401).json({ error: 'Session expiree. Reconnectez-vous.' });
  }

  const tokens = generateTokens(user.id);
  const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.from('users').update({
    refresh_token:         tokens.refreshToken,
    refresh_token_expires: refreshExpires,
  }).eq('id', user.id);

  res.json({ user, ...tokens });
}));

// POST /api/auth/logout
router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await db.from('users').update({ refresh_token: null, refresh_token_expires: null }).eq('id', req.user.id);
  res.json({ message: 'Deconnecte avec succes' });
}));

// GET /api/auth/me
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  console.log(`[Auth] GET /me by ${req.user?.email}`);

  // Essai complet
  const { data: user, error } = await db.from('users')
    .select('id, name, email, role, avatar, phone, whatsapp, verified, demande_verified, created_at')
    .eq('id', req.user.id)
    .maybeSingle();

  if (error || !user) {
    console.log(`[Auth] /me fallback - ${error?.message || 'no user'}`);
    // Fallback : seulement colonnes sûres
    const { data: user2 } = await db.from('users')
      .select('id, name, email, role, avatar, verified, demande_verified, created_at')
      .eq('id', req.user.id)
      .maybeSingle();

    if (!user2) return res.status(404).json({ error: 'Utilisateur introuvable' });
    console.log(`[Auth] /me fallback OK - role=${user2.role}, demande_verified=${user2.demande_verified}`);
    return res.json({ user: user2 });
  }

  console.log(`[Auth] /me OK - role=${user.role}, demande_verified=${user.demande_verified}`);
  res.json({ user });
}));

module.exports = router;
