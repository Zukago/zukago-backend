const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const commissionService = require('../services/commissionService');
const emailService = require('../services/emailService');

const router = express.Router();

// ── Générer code de réservation unique
const generateCode = () => 'ZKG-' + Math.random().toString(36).substring(2, 8).toUpperCase();

// ─── POST /api/bookings — Créer réservation ───────────────────────────────────
router.post('/', authenticate, [
  body('listing_id').isUUID(),
  body('start_date').isDate(),
  body('end_date').isDate(),
  body('payment_method').isIn(['mtn', 'orange', 'card', 'paypal']),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { listing_id, start_date, end_date, payment_method, notes } = req.body;

  // Récupérer l'annonce
  const { data: listing } = await db.from('listings')
    .select('*, partners(id, user_id)')
    .eq('id', listing_id)
    .eq('status', 'active')
    .single();

  if (!listing) return res.status(404).json({ error: 'Annonce introuvable ou inactive' });

  // Calculer le nombre de nuits/jours
  const start  = new Date(start_date);
  const end    = new Date(end_date);
  const nights = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

  if (nights <= 0) return res.status(400).json({ error: 'Dates invalides' });
  if (nights < (listing.min_nights || 1)) {
    return res.status(400).json({ error: `Séjour minimum : ${listing.min_nights} nuit(s)` });
  }

  // Vérifier disponibilité (pas de chevauchement)
  const { data: conflicts } = await db.from('bookings')
    .select('id')
    .eq('listing_id', listing_id)
    .in('status', ['confirmed', 'pending'])
    .or(`start_date.lte.${end_date},end_date.gte.${start_date}`);

  if (conflicts?.length) {
    return res.status(409).json({ error: 'Ces dates ne sont pas disponibles' });
  }

  // ── Calculer commission (§3.7 : taux vient de la DB)
  const calc = await commissionService.calculate(
    Number(listing.price),
    nights,
    listing.partners?.id
  );

  // Créer la réservation
  const { data: booking, error } = await db.from('bookings').insert({
    code:            generateCode(),
    user_id:         req.user.id,
    listing_id,
    start_date,
    end_date,
    nights,
    price_per_night: calc.pricePerNight,
    subtotal:        calc.subtotal,
    service_fee:     calc.serviceFee,
    total:           calc.total,
    commission:      calc.commission,
    partner_gets:    calc.partnerGets,
    status:          'pending',
    payment_method,
    notes,
  }).select().single();

  if (error) throw new Error(error.message);

  // Enregistrer commission en DB
  await commissionService.record(booking.id, listing.partners.id, calc.commission, calc.commissionRate);

  // Récupérer infos user et partenaire pour emails
  const { data: user }    = await db.from('users').select('name, email').eq('id', req.user.id).single();
  const { data: partner } = await db.from('users').select('name, email, whatsapp').eq('id', listing.partners.user_id).single();

  // Emails automatiques
  await Promise.all([
    emailService.sendBookingConfirmation(user, booking, listing),
    emailService.sendNewBookingToPartner(partner, booking, listing, user),
  ]);

  res.status(201).json({
    booking,
    commission: {
      rate: calc.commissionRate,
      amount: calc.commission,
      partnerGets: calc.partnerGets,
    },
    message: 'Réservation créée. Procédez au paiement.',
  });
}));

// ─── GET /api/bookings/mine — Mes réservations ────────────────────────────────
router.get('/mine', authenticate, asyncHandler(async (req, res) => {
  const { data: bookings } = await db.from('bookings')
    .select('*, listings(title, city_code, price, emoji, gradient_from, gradient_to, listing_photos(url, is_main))')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  res.json({ bookings: bookings || [] });
}));

// ─── GET /api/bookings/:id — Détail réservation ───────────────────────────────
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  const { data: booking } = await db.from('bookings')
    .select('*, listings(*, listing_photos(url, is_main), partners(users(name, avatar)))')
    .eq('id', req.params.id)
    .single();

  if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });
  if (booking.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Non autorisé' });
  }

  res.json({ booking });
}));

// ─── PATCH /api/bookings/:id/confirm — Confirmer après paiement ───────────────
router.patch('/:id/confirm', authenticate, asyncHandler(async (req, res) => {
  const { payment_ref } = req.body;

  const { data: booking } = await db.from('bookings')
    .select('*, listings(partner_id)').eq('id', req.params.id).single();

  if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });
  if (booking.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });

  // Mettre à jour statut
  const { data: updated } = await db.from('bookings')
    .update({ status: 'confirmed', payment_status: 'paid', payment_ref })
    .eq('id', req.params.id)
    .select().single();

  // Marquer commission
  await commissionService.markPaid(req.params.id);

  // Créditer le partenaire
  await commissionService.creditPartner(booking.listings.partner_id, booking.partner_gets);

  res.json({ booking: updated });
}));

// ─── DELETE /api/bookings/:id — Annuler ───────────────────────────────────────
router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
  const { data: booking } = await db.from('bookings').select('*').eq('id', req.params.id).single();
  if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });
  if (booking.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  if (booking.status === 'completed') return res.status(400).json({ error: 'Réservation déjà terminée' });

  await db.from('bookings').update({ status: 'cancelled' }).eq('id', req.params.id);
  res.json({ message: 'Réservation annulée' });
}));

module.exports = router;
