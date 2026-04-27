const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const commissionService = require('../services/commissionService');
const pricingService    = require('../services/pricingService');   // ✅ V13 : calculs polymorphes
const statsService      = require('../services/statsService');
const emailService = require('../services/emailService');

const router = express.Router();

// ── Générer code de réservation unique
const generateCode = () => 'ZKG-' + Math.random().toString(36).substring(2, 8).toUpperCase();

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS V13
// ═══════════════════════════════════════════════════════════════════════════

// ── Construire la requête de conflit selon le type de service
// ✅ V13 fix : .lt + .gt au lieu de .lte + .gte
//    → Le jour de check-out d'une résa et le jour de check-in d'une autre
//    PEUVENT être le même jour (convention hôtelière).
async function checkOverlap(listing, params) {
  const { start_date, end_date, room_type_id, seats_booked } = params;

  // Covoit : pas d'overlap dates, mais check seats_available
  if (listing.type === 'cov') {
    const seats = Number(seats_booked) || 0;
    const avail = Number(listing.seats_available);
    if (!isNaN(avail) && seats > avail) {
      return { conflict: true, reason: `Plus que ${avail} place(s) disponible(s)` };
    }
    return { conflict: false };
  }

  // Driver en heure/halfday : pas de check overlap (multi-bookings possibles)
  // À terme on pourra ajouter un check par pickup_time, mais pas pour cette phase
  if (listing.type === 'driver' && !start_date) {
    return { conflict: false };
  }

  // Apt / Hotel / Car / Driver-jour : check overlap dates avec inégalités strictes
  let query = db.from('bookings')
    .select('id, room_type_id')
    .eq('listing_id', listing.id)
    .in('status', ['confirmed', 'pending'])
    .lt('start_date', end_date)   // ✅ V13 : strict less (pas <=)
    .gt('end_date', start_date);  // ✅ V13 : strict greater (pas >=)

  const { data: conflicts } = await query;

  // Pour hôtel : ne bloquer que si MÊME chambre déjà occupée
  if (listing.type === 'hotel' && room_type_id) {
    const sameRoomConflicts = (conflicts || []).filter(c =>
      Number(c.room_type_id) === Number(room_type_id)
    );
    if (sameRoomConflicts.length) {
      return { conflict: true, reason: 'Cette chambre n\'est pas disponible sur ces dates' };
    }
    return { conflict: false };
  }

  if (conflicts?.length) {
    return { conflict: true, reason: 'Ces dates ne sont pas disponibles' };
  }
  return { conflict: false };
}

// ── Validation min nights/units selon le type
function validateMinUnits(listing, params, calc) {
  const minNights = Number(listing.min_nights) || 1;

  if (listing.type === 'apt' || listing.type === 'hotel') {
    if ((calc.unit_count || 0) < minNights) {
      return `Séjour minimum : ${minNights} nuit(s)`;
    }
  } else if (listing.type === 'car') {
    // Pour voiture : utilise min_nights comme min_days
    if ((calc.unit_count || 0) < minNights) {
      return `Location minimum : ${minNights} jour(s)`;
    }
  } else if (listing.type === 'driver') {
    // Pour chauffeur : minimum 1 unité (heure/halfday/jour)
    if ((calc.unit_count || 0) < 1) {
      return 'Au moins 1 unité requise';
    }
  } else if (listing.type === 'cov') {
    // Pour covoit : minimum 1 place
    if ((calc.unit_count || 0) < 1) {
      return 'Au moins 1 place requise';
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/quote — Preview prix sans rien enregistrer (V13)
// ═══════════════════════════════════════════════════════════════════════════
// Utilisé par le frontend pour afficher le détail prix en temps réel
// quand le client modifie ses paramètres (avec/sans chauffeur, zone, etc.)
router.post('/quote', authenticate, [
  body('listing_id').isUUID(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { listing_id } = req.body;

  // Récupérer le listing
  const { data: listing } = await db.from('listings')
    .select('*, partners(id, user_id)')
    .eq('id', listing_id)
    .eq('status', 'active')
    .single();

  if (!listing) return res.status(404).json({ error: 'Annonce introuvable ou inactive' });

  // Calcul prix via pricingService
  let calc;
  try {
    // Inject partner_id pour que pricingService trouve un éventuel taux custom
    const listingWithPartner = { ...listing, partner_id: listing.partners?.id };
    calc = await pricingService.calculate(listingWithPartner, req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  res.json({ quote: calc });
}));

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings — Créer réservation (V13 polymorphe)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/', authenticate, [
  body('listing_id').isUUID(),
  // ✅ V13.1 : { nullable: true } accepte null en plus de undefined
  body('start_date').optional({ nullable: true, checkFalsy: true }).isDate(),
  body('end_date').optional({ nullable: true, checkFalsy: true }).isDate(),
  body('payment_method').optional({ nullable: true, checkFalsy: true }).isString(),
  body('room_type_id').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
  body('seats_booked').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1, max: 8 }),
  body('unit_type').optional({ nullable: true, checkFalsy: true }).isString(),
  body('unit_count').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
  body('with_driver').optional({ nullable: true }).isBoolean(),
  body('zone').optional({ nullable: true, checkFalsy: true }).isString(),
  body('extras').optional({ nullable: true }).isObject(),
  body('pickup_time').optional({ nullable: true, checkFalsy: true }).isString(),
  body('pickup_location').optional({ nullable: true, checkFalsy: true }).isString(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const {
    listing_id, start_date, end_date, payment_method, notes,
    room_type_id, seats_booked, unit_type, unit_count,
    with_driver, zone, extras, pickup_time, pickup_location,
  } = req.body;

  // Récupérer l'annonce
  const { data: listing } = await db.from('listings')
    .select('*, partners(id, user_id)')
    .eq('id', listing_id)
    .eq('status', 'active')
    .single();

  if (!listing) return res.status(404).json({ error: 'Annonce introuvable ou inactive' });

  // ── Calcul prix via pricingService (V13)
  let calc;
  try {
    const listingWithPartner = { ...listing, partner_id: listing.partners?.id };
    calc = await pricingService.calculate(listingWithPartner, req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // ── Validation min units selon le type
  const minError = validateMinUnits(listing, req.body, calc);
  if (minError) return res.status(400).json({ error: minError });

  // ── Vérifier disponibilité (V13 fix : .lt/.gt + room_type pour hôtel + seats pour cov)
  const overlap = await checkOverlap(listing, req.body);
  if (overlap.conflict) {
    return res.status(409).json({ error: overlap.reason });
  }

  // ── Calcul nights pour compat retro (si dates fournies)
  let nights = 0;
  if (start_date && end_date) {
    const start = new Date(start_date);
    const end   = new Date(end_date);
    nights = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    if (nights <= 0 && (listing.type === 'apt' || listing.type === 'hotel' || listing.type === 'car')) {
      return res.status(400).json({ error: 'Dates invalides' });
    }
  }

  // ── Construire l'objet à insérer
  const insertData = {
    code:            generateCode(),
    user_id:         req.user.id,
    listing_id,
    start_date:      start_date || null,
    end_date:        end_date || null,
    nights:          nights || calc.unit_count || 1,
    price_per_night: Math.round(calc.subtotal / (calc.unit_count || 1)),
    subtotal:        calc.subtotal,
    service_fee:     calc.serviceFee,
    total:           calc.total,
    commission:      calc.commission,
    partner_gets:    calc.partnerGets,
    status:          'pending',
    payment_method:  payment_method || 'pending',
    notes:           notes || '',
    // ✅ V13 : nouvelles colonnes polymorphes
    room_type_id:    room_type_id    || null,
    seats_booked:    seats_booked    || null,
    unit_type:       calc.unit_type  || null,
    unit_count:      calc.unit_count || null,
    with_driver:     with_driver != null ? !!with_driver : null,
    zone:            zone            || null,
    pickup_time:     pickup_time     || null,
    pickup_location: pickup_location || null,
    extras:          extras          || null,
  };

  const { data: booking, error } = await db.from('bookings').insert(insertData).select().single();

  if (error) {
    console.log('Booking insert error:', error.message, error.details);
    throw new Error(error.message);
  }

  // ── Pour covoit : décrémenter seats_available (atomique-ish)
  if (listing.type === 'cov' && seats_booked) {
    try {
      const newSeats = (Number(listing.seats_available) || 0) - Number(seats_booked);
      await db.from('listings')
        .update({ seats_available: Math.max(0, newSeats) })
        .eq('id', listing_id);
    } catch (e) { console.log('Seats decrement error:', e.message); }
  }

  // Enregistrer commission et notifier (non bloquant)
  try {
    await commissionService.record(booking.id, listing.partners?.id, calc.commission, calc.commissionRate);
  } catch(e) { console.log('Commission record error:', e.message); }

  // Mettre à jour stats_daily (non bloquant)
  statsService.updateDay();

  // ── Notification au partenaire (V13 : sans emoji UI)
  try {
    await db.from('notifications').insert({
      user_id: listing.partners?.user_id,
      title: 'Nouvelle réservation',
      body: `${req.user.name || 'Un client'} a réservé "${listing.title}"${start_date ? ` du ${start_date} au ${end_date}` : ''}`,
      type: 'booking',
    });
  } catch(e) { console.log('Notif error:', e.message); }

  // Emails (non bloquants)
  try {
    const { data: user }    = await db.from('users').select('name, email').eq('id', req.user.id).single();
    const { data: partner } = await db.from('users').select('name, email').eq('id', listing.partners?.user_id).single();
    if (user && partner) {
      await Promise.all([
        emailService.sendBookingConfirmation(user, booking, listing).catch(()=>{}),
        emailService.sendNewBookingToPartner(partner, booking, listing, user).catch(()=>{}),
      ]);
    }
  } catch(e) { console.log('Email error:', e.message); }

  res.status(201).json({
    booking,
    commission: {
      rate: calc.commissionRate,
      amount: calc.commission,
      partnerGets: calc.partnerGets,
    },
    breakdown: calc.breakdown, // ✅ V13 : détail pour affichage frontend
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

  // ── V13 : pour covoit, restituer les places
  if (booking.seats_booked && booking.listing_id) {
    try {
      const { data: l } = await db.from('listings').select('seats_available, type').eq('id', booking.listing_id).single();
      if (l && l.type === 'cov') {
        await db.from('listings')
          .update({ seats_available: (Number(l.seats_available) || 0) + Number(booking.seats_booked) })
          .eq('id', booking.listing_id);
      }
    } catch (e) { console.log('Seats restore error:', e.message); }
  }

  res.json({ message: 'Réservation annulée' });
}));


// ─── PATCH /api/bookings/:id/confirm-partner — Partenaire confirme réservation
router.patch('/:id/confirm-partner', authenticate, asyncHandler(async (req, res) => {
  const { data: booking } = await db.from('bookings')
    .select('*, listings(partner_id, partners(user_id))')
    .eq('id', req.params.id).single();

  if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });

  await db.from('bookings').update({ status: 'confirmed' }).eq('id', req.params.id);

  // Notifier le client (V13 : sans emoji UI)
  try {
    await db.from('notifications').insert({
      user_id: booking.user_id,
      title: 'Réservation confirmée',
      body: `Votre réservation a été confirmée par le propriétaire.`,
      type: 'booking',
    });
  } catch(e) {}

  res.json({ message: 'Réservation confirmée' });
}));

// ─── PATCH /api/bookings/:id/cancel — Annuler réservation
router.patch('/:id/cancel', authenticate, asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const { data: booking } = await db.from('bookings').select('user_id, seats_booked, listing_id').eq('id', req.params.id).single();

  if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });

  await db.from('bookings').update({ status: 'cancelled' }).eq('id', req.params.id);

  // ── V13 : pour covoit, restituer les places
  if (booking.seats_booked && booking.listing_id) {
    try {
      const { data: l } = await db.from('listings').select('seats_available, type').eq('id', booking.listing_id).single();
      if (l && l.type === 'cov') {
        await db.from('listings')
          .update({ seats_available: (Number(l.seats_available) || 0) + Number(booking.seats_booked) })
          .eq('id', booking.listing_id);
      }
    } catch (e) { console.log('Seats restore error:', e.message); }
  }

  // Notifier le client (V13 : sans emoji UI)
  try {
    await db.from('notifications').insert({
      user_id: booking.user_id,
      title: 'Réservation annulée',
      body: reason ? `Raison: ${reason}` : 'Votre réservation a été annulée.',
      type: 'info',
    });
  } catch(e) {}

  res.json({ message: 'Réservation annulée' });
}));

module.exports = router;
