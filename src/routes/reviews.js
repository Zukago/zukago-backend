/**
 * ZUKAGO — routes/reviews.js
 * Système d'avis — POST + GET
 */

const express = require('express');
const db      = require('../config/database');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { asyncHandler }               = require('../middleware/errorHandler');

const router = express.Router();

// ─── GET /api/reviews/by-service — Avis groupés par type d'annonce ──────────
// V13.5 : permet au HomeScreen d'afficher des avis filtrés selon l'onglet actif
// Renvoie { apt: [...], hotel: [...], voiture: [...], cha: [...], cov: [...] }
// Chaque avis est joint à users(name, avatar) et listings(type, city)
// Limite : 6 avis par service, uniquement visible=true et verified=true
router.get('/by-service', optionalAuth, asyncHandler(async (req, res) => {
  const { data: rows, error } = await db.from('reviews')
    .select('id, rating, comment, verified, created_at, users(name, avatar), listings(type)')
    .eq('visible', true)
    .eq('verified', true)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('[GET /reviews/by-service] error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Grouper par type d'annonce, max 6 par service
  const MAX_PER_SERVICE = 6;
  const grouped = {};
  (rows || []).forEach(r => {
    const type = r.listings?.type;
    if (!type) return;
    if (!grouped[type]) grouped[type] = [];
    if (grouped[type].length >= MAX_PER_SERVICE) return;

    // Normaliser users (Supabase renvoie array ou objet selon contexte)
    const usersJoin = Array.isArray(r.users) ? r.users[0] : r.users;

    grouped[type].push({
      id: r.id,
      rating: Number(r.rating) || 0,
      comment: typeof r.comment === 'string' ? r.comment : '',
      verified: !!r.verified,
      created_at: r.created_at,
      // Champs aplatis pour le frontend (évite tout objet imbriqué hasardeux)
      name: typeof usersJoin?.name === 'string' ? usersJoin.name : 'Client',
      avatar: typeof usersJoin?.avatar === 'string' ? usersJoin.avatar : null,
      // ✅ FIX V13.5.2 : la table listings n'a que city_code (FK), pas de label.
      // On laisse city vide pour l'instant — le ReviewCard gère ce cas (n'affiche rien)
      city: '',
    });
  });

  res.json({ reviewsByService: grouped });
}));

// ─── GET /api/reviews/listing/:id — Avis d'une annonce ──────────────────────
router.get('/listing/:id', optionalAuth, asyncHandler(async (req, res) => {
  const { data: reviews, error } = await db.from('reviews')
    .select('*, users(name, avatar)')
    .eq('listing_id', req.params.id)
    .eq('visible', true)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const list = reviews || [];
  const average = list.length
    ? (list.reduce((s, r) => s + r.rating, 0) / list.length).toFixed(1)
    : null;

  res.json({ reviews: list, average, count: list.length });
}));

// ─── POST /api/reviews — Créer un avis ───────────────────────────────────────
router.post('/', authenticate, asyncHandler(async (req, res) => {
  const { listing_id, rating, comment } = req.body;

  // Validation
  if (!listing_id) return res.status(400).json({ error: 'listing_id requis' });
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Note invalide (1-5)' });
  if (!comment || comment.trim().length < 10)
    return res.status(400).json({ error: 'Commentaire trop court (min. 10 caractères)' });

  // ✅ V13.5.5 : récupérer le listing pour gérer le cas covoit (date + conducteur)
  const { data: listingMeta } = await db.from('listings')
    .select('type, depart_date, partners(user_id)')
    .eq('id', listing_id)
    .single();

  // ✅ V13.5.5 : pour covoit, le trajet doit être passé (depart_date < aujourd'hui)
  if (listingMeta?.type === 'cov') {
    if (!listingMeta.depart_date) {
      return res.status(400).json({ error: 'Trajet sans date de départ.' });
    }
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (String(listingMeta.depart_date).slice(0, 10) >= today) {
      return res.status(403).json({
        error: 'Vous pourrez laisser un avis après la date du trajet.'
      });
    }
  }

  // Vérifier que l'utilisateur a une réservation confirmée pour cette annonce
  const { data: booking } = await db.from('bookings')
    .select('id')
    .eq('listing_id', listing_id)
    .eq('user_id', req.user.id)
    .in('status', ['confirmed'])
    .limit(1)
    .single();

  if (!booking) {
    return res.status(403).json({
      error: 'Vous devez avoir une réservation confirmée pour laisser un avis.'
    });
  }

  // Vérifier qu'il n'a pas déjà laissé un avis (1 avis max par voyage / annonce)
  const { data: existing } = await db.from('reviews')
    .select('id')
    .eq('listing_id', listing_id)
    .eq('user_id', req.user.id)
    .single();

  if (existing) {
    return res.status(409).json({ error: 'Vous avez déjà laissé un avis pour cette annonce.' });
  }

  // ✅ V13.5.5 : pour covoit, l'avis cible aussi le conducteur (target_user_id)
  // Pour les autres types, target_user_id reste null (l'avis est sur l'annonce)
  const targetUserIdForReview = (listingMeta?.type === 'cov')
    ? (listingMeta.partners?.user_id || null)
    : null;

  // Insérer l'avis
  const { data: review, error } = await db.from('reviews').insert({
    listing_id,
    user_id:  req.user.id,
    rating:   Number(rating),
    comment:  comment.trim(),
    visible:  true,
    verified: true, // réservation vérifiée ci-dessus
    target_user_id: targetUserIdForReview,
  }).select('*, users(name, avatar)').single();

  if (error) {
    console.error('Review insert error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Notifier le partenaire / conducteur
  try {
    const { data: listing } = await db.from('listings')
      .select('title, partners(user_id)')
      .eq('id', listing_id)
      .single();

    if (listing?.partners?.user_id) {
      await db.from('notifications').insert({
        user_id: listing.partners.user_id,
        title:   '⭐ Nouvel avis reçu !',
        body:    `${req.user.name} a laissé un avis ${rating}/5 sur "${listing.title}"`,
        type:    'review',
      });
    }
  } catch (e) { console.log('Review notif error:', e.message); }

  res.status(201).json({ review, message: 'Avis publié avec succès.' });
}));

// ─── DELETE /api/reviews/:id — Supprimer (admin) ─────────────────────────────
router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Non autorisé' });

  await db.from('reviews').update({ visible: false }).eq('id', req.params.id);
  res.json({ message: 'Avis masqué.' });
}));

module.exports = router;
