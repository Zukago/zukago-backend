const express = require('express');
const bcrypt  = require('bcryptjs');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// ─── GET /api/users/me ────────────────────────────────────────────────────────
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { data: user } = await db.from('users')
    .select('id, name, email, role, avatar, phone, whatsapp, verified, created_at')
    .eq('id', req.user.id).single();
  res.json({ user });
}));

// ─── PATCH /api/users/me — Modifier profil ────────────────────────────────────
router.patch('/me', authenticate, asyncHandler(async (req, res) => {
  const { name, phone, whatsapp, avatar } = req.body;
  const { data: user } = await db.from('users')
    .update({ name, phone, whatsapp, avatar, updated_at: new Date() })
    .eq('id', req.user.id)
    .select('id, name, email, role, avatar, phone, whatsapp').single();
  res.json({ user });
}));

// ─── V14.5 : POST /api/users/change-password — Changer mot de passe ──────────
// User déjà authentifié via JWT, donc pas besoin du current_password
// (sécurité acceptable car l'app vérifie l'auth à chaque requête)
router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const { new_password } = req.body;

  // Validation
  if (!new_password) {
    return res.status(400).json({ error: 'Nouveau mot de passe requis' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Mot de passe trop court — minimum 8 caractères' });
  }
  if (!/\d/.test(new_password)) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 1 chiffre' });
  }

  // Hash le nouveau mot de passe
  const password_hash = await bcrypt.hash(new_password, 10);

  // Update DB
  const { error } = await db.from('users')
    .update({ password_hash, updated_at: new Date() })
    .eq('id', req.user.id);

  if (error) {
    console.log('[change-password] Update error:', error.message);
    return res.status(500).json({ error: 'Impossible de mettre à jour le mot de passe' });
  }

  console.log('[change-password] User', req.user.id, '— mot de passe changé');

  res.json({ message: 'Mot de passe mis à jour avec succès' });
}));

// ─── V14.3 : PATCH /api/users/preferred-lang — Sauvegarder langue préférée ──
// Appelé par LanguageContext.setLang() côté frontend
// Permet aux notifications push d'être traduites côté backend (style Booking/Airbnb)
router.patch('/preferred-lang', authenticate, asyncHandler(async (req, res) => {
  const { lang } = req.body;

  // Validation : seules les langues actives ZUKAGO sont acceptées
  const VALID_LANGS = ['fr', 'en', 'de'];
  if (!lang || !VALID_LANGS.includes(lang)) {
    return res.status(400).json({
      error: 'Langue invalide. Valeurs autorisées : fr, en, de'
    });
  }

  // Update DB
  const { error } = await db.from('users')
    .update({ preferred_lang: lang, updated_at: new Date() })
    .eq('id', req.user.id);

  if (error) {
    console.log('[preferred-lang] Update error:', error.message);
    return res.status(500).json({ error: 'Impossible de sauvegarder la langue' });
  }

  console.log('[preferred-lang] User', req.user.id, '→', lang);

  res.json({ ok: true, lang });
}));

module.exports = router;
