const express = require('express');
const bcrypt  = require('bcryptjs');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const i18n = require('../services/i18nService');

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
  // ✅ V14.5.3 i18n : résoudre la langue de l'user
  const L = await i18n.getUserLang(req.user.id);

  // Validation
  if (!new_password) {
    return res.status(400).json({ error: await i18n.t('users_pwd_required', L, 'Nouveau mot de passe requis') });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: await i18n.t('users_pwd_too_short', L, 'Mot de passe trop court — minimum 8 caractères') });
  }
  if (!/\d/.test(new_password)) {
    return res.status(400).json({ error: await i18n.t('users_pwd_need_digit', L, 'Le mot de passe doit contenir au moins 1 chiffre') });
  }

  // Hash le nouveau mot de passe
  const password_hash = await bcrypt.hash(new_password, 10);

  // Update DB
  const { error } = await db.from('users')
    .update({ password_hash, updated_at: new Date() })
    .eq('id', req.user.id);

  if (error) {
    console.log('[change-password] Update error:', error.message);
    return res.status(500).json({ error: await i18n.t('users_pwd_update_failed', L, 'Impossible de mettre à jour le mot de passe') });
  }

  console.log('[change-password] User', req.user.id, '— mot de passe changé');

  res.json({ message: await i18n.t('users_pwd_updated', L, 'Mot de passe mis à jour avec succès') });
}));

// ─── V14.3 : PATCH /api/users/preferred-lang — Sauvegarder langue préférée ──
// Appelé par LanguageContext.setLang() côté frontend
// Permet aux notifications push d'être traduites côté backend (style Booking/Airbnb)
router.patch('/preferred-lang', authenticate, asyncHandler(async (req, res) => {
  const { lang } = req.body;

  // Validation : seules les langues actives ZUKAGO sont acceptées
  const VALID_LANGS = ['fr', 'en', 'de'];
  if (!lang || !VALID_LANGS.includes(lang)) {
    // ✅ V14.5.3 i18n : si lang invalide, utiliser celle déjà enregistrée
    const L = await i18n.getUserLang(req.user.id);
    return res.status(400).json({
      error: await i18n.t('users_lang_invalid', L, 'Langue invalide. Valeurs autorisées : fr, en, de')
    });
  }

  // Update DB
  const { error } = await db.from('users')
    .update({ preferred_lang: lang, updated_at: new Date() })
    .eq('id', req.user.id);

  if (error) {
    console.log('[preferred-lang] Update error:', error.message);
    // ✅ V14.5.3 i18n : utiliser la nouvelle lang demandée pour l'erreur
    // (l'user veut basculer en EN, on lui parle en EN même si l'update DB échoue)
    return res.status(500).json({ error: await i18n.t('users_lang_save_failed', lang, 'Impossible de sauvegarder la langue') });
  }

  console.log('[preferred-lang] User', req.user.id, '→', lang);

  res.json({ ok: true, lang });
}));

// ═══════════════════════════════════════════════════════════════════════════
// ✅ V14.7.0 Bug B/J — GET /api/users/profile-badges
// ═══════════════════════════════════════════════════════════════════════════
// Endpoint agrégé pour les compteurs unread/pending par sous-section du Profil.
//
// Pourquoi un seul endpoint ?
//   - Évite 4 calls API séparés depuis ProfileScreen
//   - 1 round-trip réseau au lieu de 4 → meilleure perf
//   - Tolérance aux pannes : try/catch par section, retourne 0 en cas d'erreur
//
// Retour :
//   {
//     conversations: 3,        // messages non lus (messages.read=false)
//     notifications: 5,        // notifs non lues (notifications.read=false)
//     bookings_pending: 2,     // bookings status='pending' (partner pas encore confirmé)
//     payments_pending: 0      // paiements en attente
//   }
// ─── GET /api/users/profile-badges ────────────────────────────────────────────
router.get('/profile-badges', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const badges = {
    conversations:    0,
    notifications:    0,
    bookings_pending: 0,
    payments_pending: 0,
  };

  // 1) Conversations (messages non lus reçus)
  try {
    const { count } = await db.from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('receiver_id', userId)
      .eq('read', false);
    badges.conversations = count || 0;
  } catch (e) {
    console.log('[profile-badges] conversations error:', e.message);
  }

  // 2) Notifications non lues
  try {
    const { count } = await db.from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('read', false);
    badges.notifications = count || 0;
  } catch (e) {
    console.log('[profile-badges] notifications error:', e.message);
  }

  // 3) Bookings en attente côté CLIENT (réservations pending = partner pas encore confirmé)
  try {
    const { count } = await db.from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'pending');
    badges.bookings_pending = count || 0;
  } catch (e) {
    console.log('[profile-badges] bookings error:', e.message);
  }

  // 4) Paiements en attente
  try {
    const { count } = await db.from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('payment', 'pending');
    badges.payments_pending = count || 0;
  } catch (e) {
    console.log('[profile-badges] payments error:', e.message);
  }

  res.json(badges);
}));

module.exports = router;
