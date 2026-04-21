const express = require('express');
const bcrypt  = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db      = require('../config/database');
const { generateTokens, authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const emailService = require('../services/emailService');

const router = express.Router();

// ─── POST /api/auth/register ─────────────────────────────────────────────────
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Nom requis'),
  body('email').isEmail().normalizeEmail().withMessage('Email invalide'),
  body('password').isLength({ min: 6 }).withMessage('Mot de passe minimum 6 caractères'),
  body('role').optional().isIn(['client', 'partner']),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, email, password, role = 'client' } = req.body;

  // Vérifier si email existe
  const { data: existing } = await db.from('users').select('id').eq('email', email).single();
  if (existing) return res.status(409).json({ error: 'Email déjà utilisé' });

  // Hasher password
  const hashedPassword = await bcrypt.hash(password, 12);

  // Créer user
  const { data: user, error } = await db.from('users').insert({
    name, email,
    password: hashedPassword,
    role,
    provider: 'email',
  }).select('id, name, email, role').single();

  if (error) throw new Error(error.message);

  // Si partenaire → créer entrée partners
  if (role === 'partner') {
    await db.from('partners').insert({ user_id: user.id, type: 'proprietaire', status: 'pending' });
  }

  // Envoyer email de bienvenue
  await emailService.sendWelcome(user);

  const tokens = generateTokens(user.id);
  await db.from('users').update({ refresh_token: tokens.refreshToken }).eq('id', user.id);

  res.status(201).json({ user, ...tokens });
}));

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;

  const { data: user } = await db
    .from('users')
    .select('id, name, email, role, password, active, avatar')
    .eq('email', email)
    .single();

  if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  if (!user.active) return res.status(401).json({ error: 'Compte désactivé' });
  if (!user.password) return res.status(401).json({ error: 'Utilisez la connexion Google' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

  const tokens = generateTokens(user.id);
  await db.from('users').update({ refresh_token: tokens.refreshToken }).eq('id', user.id);

  const { password: _, ...userSafe } = user;
  res.json({ user: userSafe, ...tokens });
}));

// ─── POST /api/auth/google ────────────────────────────────────────────────────
// Accepte soit un googleToken (id_token) à vérifier, soit name+email directs
router.post('/google', asyncHandler(async (req, res) => {
  const { googleToken, name, email, avatar } = req.body;

  let verifiedEmail = email;
  let verifiedName  = name;
  let verifiedAvatar = avatar;

  // Si un googleToken est fourni, le vérifier via Google tokeninfo
  if (googleToken) {
    try {
      const verifyRes  = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`);
      const verifyData = await verifyRes.json();

      if (verifyData.error) {
        return res.status(401).json({ error: 'Token Google invalide' });
      }

      // Vérifier que le token est pour notre app
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (clientId && verifyData.aud !== clientId) {
        return res.status(401).json({ error: 'Token Google non autorisé' });
      }

      verifiedEmail  = verifyData.email;
      verifiedName   = verifyData.name  || verifyData.email?.split('@')[0];
      verifiedAvatar = verifyData.picture;
    } catch (e) {
      console.log('Google token verify error:', e.message);
      return res.status(401).json({ error: 'Impossible de vérifier le token Google' });
    }
  }

  if (!verifiedEmail) return res.status(400).json({ error: 'Email Google manquant' });

  // Chercher ou créer user
  let { data: user } = await db.from('users').select('*').eq('email', verifiedEmail).single();

  if (!user) {
    const { data: newUser, error } = await db.from('users').insert({
      name:     verifiedName  || verifiedEmail.split('@')[0],
      email:    verifiedEmail,
      avatar:   verifiedAvatar,
      provider: 'google',
      role:     'client',
      verified: true,
    }).select('id, name, email, role, avatar').single();

    if (error) throw new Error(error.message);
    user = newUser;
    try { await emailService.sendWelcome(user); } catch(e) {}
  } else {
    // Mettre à jour l'avatar si disponible
    if (verifiedAvatar && !user.avatar) {
      await db.from('users').update({ avatar: verifiedAvatar }).eq('id', user.id);
    }
  }

  const tokens = generateTokens(user.id);
  await db.from('users').update({ refresh_token: tokens.refreshToken }).eq('id', user.id);

  const { password: _, ...userSafe } = user;
  res.json({ user: userSafe, ...tokens });
}));

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token manquant' });

  const { data: user } = await db.from('users')
    .select('id, name, email, role')
    .eq('refresh_token', refreshToken)
    .single();

  if (!user) return res.status(401).json({ error: 'Refresh token invalide' });

  const tokens = generateTokens(user.id);
  await db.from('users').update({ refresh_token: tokens.refreshToken }).eq('id', user.id);

  res.json({ user, ...tokens });
}));

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await db.from('users').update({ refresh_token: null }).eq('id', req.user.id);
  res.json({ message: 'Déconnecté avec succès' });
}));

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { data: user } = await db.from('users')
    .select('id, name, email, role, avatar, phone, whatsapp, verified, created_at')
    .eq('id', req.user.id)
    .single();
  res.json({ user });
}));

module.exports = router;
