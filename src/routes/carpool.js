/**
 * ZUKAGO — routes/carpool.js
 * Covoiturage — trajets et réservations
 */

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const i18n = require('../services/i18nService');
// ✅ V14.5.4 : Helper centralisé notification (DB insert + push Expo)
const { notifyUser } = require('../services/notifyUser');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// TRIPS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/carpool/trips — Liste / recherche
router.get('/trips', optionalAuth, asyncHandler(async (req, res) => {
  const { from, to, date, min_seats = 1, limit = 30 } = req.query;

  let q = db.from('carpool_trips')
    .select(`
      *,
      users!carpool_trips_driver_id_fkey(id, name, avatar, verified)
    `)
    .eq('status', 'active')
    .gte('seats_available', Number(min_seats))
    .order('depart_date',  { ascending: true })
    .order('depart_time',  { ascending: true })
    .limit(Number(limit));

  if (from) q = q.ilike('from_city', `%${from}%`);
  if (to)   q = q.ilike('to_city',   `%${to}%`);
  if (date) q = q.gte('depart_date', date);
  else      q = q.gte('depart_date', new Date().toISOString().slice(0, 10));

  const { data, error } = await q;
  if (error) {
    console.error('Carpool trips error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json({ trips: data || [] });
}));

// GET /api/carpool/trips/:id
router.get('/trips/:id', optionalAuth, asyncHandler(async (req, res) => {
  const { data: trip, error } = await db.from('carpool_trips')
    .select(`
      *,
      users!carpool_trips_driver_id_fkey(id, name, avatar, verified, phone, whatsapp)
    `)
    .eq('id', req.params.id).single();

  if (error || !trip) return res.status(404).json({ error: 'Trajet introuvable' });
  res.json({ trip });
}));

// POST /api/carpool/trips — Créer un trajet
router.post('/trips', authenticate, [
  body('from_city').trim().notEmpty().withMessage('Ville de départ requise'),
  body('to_city').trim().notEmpty().withMessage("Ville d'arrivée requise"),
  body('depart_date').notEmpty().withMessage('Date de départ requise'),
  body('depart_time').notEmpty().withMessage('Heure de départ requise'),
  body('seats_total').isInt({ min: 1, max: 8 }).withMessage('Places invalides (1-8)'),
  body('price_per_seat').isInt({ min: 0 }).withMessage('Prix invalide'),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const {
    from_city, from_city_code, from_address,
    to_city,   to_city_code,   to_address,
    depart_date, depart_time,
    seats_total, price_per_seat,
    car_model, car_color, plate_number,
    luggage, smoking_ok, music_ok, pets_ok,
    notes, phone, whatsapp,
  } = req.body;

  const { data: trip, error } = await db.from('carpool_trips').insert({
    driver_id:       req.user.id,
    from_city, from_city_code: from_city_code || null, from_address,
    to_city,   to_city_code:   to_city_code   || null, to_address,
    depart_date, depart_time,
    seats_total, seats_available: seats_total,
    price_per_seat,
    car_model, car_color, plate_number,
    luggage: luggage || 'medium',
    smoking_ok: !!smoking_ok,
    music_ok:   music_ok !== false,
    pets_ok:    !!pets_ok,
    notes, phone, whatsapp,
    status: 'active',
  }).select().single();

  if (error) {
    console.error('Create trip error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ trip, message: 'Trajet publié avec succès' });
}));

// PATCH /api/carpool/trips/:id — Modifier
router.patch('/trips/:id', authenticate, asyncHandler(async (req, res) => {
  const { data: trip } = await db.from('carpool_trips')
    .select('driver_id').eq('id', req.params.id).single();
  if (!trip) return res.status(404).json({ error: 'Trajet introuvable' });

  const isOwner = trip.driver_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Non autorisé' });

  const updates = { ...req.body };
  delete updates.driver_id;
  delete updates.seats_available;

  const { data, error } = await db.from('carpool_trips')
    .update({ ...updates, updated_at: new Date() })
    .eq('id', req.params.id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ trip: data });
}));

// DELETE /api/carpool/trips/:id
router.delete('/trips/:id', authenticate, asyncHandler(async (req, res) => {
  const { data: trip } = await db.from('carpool_trips')
    .select('id, driver_id').eq('id', req.params.id).single();
  if (!trip) return res.status(404).json({ error: 'Trajet introuvable' });

  const isOwner = trip.driver_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Non autorisé' });

  // Récupérer les passagers pour notif
  const { data: bookings } = await db.from('carpool_bookings')
    .select('passenger_id').eq('trip_id', req.params.id).eq('status', 'confirmed');

  const { error } = await db.from('carpool_trips').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  if (bookings?.length) {
    // ✅ V14.5.3 i18n : chaque passager reçoit la notif dans sa langue
    // ✅ V14.5.4 : notifyUser() par passager (langues différentes — pas de batch)
    try {
      await Promise.all(
        bookings.map(async (b) => {
          const L = await i18n.getUserLang(b.passenger_id);
          return notifyUser(b.passenger_id, {
            title: await i18n.t('notif_trip_cancelled_title', L, 'Trajet annulé'),
            body:  await i18n.t('notif_trip_cancelled_body',  L, 'Le conducteur a annulé le trajet. Votre réservation a été annulée.'),
            type:  'info',
            data:  { trip_id: req.params.id },
          });
        })
      );
    } catch (e) { /* ignore */ }
  }

  res.json({ message: 'Trajet supprimé', deleted: true });
}));

// GET /api/carpool/mine/driver — Mes trajets comme conducteur
router.get('/mine/driver', authenticate, asyncHandler(async (req, res) => {
  const { data, error } = await db.from('carpool_trips')
    .select('*, carpool_bookings(id, status, seats_booked, passenger_id)')
    .eq('driver_id', req.user.id)
    .order('depart_date', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ trips: data || [] });
}));

// ═══════════════════════════════════════════════════════════════════════════
// BOOKINGS
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/carpool/trips/:id/book — Réserver
router.post('/trips/:id/book', authenticate, [
  body('seats_booked').isInt({ min: 1, max: 8 }),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { seats_booked, message } = req.body;

  const { data: trip } = await db.from('carpool_trips')
    .select('*').eq('id', req.params.id).single();

  if (!trip) return res.status(404).json({ error: 'Trajet introuvable' });
  if (trip.status !== 'active') return res.status(400).json({ error: 'Trajet non disponible' });
  if (trip.driver_id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas réserver votre propre trajet' });
  if (trip.seats_available < seats_booked) {
    return res.status(409).json({ error: `Plus que ${trip.seats_available} place(s) disponible(s)` });
  }

  // Pas de double réservation
  const { data: existing } = await db.from('carpool_bookings')
    .select('id').eq('trip_id', trip.id).eq('passenger_id', req.user.id)
    .in('status', ['pending', 'confirmed']).single();
  if (existing) return res.status(409).json({ error: 'Vous avez déjà une réservation sur ce trajet' });

  const total_price = seats_booked * trip.price_per_seat;

  const { data: booking, error } = await db.from('carpool_bookings').insert({
    trip_id: trip.id,
    passenger_id: req.user.id,
    seats_booked,
    total_price,
    message: message || null,
    status: 'pending',
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Notif conducteur
  try {
    const { data: passengerInfo } = await db.from('users')
      .select('name').eq('id', req.user.id).single();
    // ✅ V14.5.3 i18n : notif dans la langue du conducteur
    // ✅ V14.5.4 : helper notifyUser (DB + push Expo) + data deep linking
    const L = await i18n.getUserLang(trip.driver_id);
    const passengerName = passengerInfo?.name || await i18n.t('notif_a_passenger', L, 'Un passager');
    await notifyUser(trip.driver_id, {
      title: await i18n.t('notif_new_carpool_booking_title', L, 'Nouvelle réservation covoiturage'),
      body:  await i18n.t('notif_new_carpool_booking_body',  L, '{name} demande {seats} place(s) sur votre trajet {from} → {to}.', {
        name: passengerName, seats: seats_booked, from: trip.from_city, to: trip.to_city,
      }),
      type:  'carpool',
      data:  { trip_id: trip.id, booking_id: booking.id },
    });
  } catch (e) {}

  res.status(201).json({ booking, message: 'Demande envoyée au conducteur' });
}));

// PATCH /api/carpool/bookings/:id/confirm — Conducteur confirme
router.patch('/bookings/:id/confirm', authenticate, asyncHandler(async (req, res) => {
  const { data: booking } = await db.from('carpool_bookings')
    .select('*, carpool_trips(driver_id, from_city, to_city, depart_date)')
    .eq('id', req.params.id).single();

  if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });
  if (booking.carpool_trips?.driver_id !== req.user.id) {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  if (booking.status !== 'pending') {
    return res.status(400).json({ error: 'Réservation déjà traitée' });
  }

  await db.from('carpool_bookings').update({ status: 'confirmed' }).eq('id', req.params.id);

  try {
    // ✅ V14.5.3 i18n : notif dans la langue du passager
    // ✅ V14.5.4 : helper notifyUser (DB + push Expo) + data deep linking
    const L = await i18n.getUserLang(booking.passenger_id);
    await notifyUser(booking.passenger_id, {
      title: await i18n.t('notif_carpool_confirmed_title', L, 'Réservation covoiturage confirmée'),
      body:  await i18n.t('notif_carpool_confirmed_body',  L, 'Le conducteur a confirmé votre place pour {from} → {to} le {date}.', {
        from: booking.carpool_trips.from_city, to: booking.carpool_trips.to_city, date: booking.carpool_trips.depart_date,
      }),
      type:  'carpool',
      data:  { booking_id: booking.id, trip_id: booking.trip_id },
    });
  } catch (e) {}

  res.json({ message: 'Réservation confirmée' });
}));

// PATCH /api/carpool/bookings/:id/cancel — Annuler (passager ou conducteur)
router.patch('/bookings/:id/cancel', authenticate, asyncHandler(async (req, res) => {
  const { data: booking } = await db.from('carpool_bookings')
    .select('*, carpool_trips(driver_id, from_city, to_city)')
    .eq('id', req.params.id).single();

  if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });

  const isPassenger = booking.passenger_id === req.user.id;
  const isDriver    = booking.carpool_trips?.driver_id === req.user.id;
  if (!isPassenger && !isDriver) return res.status(403).json({ error: 'Non autorisé' });

  await db.from('carpool_bookings').update({ status: 'cancelled' }).eq('id', req.params.id);

  // ✅ V14.5.4 : variable renommée 'recipientId' (évite conflit avec import notifyUser)
  const recipientId = isPassenger ? booking.carpool_trips.driver_id : booking.passenger_id;
  try {
    // ✅ V14.5.3 i18n : notif dans la langue du destinataire
    // ✅ V14.5.4 : helper notifyUser (DB + push Expo) + data deep linking
    const L = await i18n.getUserLang(recipientId);
    await notifyUser(recipientId, {
      title: await i18n.t('notif_carpool_cancelled_title', L, 'Réservation annulée'),
      body:  await i18n.t('notif_carpool_cancelled_body',  L, 'Une réservation pour {from} → {to} a été annulée.', {
        from: booking.carpool_trips.from_city, to: booking.carpool_trips.to_city,
      }),
      type:  'carpool',
      data:  { booking_id: booking.id, trip_id: booking.trip_id },
    });
  } catch (e) {}

  res.json({ message: 'Réservation annulée' });
}));

// GET /api/carpool/bookings/mine — Mes réservations passager
router.get('/bookings/mine', authenticate, asyncHandler(async (req, res) => {
  const { data, error } = await db.from('carpool_bookings')
    .select(`
      *,
      carpool_trips(
        id, from_city, to_city, depart_date, depart_time,
        car_model, price_per_seat,
        users!carpool_trips_driver_id_fkey(id, name, avatar, phone, whatsapp)
      )
    `)
    .eq('passenger_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ bookings: data || [] });
}));

module.exports = router;
