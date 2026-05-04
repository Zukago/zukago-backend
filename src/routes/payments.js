const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios   = require('axios');
const db      = require('../config/database');
const emailService = require('../services/emailService');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

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
    const bookingId = pi.metadata.booking_id;

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
