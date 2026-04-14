const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, requireAdmin, optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// ─── GET /api/reviews/listing/:id — Avis d'une annonce ───────────────────────
router.get('/listing/:id', asyncHandler(async (req, res) => {
  const { data: reviews } = await db.from('reviews')
    .select('*, users(name, avatar)')
    .eq('listing_id', req.params.id)
    .order('created_at', { ascending: false });

  const avg = reviews?.length
    ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
    : null;

  res.json({ reviews: reviews || [], average: avg, count: reviews?.length || 0 });
}));

// ─── POST /api/reviews — Publier un avis ─────────────────────────────────────
router.post('/', authenticate, [
  body('listing_id').isUUID(),
  body('rating').isInt({ min: 1, max: 5 }),
  body('comment').optional().trim().isLength({ max: 500 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { listing_id, rating, comment, booking_id } = req.body;

  // Vérifier si déjà noté
  const { data: existing } = await db.from('reviews')
    .select('id').eq('listing_id', listing_id).eq('user_id', req.user.id).single();
  if (existing) return res.status(409).json({ error: 'Vous avez déjà noté cette annonce' });

  // Vérifier si lié à une vraie réservation (avis vérifié)
  let verified = false;
  if (booking_id) {
    const { data: booking } = await db.from('bookings')
      .select('id').eq('id', booking_id).eq('user_id', req.user.id)
      .eq('listing_id', listing_id).eq('status', 'completed').single();
    verified = !!booking;
  }

  const { data: review, error } = await db.from('reviews').insert({
    listing_id, rating, comment,
    user_id: req.user.id,
    booking_id: booking_id || null,
    verified,
  }).select('*, users(name, avatar)').single();

  if (error) throw new Error(error.message);
  res.status(201).json({ review });
}));

// ─── DELETE /api/reviews/:id — Supprimer un avis ─────────────────────────────
router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
  const { data: review } = await db.from('reviews').select('user_id').eq('id', req.params.id).single();
  if (!review) return res.status(404).json({ error: 'Avis introuvable' });

  if (review.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Non autorisé' });
  }

  await db.from('reviews').delete().eq('id', req.params.id);
  res.json({ message: 'Avis supprimé' });
}));

module.exports = router;
