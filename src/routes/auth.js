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

  // ⚠️ NE PAS créer de ligne partners à l'inscription
  // Le user doit soumettre sa demande via POST /partners/request pour que :
  //   - la ligne partners soit créée
  //   - demande_verified passe à true
  //   - admin puisse voir la demande dans le dashboard

  // ✅ V13.5 : envoyer email de VÉRIFICATION (avec lien token), pas juste bienvenue
  try {
    await emailService.sendVerification(user, verifyToken);
    console.log('[Auth Register] Email de vérification envoyé à', user.email);
  } catch(e) {
    console.log('[Auth Register] ❌ Erreur envoi email vérification:', e.message);
    // On continue même si email échoue — l'utilisateur peut redemander plus tard
  }

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

// ✅ V13.5 : POST /api/auth/resend-verification — renvoyer email de vérification
router.post('/resend-verification', authenticate, asyncHandler(async (req, res) => {
  const { data: user } = await db.from('users')
    .select('id, name, email, verified')
    .eq('id', req.user.id)
    .single();

  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (user.verified) return res.status(400).json({ error: 'Email déjà vérifié' });

  // Générer un nouveau token
  const verifyToken   = crypto.randomBytes(32).toString('hex');
  const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.from('users').update({
    verify_token:   verifyToken,
    verify_expires: verifyExpires,
  }).eq('id', user.id);

  try {
    await emailService.sendVerification(user, verifyToken);
    console.log('[Auth Resend] Email de vérification renvoyé à', user.email);
  } catch(e) {
    console.log('[Auth Resend] ❌ Erreur:', e.message);
    return res.status(500).json({ error: 'Impossible d\'envoyer l\'email pour le moment' });
  }

  res.json({ message: 'Email de vérification renvoyé' });
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
    // ✅ V13.5 : Google login = email déjà vérifié par Google → email de bienvenue (pas de vérification)
    try {
      await emailService.sendWelcome(user);
      console.log('[Auth Google] Email bienvenue envoyé à', user.email);
    } catch(e) {
      console.log('[Auth Google] ❌ Erreur envoi email bienvenue:', e.message);
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// V14.0.1 — MOT DE PASSE OUBLIÉ (flow OTP 6 chiffres, mobile-first)
// ═══════════════════════════════════════════════════════════════════════════
// Flow en 3 étapes :
//   1. POST /forgot-password   → user demande, reçoit un code 6 chiffres par email
//   2. POST /verify-reset-code → user envoie le code, reçoit un reset_ticket (JWT 5 min)
//   3. POST /reset-password    → user envoie ticket + nouveau mdp → auto-login
//
// Sécurité (style banque) :
//   - Code chiffré bcrypt en BDD (jamais en clair)
//   - Expiration 30 min, max 5 tentatives
//   - Rate limit 3 demandes / heure / email
//   - Réponse générique (ne révèle pas si l email existe)
//   - Reset → invalidation de TOUS les refresh_tokens (déconnecte tous les appareils)
// ═══════════════════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');

// Rate limit forgot-password : 3 demandes / heure / IP+email
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Trop de demandes. Reessayez dans 1 heure.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}_${req.body?.email || 'unknown'}`,
});

// Rate limit verify-reset-code : 10 tentatives / 15 min / IP+email
const verifyResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives. Reessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}_${req.body?.email || 'unknown'}`,
});

// POST /api/auth/forgot-password
// Demande l'envoi d'un code 6 chiffres par email
router.post('/forgot-password', forgotPasswordLimiter, [
  body('email').isEmail().normalizeEmail().withMessage('Email invalide'),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email } = req.body;

  // Réponse générique systématique (anti-énumération)
  const genericResponse = {
    message: 'Si un compte existe pour cet email, un code a ete envoye.',
  };

  // Chercher le user
  const { data: user } = await db.from('users')
    .select('id, name, email, password, active')
    .eq('email', email)
    .maybeSingle();

  // Si pas de user OU compte désactivé OU compte Google-only (pas de password) → réponse générique sans rien faire
  if (!user || !user.active || !user.password) {
    console.log('[ForgotPassword] Demande pour email inexistant/inactif/google-only:', email);
    return res.json(genericResponse);
  }

  try {
    // Générer code 6 chiffres
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    // Invalider tous les codes pending de cet email (sécurité)
    await db.from('password_reset_codes')
      .update({ used: true })
      .eq('email', email)
      .eq('used', false);

    // Insérer le nouveau code
    const { error: insertError } = await db.from('password_reset_codes').insert({
      email,
      code_hash:  codeHash,
      expires_at: expiresAt.toISOString(),
      attempts:   0,
      used:       false,
    });

    if (insertError) {
      console.log('[ForgotPassword] Erreur insertion code:', insertError.message);
      return res.json(genericResponse); // toujours générique
    }

    // Envoyer le code par email
    try {
      await emailService.sendPasswordReset(user, code);
      console.log('[ForgotPassword] Code envoye a', user.email);
    } catch (e) {
      console.log('[ForgotPassword] Erreur envoi email:', e.message);
      // On répond quand même OK pour pas révéler l'erreur
    }
  } catch (e) {
    console.log('[ForgotPassword] Erreur generale:', e.message);
  }

  return res.json(genericResponse);
}));

// POST /api/auth/verify-reset-code
// Vérifie le code 6 chiffres et retourne un reset_ticket (JWT 5 min)
router.post('/verify-reset-code', verifyResetLimiter, [
  body('email').isEmail().normalizeEmail().withMessage('Email invalide'),
  body('code').isLength({ min: 6, max: 6 }).matches(/^\d{6}$/).withMessage('Code invalide'),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, code } = req.body;

  // Chercher le code le plus récent non utilisé pour cet email
  const { data: row } = await db.from('password_reset_codes')
    .select('id, code_hash, expires_at, attempts, used')
    .eq('email', email)
    .eq('used', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) {
    return res.status(400).json({ error: 'Code invalide ou expire' });
  }

  // Vérifier expiration
  if (new Date(row.expires_at) < new Date()) {
    await db.from('password_reset_codes').update({ used: true }).eq('id', row.id);
    return res.status(400).json({ error: 'Code expire. Demandez un nouveau code.' });
  }

  // Vérifier le nombre de tentatives (max 5)
  if (row.attempts >= 5) {
    await db.from('password_reset_codes').update({ used: true }).eq('id', row.id);
    return res.status(429).json({ error: 'Trop de tentatives. Demandez un nouveau code.' });
  }

  // Incrémenter attempts AVANT le compare (pour pénaliser même les échecs)
  await db.from('password_reset_codes')
    .update({ attempts: row.attempts + 1 })
    .eq('id', row.id);

  // Vérifier le code
  const valid = await bcrypt.compare(code, row.code_hash);
  if (!valid) {
    const remaining = Math.max(0, 5 - (row.attempts + 1));
    return res.status(400).json({
      error: remaining > 0
        ? `Code incorrect. ${remaining} tentative(s) restante(s).`
        : 'Code incorrect. Demandez un nouveau code.',
    });
  }

  // Code valide → générer un reset_ticket JWT (5 min, scope password_reset)
  const resetTicket = jwt.sign(
    { email, codeId: row.id, scope: 'password_reset' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );

  console.log('[VerifyResetCode] Code valide pour', email);
  res.json({ reset_ticket: resetTicket, expires_in: 300 });
}));

// POST /api/auth/reset-password
// Vérifie le ticket, change le mot de passe, déconnecte tous les appareils, auto-login
router.post('/reset-password', [
  body('reset_ticket').notEmpty().withMessage('Ticket manquant'),
  body('new_password')
    .isLength({ min: 8 }).withMessage('Mot de passe minimum 8 caracteres')
    .matches(/\d/).withMessage('Le mot de passe doit contenir au moins 1 chiffre'),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { reset_ticket, new_password } = req.body;

  // Vérifier le ticket
  let payload;
  try {
    payload = jwt.verify(reset_ticket, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Ticket invalide ou expire. Recommencez la procedure.' });
  }

  if (payload?.scope !== 'password_reset' || !payload?.email) {
    return res.status(401).json({ error: 'Ticket invalide.' });
  }

  const { email, codeId } = payload;

  // Vérifier que le code n'a pas déjà été utilisé (anti-replay)
  if (codeId) {
    const { data: codeRow } = await db.from('password_reset_codes')
      .select('used')
      .eq('id', codeId)
      .maybeSingle();
    if (codeRow?.used) {
      return res.status(401).json({ error: 'Ticket deja utilise. Recommencez la procedure.' });
    }
  }

  // Récupérer le user
  const { data: user } = await db.from('users')
    .select('id, name, email, role, avatar, active, verified, demande_verified')
    .eq('email', email)
    .maybeSingle();

  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (!user.active) return res.status(401).json({ error: 'Compte desactive. Contactez le support.' });

  // Hasher le nouveau mot de passe
  const hashedPassword = await bcrypt.hash(new_password, 12);

  // ✅ Style banque : changer le mdp ET invalider TOUS les refresh tokens
  // (déconnecte le user de tous ses appareils par sécurité)
  const { error: updateError } = await db.from('users').update({
    password:               hashedPassword,
    refresh_token:          null,
    refresh_token_expires:  null,
  }).eq('id', user.id);

  if (updateError) {
    console.log('[ResetPassword] Erreur update user:', updateError.message);
    return res.status(500).json({ error: 'Impossible de mettre a jour le mot de passe.' });
  }

  // Marquer tous les codes pending de cet email comme used (anti-replay)
  await db.from('password_reset_codes')
    .update({ used: true })
    .eq('email', email)
    .eq('used', false);

  // Email de confirmation (best effort, ne bloque pas)
  try {
    await emailService.sendPasswordResetConfirmation(user);
    console.log('[ResetPassword] Email confirmation envoye a', user.email);
  } catch (e) {
    console.log('[ResetPassword] Erreur envoi email confirmation:', e.message);
  }

  // Auto-login : générer nouveaux tokens et les sauvegarder
  const tokens = generateTokens(user.id);
  const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.from('users').update({
    refresh_token:         tokens.refreshToken,
    refresh_token_expires: refreshExpires,
  }).eq('id', user.id);

  console.log('[ResetPassword] Mot de passe change pour', user.email);
  res.json({ user, ...tokens });
}));

module.exports = router;
