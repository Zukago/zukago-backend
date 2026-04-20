/**
 * ZUKAGO — routes/reviews.js
 * Système d'avis — POST + GET
 */

const express = require('express');
const db      = require('../config/database');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { asyncHandler }               = require('../middleware/errorHandler');

const router = express.Router();

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

  // Vérifier qu'il n'a pas déjà laissé un avis
  const { data: existing } = await db.from('reviews')
    .select('id')
    .eq('listing_id', listing_id)
    .eq('user_id', req.user.id)
    .single();

  if (existing) {
    return res.status(409).json({ error: 'Vous avez déjà laissé un avis pour cette annonce.' });
  }

  // Insérer l'avis
  const { data: review, error } = await db.from('reviews').insert({
    listing_id,
    user_id:  req.user.id,
    rating:   Number(rating),
    comment:  comment.trim(),
    visible:  true,
    verified: true, // réservation vérifiée ci-dessus
  }).select('*, users(name, avatar)').single();

  if (error) {
    console.error('Review insert error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Notifier le partenaire
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
