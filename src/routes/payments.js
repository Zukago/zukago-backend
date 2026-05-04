const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios   = require('axios');
const db      = require('../config/database');
const emailService = require('../services/emailService');
const pricingService = require('../services/pricingService');
const commissionService = require('../services/commissionService');
const statsService = require('../services/statsService');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// V14.4 — checkOverlap helper (dupliqué de bookings.js pour /prepare)
// Vérifie qu'il n'y a pas de conflit AVANT de créer le Stripe Intent.
// Pas de booking en DB ici — on vérifie juste les bookings 'confirmed'.
// (Les 'pending' ghosts sont ignorés depuis V14.4 car on n'en crée plus !)
// ═══════════════════════════════════════════════════════════════════════════
async function checkOverlapPrepare(listing, params) {
  const { start_date, end_date, room_type_id, seats_booked } = params;

  // Covoiturage : check seats
  if (listing.type === 'cov') {
    const seatsRequested = Number(seats_booked) || 0;
    const seatsTotal     = Number(listing.seats_total) || 0;

    if (seatsTotal <= 0) return { conflict: true, reason: 'Trajet sans places configurées' };

    // V14.4 : on regarde SEULEMENT les confirmed (plus de ghost pending)
    const { data: activeBookings } = await db.from('bookings')
      .select('seats_booked')
      .eq('listing_id', listing.id)
      .eq('status', 'confirmed');

    const seatsTaken = (activeBookings || [])
      .reduce((sum, b) => sum + (Number(b.seats_booked) || 0), 0);

    const seatsAvailableNow = Math.max(0, seatsTotal - seatsTaken);

    if (seatsRequested > seatsAvailableNow) {
      return {
        conflict: true,
        reason: seatsAvailableNow === 0 ? 'Trajet complet' : `Plus que ${seatsAvailableNow} place(s) disponible(s)`,
      };
    }
    return { conflict: false };
  }

  // Driver heure/halfday : pas de check overlap
  if (listing.type === 'driver') {
    const unitType = params.unit_type || 'day';
    if (unitType === 'hour' || unitType === 'halfday') return { conflict: false };
  }

  if (!start_date || !end_date) return { conflict: false };

  const isDriver = listing.type === 'driver';
  let query = db.from('bookings')
    .select('id, room_type_id')
    .eq('listing_id', listing.id)
    .eq('status', 'confirmed'); // V14.4 : seulement confirmed

  if (isDriver) {
    query = query.lte('start_date', end_date).gte('end_date', start_date);
  } else {
    query = query.lt('start_date', end_date).gt('end_date', start_date);
  }

  const { data: conflicts } = await query;

  if (listing.type === 'hotel' && room_type_id) {
    const sameRoomConflicts = (conflicts || []).filter(c => Number(c.room_type_id) === Number(room_type_id));
    if (sameRoomConflicts.length) return { conflict: true, reason: 'Cette chambre n\'est pas disponible sur ces dates' };
    return { conflict: false };
  }

  if (conflicts?.length) return { conflict: true, reason: 'Ces dates ne sont pas disponibles' };
  return { conflict: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// V14.4 — POST /api/payments/stripe/prepare
// VRAIE ARCHITECTURE PRO BOOKING.COM/AIRBNB :
// On NE CRÉE PAS de booking en DB — juste un Stripe Intent.
// Le booking sera créé dans le webhook UNIQUEMENT si paiement réussi.
// → User annule la sheet = ZÉRO trace en DB ✨
// ═══════════════════════════════════════════════════════════════════════════
router.post('/stripe/prepare', authenticate, asyncHandler(async (req, res) => {
  const {
    listing_id, start_date, end_date,
    room_type_id, seats_booked, unit_type, unit_count,
    with_driver, zone, extras, pickup_time, pickup_location,
  } = req.body;

  if (!listing_id) return res.status(400).json({ error: 'listing_id requis' });

  // 1. Récupérer le listing
  const { data: listing } = await db.from('listings')
    .select('*, partners(id, user_id)')
    .eq('id', listing_id)
    .eq('status', 'active')
    .single();

  if (!listing) return res.status(404).json({ error: 'Annonce introuvable ou inactive' });

  // 2. Vérifier disponibilité
  const overlap = await checkOverlapPrepare(listing, req.body);
  if (overlap.conflict) {
    return res.status(409).json({ error: overlap.reason });
  }

  // 3. Calculer le prix
  let calc;
  try {
    const listingWithPartner = { ...listing, partner_id: listing.partners?.id };
    calc = await pricingService.calculate(listingWithPartner, req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // 4. Convertir FCFA → centimes EUR (Stripe uniquement)
  const eurAmount = Math.round(Number(calc.total) * 0.00152 * 100);

  // 5. Créer le Stripe PaymentIntent avec TOUTES les infos en metadata
  // → Le webhook utilisera ces metadata pour CRÉER le booking après paiement
  const paymentIntent = await stripe.paymentIntents.create({
    amount:   eurAmount,
    currency: 'eur',
    metadata: {
      // Identifiants
      listing_id:    listing.id,
      user_id:       req.user.id,
      partner_id:    listing.partners?.id || '',
      // Paramètres réservation (encodés JSON pour récup dans webhook)
      booking_params: JSON.stringify({
        start_date:      start_date || null,
        end_date:        end_date || null,
        room_type_id:    room_type_id || null,
        seats_booked:    seats_booked || null,
        unit_type:       unit_type || null,
        unit_count:      unit_count || null,
        with_driver:     with_driver ?? null,
        zone:            zone || null,
        extras:          extras || null,
        pickup_time:     pickup_time || null,
        pickup_location: pickup_location || null,
      }),
      // Prix calculé (utilisé dans webhook pour insérer le booking)
      pricing: JSON.stringify({
        total:           calc.total,
        subtotal:        calc.subtotal,
        serviceFee:      calc.serviceFee,
        commission:      calc.commission,
        commissionRate:  calc.commissionRate,
        partnerGets:     calc.partnerGets,
        breakdown:       calc.breakdown,
      }),
      amount_fcfa: String(calc.total),
    },
    description: `ZUKAGO - ${listing.title}`,
  });

  console.log('[Stripe prepare] Intent créé pour listing', listing.id, '— amount EUR cents:', eurAmount);

  res.json({
    clientSecret:     paymentIntent.client_secret,
    publishableKey:   process.env.STRIPE_PUBLISHABLE_KEY,
    amount_eur_cents: eurAmount,
    amount_fcfa:      calc.total,
    breakdown:        calc.breakdown,
    quote:            calc, // Frontend peut afficher le récap
  });
}));

// ─── POST /api/payments/stripe/intent — Créer paiement Stripe ────────────────
router.post('/stripe/intent', authenticate, asyncHandler(async (req, res) => {
  const { booking_id } = req.body;

  const { data: booking } = await db.from('bookings').select('*').eq('id', booking_id).single();
  if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });
  if (booking.user_id !== req.user.id) return res.status(403).json({ error: 'Non autorisé' });

  // Convertir FCFA en centimes EUR (Stripe utilise la plus petite unité)
  // 1 FCFA ≈ 0.00152 EUR → arrondi à 2 décimales
  const eurAmount = Math.round(Number(booking.total) * 0.00152 * 100); // centimes

  const paymentIntent = await stripe.paymentIntents.create({
    amount:   eurAmount,
    currency: 'eur',
    metadata: {
      booking_id: booking.id,
      booking_code: booking.code,
      user_id: req.user.id,
      amount_fcfa: booking.total,
    },
    description: `ZUKAGO - Réservation ${booking.code}`,
  });

  // Enregistrer paiement en DB
  await db.from('payments').insert({
    booking_id: booking.id,
    user_id:    req.user.id,
    amount:     booking.total,
    currency:   'FCFA',
    method:     'card',
    provider:   'stripe',
    provider_ref: paymentIntent.id,
    status:     'pending',
    metadata:   { stripe_client_secret: paymentIntent.client_secret },
  });

  res.json({
    clientSecret:      paymentIntent.client_secret,
    publishableKey:    process.env.STRIPE_PUBLISHABLE_KEY,
    amount_eur_cents:  eurAmount,
    amount_fcfa:       booking.total,
  });
}));

// ─── POST /api/payments/stripe/webhook — Webhook Stripe ───────────────────────
// V14.3 : ARCHITECTURE PRO — Email envoyé UNIQUEMENT après paiement confirmé par Stripe
// Le frontend ne fait RIEN après la sheet — c'est le webhook qui termine tout.
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('[Stripe webhook] Signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // ─── Paiement réussi ───────────────────────────────────────────────────────
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const meta = pi.metadata || {};

    // ╔═══════════════════════════════════════════════════════════════════════╗
    // ║ V14.4 : NOUVEAU FLOW — Si metadata.listing_id présent (route /prepare)║
    // ║ → CRÉER le booking maintenant (booking n'existait pas avant le paiement)║
    // ║ ANCIEN FLOW : si metadata.booking_id présent (route /intent legacy)    ║
    // ║ → UPDATE le booking existant                                          ║
    // ╚═══════════════════════════════════════════════════════════════════════╝

    // ─── Nouveau flow V14.4 (booking créé après paiement) ───
    if (meta.listing_id && meta.user_id) {
      try {
        const params  = meta.booking_params ? JSON.parse(meta.booking_params) : {};
        const pricing = meta.pricing ? JSON.parse(meta.pricing) : {};

        // Récupérer le listing pour récupérer partner_id
        const { data: listing } = await db.from('listings')
          .select('*, partners(id, user_id)')
          .eq('id', meta.listing_id)
          .single();

        if (!listing) {
          console.log('[Stripe webhook V14.4] Listing introuvable:', meta.listing_id);
          return res.json({ received: true });
        }

        // Générer un code de réservation unique
        const code = 'ZKG-' + Math.random().toString(36).substring(2, 8).toUpperCase();

        // Créer le booking (status='confirmed' direct)
        const { data: created, error: createError } = await db.from('bookings').insert({
          user_id:         meta.user_id,
          listing_id:      meta.listing_id,
          code,
          status:          'confirmed',
          payment_status:  'paid',
          payment_method:  'card',
          payment_ref:     pi.id,
          start_date:      params.start_date || null,
          end_date:        params.end_date || null,
          room_type_id:    params.room_type_id || null,
          seats_booked:    params.seats_booked || null,
          unit_type:       params.unit_type || null,
          unit_count:      params.unit_count || null,
          with_driver:     params.with_driver ?? null,
          zone:            params.zone || null,
          extras:          params.extras || null,
          pickup_time:     params.pickup_time || null,
          pickup_location: params.pickup_location || null,
          subtotal:        pricing.subtotal || 0,
          service_fee:     pricing.serviceFee || 0,
          total:           pricing.total || 0,
          commission:      pricing.commission || 0,
          commission_rate: pricing.commissionRate || 0,
          partner_gets:    pricing.partnerGets || 0,
        }).select().single();

        if (createError) {
          console.log('[Stripe webhook V14.4] Erreur création booking:', createError.message);
          return res.json({ received: true });
        }

        console.log('[Stripe webhook V14.4] Booking CRÉÉ après paiement:', created.id, code);

        // Insérer payment record
        await db.from('payments').insert({
          booking_id:   created.id,
          user_id:      meta.user_id,
          amount:       pricing.total || 0,
          currency:     'FCFA',
          method:       'card',
          provider:     'stripe',
          provider_ref: pi.id,
          status:       'success',
        });

        // Décrémenter seats si covoiturage
        if (listing.type === 'cov' && params.seats_booked) {
          try {
            const newSeats = Math.max(0, (Number(listing.seats_total) || 0) - 0); // (recalculé via /seats-available)
            // Pas besoin d'updater seats_total — c'est calculé dynamiquement via les bookings 'confirmed'
          } catch(e) { console.log('[Stripe webhook V14.4] Seats error:', e.message); }
        }

        // Enregistrer commission
        try {
          await commissionService.record(created.id, listing.partners?.id, pricing.commission || 0, pricing.commissionRate || 0);
          await commissionService.markPaid(created.id);
          await commissionService.creditPartner(listing.partners?.id, pricing.partnerGets || 0);
        } catch(e) { console.log('[Stripe webhook V14.4] Commission error:', e.message); }

        // Stats
        try { statsService.updateDay(); } catch(e) {}

        // Notification + emails (envoyés UNIQUEMENT après paiement)
        const partnerUserId = listing.partners?.user_id;
        if (partnerUserId) {
          try {
            await db.from('notifications').insert({
              user_id: partnerUserId,
              title:   'Nouvelle réservation confirmée',
              body:    `Une réservation a été confirmée pour "${listing.title}"${created.start_date ? ` du ${created.start_date} au ${created.end_date}` : ''}`,
              type:    'booking',
            });
          } catch(e) { console.log('[Stripe webhook V14.4] Notif error:', e.message); }
        }

        try {
          const { data: user } = await db.from('users').select('name, email').eq('id', meta.user_id).single();
          const { data: partner } = partnerUserId
            ? await db.from('users').select('name, email').eq('id', partnerUserId).single()
            : { data: null };

          if (user && partner && listing) {
            await Promise.all([
              emailService.sendBookingConfirmation(user, created, listing).catch(e => console.log('[Stripe webhook V14.4] Email user error:', e.message)),
              emailService.sendNewBookingToPartner(partner, created, listing, user).catch(e => console.log('[Stripe webhook V14.4] Email partner error:', e.message)),
            ]);
            console.log('[Stripe webhook V14.4] Emails envoyés');
          }
        } catch(e) { console.log('[Stripe webhook V14.4] Email block error:', e.message); }

        return res.json({ received: true });
      } catch (e) {
        console.log('[Stripe webhook V14.4] Erreur création booking après paiement:', e.message);
        return res.json({ received: true });
      }
    }

    // ─── Ancien flow legacy (booking existait déjà via /intent) ───
    const bookingId = meta.booking_id;

    if (!bookingId) {
      console.log('[Stripe webhook] No booking_id in metadata, skip');
      return res.json({ received: true });
    }

    try {
      // 1. Update payment status
      await db.from('payments').update({ status: 'success' }).eq('provider_ref', pi.id);

      // 2. Update booking status
      const { data: updated } = await db.from('bookings')
        .update({ status: 'confirmed', payment_status: 'paid', payment_ref: pi.id })
        .eq('id', bookingId)
        .select('*, listings(*, partners(user_id))')
        .single();

      console.log('[Stripe webhook] Booking confirmé:', bookingId);

      if (updated) {
        const listing = updated.listings;
        const partnerUserId = listing?.partners?.user_id;

        // 3. Notification partenaire (déplacée depuis POST /bookings)
        if (partnerUserId) {
          try {
            await db.from('notifications').insert({
              user_id: partnerUserId,
              title: 'Nouvelle réservation confirmée',
              body: `Une réservation a été confirmée pour "${listing.title}"${updated.start_date ? ` du ${updated.start_date} au ${updated.end_date}` : ''}`,
              type: 'booking',
            });
          } catch(e) { console.log('[Stripe webhook] Notif error:', e.message); }
        }

        // 4. Emails (déplacés depuis POST /bookings)
        // L'email n'est envoyé QU'APRÈS confirmation Stripe
        try {
          const { data: user } = await db.from('users')
            .select('name, email').eq('id', updated.user_id).single();
          const { data: partner } = partnerUserId
            ? await db.from('users').select('name, email').eq('id', partnerUserId).single()
            : { data: null };

          if (user && partner && listing) {
            await Promise.all([
              emailService.sendBookingConfirmation(user, updated, listing).catch(e =>
                console.log('[Stripe webhook] Email user error:', e.message)),
              emailService.sendNewBookingToPartner(partner, updated, listing, user).catch(e =>
                console.log('[Stripe webhook] Email partner error:', e.message)),
            ]);
            console.log('[Stripe webhook] Emails envoyés');
          }
        } catch(e) { console.log('[Stripe webhook] Email block error:', e.message); }
      }
    } catch (e) {
      console.log('[Stripe webhook] Update error:', e.message);
    }
  }

  // ─── Paiement échoué ───────────────────────────────────────────────────────
  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const bookingId = pi.metadata.booking_id;

    try {
      await db.from('payments').update({ status: 'failed' }).eq('provider_ref', pi.id);
      // Booking reste 'pending' (pourra être nettoyé par cron v1.1)
      console.log('[Stripe webhook] Payment failed for booking:', bookingId);
    } catch (e) {
      console.log('[Stripe webhook] Update failed error:', e.message);
    }
  }

  res.json({ received: true });
});

// ─── POST /api/payments/cinetpay/init — Initier paiement CinetPay ────────────
router.post('/cinetpay/init', authenticate, asyncHandler(async (req, res) => {
  const { booking_id, method } = req.body; // method: 'mtn' | 'orange'

  const { data: booking } = await db.from('bookings').select('*').eq('id', booking_id).single();
  if (!booking) return res.status(404).json({ error: 'Réservation introuvable' });

  const transactionId = `ZKG_${booking.code}_${Date.now()}`;

  // Appel API CinetPay
  const response = await axios.post(`${process.env.CINETPAY_BASE_URL}/payment`, {
    apikey:         process.env.CINETPAY_API_KEY,
    site_id:        process.env.CINETPAY_SITE_ID,
    transaction_id: transactionId,
    amount:         Math.round(Number(booking.total)),
    currency:       'XAF',  // FCFA = XAF
    description:    `ZUKAGO - Réservation ${booking.code}`,
    return_url:     `${process.env.APP_URL}/payment/success`,
    notify_url:     `${process.env.APP_URL}/api/payments/cinetpay/notify`,
    customer_email: req.user.email,
    channels:       method === 'mtn' ? 'MTN_MOMO_CM' : 'ORANGE_MONEY_CM',
    metadata:       JSON.stringify({ booking_id: booking.id }),
  });

  const { data: cpData } = response;

  if (cpData.code !== '201') {
    throw new Error(`CinetPay error: ${cpData.message}`);
  }

  // Enregistrer paiement
  await db.from('payments').insert({
    booking_id: booking.id,
    user_id:    req.user.id,
    amount:     booking.total,
    currency:   'FCFA',
    method,
    provider:   'cinetpay',
    provider_ref: transactionId,
    status:     'pending',
  });

  res.json({
    payment_url:    cpData.data.payment_url,
    transaction_id: transactionId,
  });
}));

// ─── POST /api/payments/cinetpay/notify — Notification CinetPay ───────────────
router.post('/cinetpay/notify', asyncHandler(async (req, res) => {
  const { cpm_trans_id, cpm_result, cpm_trans_status } = req.body;

  if (cpm_result === '00' && cpm_trans_status === 'ACCEPTED') {
    const { data: payment } = await db.from('payments')
      .select('booking_id').eq('provider_ref', cpm_trans_id).single();

    if (payment) {
      await db.from('payments').update({ status: 'success' }).eq('provider_ref', cpm_trans_id);
      const { data: updated } = await db.from('bookings')
        .update({ status: 'confirmed', payment_status: 'paid', payment_ref: cpm_trans_id })
        .eq('id', payment.booking_id)
        .select('*, listings(*, partners(user_id))')
        .single();

      console.log('[CinetPay notify] Booking confirmé:', payment.booking_id);

      // V14.3 : Notif + emails après paiement confirmé (même pattern que Stripe)
      if (updated) {
        const listing = updated.listings;
        const partnerUserId = listing?.partners?.user_id;

        // Notification partenaire
        if (partnerUserId) {
          try {
            await db.from('notifications').insert({
              user_id: partnerUserId,
              title: 'Nouvelle réservation confirmée',
              body: `Une réservation a été confirmée pour "${listing.title}"${updated.start_date ? ` du ${updated.start_date} au ${updated.end_date}` : ''}`,
              type: 'booking',
            });
          } catch(e) { console.log('[CinetPay notify] Notif error:', e.message); }
        }

        // Emails
        try {
          const { data: user } = await db.from('users')
            .select('name, email').eq('id', updated.user_id).single();
          const { data: partner } = partnerUserId
            ? await db.from('users').select('name, email').eq('id', partnerUserId).single()
            : { data: null };

          if (user && partner && listing) {
            await Promise.all([
              emailService.sendBookingConfirmation(user, updated, listing).catch(e =>
                console.log('[CinetPay notify] Email user error:', e.message)),
              emailService.sendNewBookingToPartner(partner, updated, listing, user).catch(e =>
                console.log('[CinetPay notify] Email partner error:', e.message)),
            ]);
            console.log('[CinetPay notify] Emails envoyés');
          }
        } catch(e) { console.log('[CinetPay notify] Email block error:', e.message); }
      }
    }
  } else {
    await db.from('payments').update({ status: 'failed' }).eq('provider_ref', cpm_trans_id);
  }

  res.json({ message: 'OK' });
}));

// ─── GET /api/payments/booking/:id — Statut paiement ─────────────────────────
router.get('/booking/:id', authenticate, asyncHandler(async (req, res) => {
  const { data: payments } = await db.from('payments')
    .select('*').eq('booking_id', req.params.id)
    .order('created_at', { ascending: false });

  res.json({ payments: payments || [] });
}));

module.exports = router;
