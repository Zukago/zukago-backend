// ════════════════════════════════════════════════════════════════════════
// ZUKAGO — Routes pawaPay (Mobile Money MTN + Orange · Cameroun)  — PHASE 1
//   • POST /api/payments/pawapay/deposit          → encaissement client (MoMo)
//   • POST /api/payments/pawapay/callback/deposit → pawaPay confirme → booking PAID
//   • POST /api/payments/pawapay/callback/payout  → (Phase 2) virement partenaire
//   • POST /api/payments/pawapay/callback/refund  → (Phase 3) remboursement MoMo
//
//   Archi (robuste, indépendante de l'echo des metadata pawaPay) :
//     /deposit  → on CRÉE le booking en 'pending' (payment_ref = depositId),
//                 puis on initie le deposit pawaPay (le client tape son PIN).
//     callback  → COMPLETED : booking → 'confirmed'/'paid' + commission + emails.
//                 FAILED    : booking → 'cancelled' (pas de trace fantôme payée).
//
//   Mirror de la logique du webhook Stripe (payments.js) — mêmes services.
//   ⚠️ TODO Phase 1.5 (avant vrai lancement) : contrôle d'overlap anti-double
//      booking (réutiliser checkOverlapPrepare de payments.js, à exporter).
// ════════════════════════════════════════════════════════════════════════

const express = require('express');
const db      = require('../config/database');
const emailService     = require('../services/emailService');
const pricingService   = require('../services/pricingService');
const commissionService = require('../services/commissionService');
const statsService     = require('../services/statsService');
const i18n             = require('../services/i18nService');
const { notifyUser }   = require('../services/notifyUser');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const pawapay          = require('../services/pawapayService');

const router = express.Router();

// ─── POST /deposit — encaissement client en Mobile Money ──────────────────
router.post('/deposit', authenticate, asyncHandler(async (req, res) => {
  const {
    listing_id, operator, phone,
    start_date, end_date, room_type_id, seats_booked,
    unit_type, unit_count, with_driver, zone, extras, pickup_time, pickup_location,
  } = req.body;

  const L = await i18n.getUserLang(req.user.id);

  if (!listing_id) return res.status(400).json({ error: await i18n.t('payments_error_listing_id_required', L, 'listing_id requis') });
  if (!operator || !['mtn', 'orange'].includes(String(operator).toLowerCase())) {
    return res.status(400).json({ error: await i18n.t('pawapay_error_operator', L, 'Opérateur invalide (mtn ou orange)') });
  }
  if (!phone) return res.status(400).json({ error: await i18n.t('pawapay_error_phone', L, 'Numéro de téléphone requis') });

  // 1. Récupérer le listing
  const { data: listing } = await db.from('listings')
    .select('*, partners(id, user_id)')
    .eq('id', listing_id)
    .eq('status', 'active')
    .single();
  if (!listing) return res.status(404).json({ error: await i18n.t('payments_error_listing_not_found', L, 'Annonce introuvable ou inactive') });

  // ⚠️ TODO Phase 1.5 : contrôle d'overlap (anti-double-booking) — réutiliser
  //    checkOverlapPrepare de payments.js (à exporter). Non bloquant pour le test sandbox.

  // 2. Calculer le prix (même service que Stripe)
  let calc;
  try {
    const listingWithPartner = { ...listing, partner_id: listing.partners?.id };
    calc = await pricingService.calculate(listingWithPartner, req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // 3. Calcul nights / price_per_night (mirror webhook Stripe)
  let nights = unit_count || 1;
  if (start_date && end_date) {
    try {
      const diff = Math.ceil((new Date(end_date) - new Date(start_date)) / (1000 * 60 * 60 * 24));
      if (diff > 0) nights = diff;
    } catch (e) {}
  }
  const pricePerNight = Math.round((Number(calc.subtotal) || 0) / Math.max(1, unit_count || nights));
  const code = 'ZKG-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const depositId = require('crypto').randomUUID(); // ✅ généré AVANT le booking (évite la race avec le callback sandbox instantané)

  // 4. Créer le booking en 'pending' (sera confirmé par le callback)
  const insertData = {
    user_id:         req.user.id,
    listing_id:      listing.id,
    code,
    status:          'pending',
    payment_status:  'pending',
    payment_method:  'momo',
    payment_ref:     depositId,
    start_date:      start_date || null,
    end_date:        end_date || null,
    nights,
    price_per_night: pricePerNight,
    room_type_id:    room_type_id || null,
    seats_booked:    seats_booked || null,
    unit_type:       unit_type || null,
    unit_count:      unit_count || null,
    with_driver:     with_driver != null ? !!with_driver : null,
    zone:            zone || null,
    extras:          extras || null,
    pickup_time:     pickup_time || null,
    pickup_location: pickup_location || null,
    subtotal:        Number(calc.subtotal) || 0,
    service_fee:     Number(calc.serviceFee) || 0,
    total:           Number(calc.total) || 0,
    commission:      Number(calc.commission) || 0,
    partner_gets:    Number(calc.partnerGets) || 0,
    notes:           '',
  };

  const { data: booking, error: bErr } = await db.from('bookings').insert(insertData).select().single();
  if (bErr) {
    console.log('[pawapay deposit] Erreur création booking pending:', bErr.message);
    return res.status(500).json({ error: await i18n.t('pawapay_error_create', L, 'Erreur création réservation') });
  }

  // 5. Initier le deposit pawaPay (depositId déjà stocké sur le booking)
  try {
    const result = await pawapay.initiateDeposit({
      depositId,
      amountFcfa: calc.total,
      operator,
      phone,
      statementDescription: 'ZUKAGO',
      metadata: [
        { fieldName: 'booking_id', fieldValue: String(booking.id) },
        { fieldName: 'code',       fieldValue: code },
      ],
    });

    // pawaPay non configuré (token manquant) → annuler proprement (pas de spinner infini)
    if (result && result.skipped) {
      await db.from('bookings').update({ status: 'cancelled', payment_status: 'failed' }).eq('id', booking.id);
      console.log('[pawapay deposit] ⚠️ deposit SKIPPED — PAWAPAY_API_TOKEN manquant sur Railway');
      return res.status(503).json({ error: await i18n.t('pawapay_error_unavailable', L, 'Paiement Mobile Money momentanement indisponible') });
    }

    console.log(`[pawapay deposit] booking ${booking.id} pending · depositId ${depositId} · status ${result.status}`);

    return res.json({
      booking_id:  booking.id,
      deposit_id:  depositId,
      status:      result.status || 'ACCEPTED', // ACCEPTED → le client doit valider sur son téléphone
      amount_fcfa: calc.total,
      breakdown:   calc.breakdown,
      quote:       calc,
    });
  } catch (e) {
    // Échec d'initiation → on annule le booking pending (pas de fantôme)
    console.log('[pawapay deposit] initiateDeposit error:', e.message);
    try { await db.from('bookings').update({ status: 'cancelled', payment_status: 'failed' }).eq('id', booking.id); } catch (e2) {}
    return res.status(502).json({ error: await i18n.t('pawapay_error_init', L, 'Echec de l initiation du paiement Mobile Money') });
  }
}));

// ─── GET /status/:bookingId — statut léger pour le polling de l'app ───────
//   Évite la grosse route GET /bookings/:id (jointures fragiles).
router.get('/status/:bookingId', authenticate, asyncHandler(async (req, res) => {
  const { data: b } = await db.from('bookings')
    .select('id, user_id, status, payment_status, code')
    .eq('id', req.params.bookingId)
    .single();
  if (!b) return res.status(404).json({ error: 'introuvable' });
  if (b.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'non autorise' });
  }
  res.json({ id: b.id, status: b.status, payment_status: b.payment_status, code: b.code });
}));


async function finalizePaidBooking(booking) {
  const { data: listing } = await db.from('listings')
    .select('*, partners(id, user_id)')
    .eq('id', booking.listing_id)
    .single();
  if (!listing) { console.log('[pawapay] finalize: listing introuvable', booking.listing_id); return; }

  // payment record
  try {
    await db.from('payments').insert({
      booking_id:   booking.id,
      user_id:      booking.user_id,
      amount:       booking.total || 0,
      currency:     'FCFA',
      method:       'momo',
      provider:     'pawapay',
      provider_ref: booking.payment_ref,
      status:       'success',
    });
  } catch (e) { console.log('[pawapay] payment record error:', e.message); }

  // commission (séquestre : pas de crédit direct, libéré 24h après séjour)
  try {
    await commissionService.record(booking.id, listing.partners?.id, booking.commission || 0, 0);
    await commissionService.markPaid(booking.id);
  } catch (e) { console.log('[pawapay] commission error:', e.message); }

  try { statsService.updateDay(); } catch (e) {}

  // Notif + emails
  const partnerUserId = listing.partners?.user_id;
  if (partnerUserId) {
    try {
      const pl = await i18n.getUserLang(partnerUserId);
      const dateRange = booking.start_date ? ` ${await i18n.t('payments_notif_from_to', pl, 'du {start} au {end}', { start: booking.start_date, end: booking.end_date })}` : '';
      await notifyUser(partnerUserId, {
        title: await i18n.t('notif_new_booking_confirmed_title', pl, 'Nouvelle réservation confirmée'),
        body:  await i18n.t('notif_new_booking_confirmed_body',  pl, 'Une réservation a été confirmée pour "{title}"{dateRange}', { title: listing.title, dateRange }),
        type:  'booking',
        data:  { booking_id: booking.id, listing_id: listing.id },
      });
    } catch (e) { console.log('[pawapay] notif partner error:', e.message); }
  }

  try {
    const { data: user }    = await db.from('users').select('name, email').eq('id', booking.user_id).single();
    const { data: partner } = partnerUserId ? await db.from('users').select('name, email').eq('id', partnerUserId).single() : { data: null };
    if (user && user.email)    { emailService.sendBookingConfirmation(user, booking, listing).catch(e => console.log('[pawapay] email user:', e.message)); }
    if (partner && partner.email) { emailService.sendNewBookingToPartner(partner, booking, listing, user).catch(e => console.log('[pawapay] email partner:', e.message)); }
  } catch (e) { console.log('[pawapay] emails error:', e.message); }
}

// ─── POST /callback/deposit — pawaPay confirme l'encaissement ─────────────
//   ⚠️ Route NON authentifiée (vient de pawaPay). Sécuriser par whitelist IP
//      (voir pawapayService) + signature (Phase sécurité).
router.post('/callback/deposit', asyncHandler(async (req, res) => {
  if (!pawapay.verifyCallbackSignature(req.headers, req.body)) {
    console.log('[pawapay callback/deposit] signature invalide');
    return res.status(401).json({ error: 'bad signature' });
  }
  const cb = req.body || {};
  const depositId = cb.depositId;
  const status    = cb.status;
  console.log(`[pawapay callback/deposit] depositId ${depositId} status ${status}`);
  if (!depositId) return res.json({ received: true });

  const { data: booking } = await db.from('bookings').select('*').eq('payment_ref', depositId).single();
  if (!booking) { console.log('[pawapay callback/deposit] booking introuvable pour', depositId); return res.json({ received: true }); }

  // Idempotence : déjà payé → on ne refait rien
  if (booking.payment_status === 'paid') { return res.json({ received: true }); }

  if (status === 'COMPLETED') {
    const { error: upErr } = await db.from('bookings').update({ status: 'confirmed', payment_status: 'paid' }).eq('id', booking.id);
    if (upErr) console.log('[pawapay callback/deposit] ⚠️ UPDATE échec:', upErr.message);
    const { data: check } = await db.from('bookings').select('id, status, payment_status').eq('id', booking.id).single();
    console.log('[pawapay callback/deposit] DB après update =', JSON.stringify(check));
    const updated = { ...booking, status: 'confirmed', payment_status: 'paid' };
    await finalizePaidBooking(updated);
    console.log('[pawapay callback/deposit] ✅ Booking confirmé:', booking.id);
  } else if (status === 'FAILED' || status === 'REJECTED') {
    await db.from('bookings').update({ status: 'cancelled', payment_status: 'failed' }).eq('id', booking.id);
    console.log('[pawapay callback/deposit] ❌ Paiement échoué, booking annulé:', booking.id);
  }
  // Autres statuts (en cours) : on ne fait rien, on attend le statut final.

  return res.json({ received: true });
}));

// ─── POST /callback/payout — pawaPay confirme le virement partenaire ──────
router.post('/callback/payout', asyncHandler(async (req, res) => {
  if (!pawapay.verifyCallbackSignature(req.headers, req.body)) {
    console.log('[pawapay callback/payout] signature invalide');
    return res.status(401).json({ error: 'bad signature' });
  }
  const cb = req.body || {};
  const payoutId = cb.payoutId;
  const status   = cb.status;
  console.log(`[pawapay callback/payout] payoutId ${payoutId} status ${status}`);
  if (!payoutId) return res.json({ received: true });

  const { data: w } = await db.from('withdrawals').select('*').eq('payout_ref', payoutId).single();
  if (!w) { console.log('[pawapay callback/payout] retrait introuvable pour', payoutId); return res.json({ received: true }); }
  if (w.status === 'sent' || w.status === 'failed') { return res.json({ received: true }); } // idempotence

  // Infos partenaire / user (requêtes séparées, sans dépendre des FK)
  let partnerUserId = null, user = null;
  try {
    const { data: p } = await db.from('partners').select('user_id').eq('id', w.partner_id).single();
    partnerUserId = p?.user_id || null;
    if (partnerUserId) {
      const { data: u } = await db.from('users').select('name, email').eq('id', partnerUserId).single();
      user = u || null;
    }
  } catch (e) { console.log('[pawapay callback/payout] lookup error:', e.message); }

  if (status === 'COMPLETED') {
    await db.from('withdrawals').update({ status: 'sent' }).eq('id', w.id);
    if (partnerUserId) {
      try {
        const L = await i18n.getUserLang(partnerUserId);
        await notifyUser(partnerUserId, {
          title: await i18n.t('notif_withdrawal_approved_title', L, 'Virement effectué'),
          body:  await i18n.t('notif_withdrawal_approved_body',  L, 'Votre retrait de {amount} FCFA a été traité. Vous devriez le recevoir sous 24-48h.', { amount: w.amount?.toLocaleString() || '0' }),
          type:  'payment',
        });
      } catch (e) { console.log('[pawapay callback/payout] notif error:', e.message); }
    }
    try { if (user) emailService.sendWithdrawalApproved(user, w).catch(() => {}); } catch (e) {}
    console.log('[pawapay callback/payout] ✅ Virement confirmé:', w.id);
  } else if (status === 'FAILED' || status === 'REJECTED') {
    await db.from('withdrawals').update({ status: 'failed' }).eq('id', w.id);
    // Re-crédit du solde : l'argent n'est pas parti
    try { await commissionService.creditPartner(w.partner_id, w.amount); } catch (e) { console.log('[pawapay callback/payout] re-crédit error:', e.message); }
    if (partnerUserId) {
      try {
        const L = await i18n.getUserLang(partnerUserId);
        await notifyUser(partnerUserId, {
          title: await i18n.t('notif_withdrawal_failed_title', L, 'Virement échoué'),
          body:  await i18n.t('notif_withdrawal_failed_body',  L, "Votre retrait de {amount} FCFA n'a pas pu être effectué. Le montant a été recrédité sur votre solde.", { amount: w.amount?.toLocaleString() || '0' }),
          type:  'payment',
        });
      } catch (e) { console.log('[pawapay callback/payout] notif fail error:', e.message); }
    }
    console.log('[pawapay callback/payout] ❌ Virement échoué, solde recrédité:', w.id);
  }
  // Autres statuts (en cours) : on attend le statut final.

  return res.json({ received: true });
}));

// ─── POST /callback/refund — pawaPay confirme le remboursement client ─────
router.post('/callback/refund', asyncHandler(async (req, res) => {
  if (!pawapay.verifyCallbackSignature(req.headers, req.body)) {
    console.log('[pawapay callback/refund] signature invalide');
    return res.status(401).json({ error: 'bad signature' });
  }
  const cb = req.body || {};
  const refundId = cb.refundId;
  const status   = cb.status;
  console.log(`[pawapay callback/refund] refundId ${refundId} status ${status}`);
  if (!refundId) return res.json({ received: true });

  const { data: booking } = await db.from('bookings')
    .select('id, user_id, refund_status, refund_amount')
    .eq('refund_ref', refundId).single();
  if (!booking) { console.log('[pawapay callback/refund] booking introuvable pour', refundId); return res.json({ received: true }); }
  if (booking.refund_status === 'refunded') return res.json({ received: true }); // idempotence

  if (status === 'COMPLETED') {
    await db.from('bookings').update({ refund_status: 'refunded' }).eq('id', booking.id);
    try {
      const L = await i18n.getUserLang(booking.user_id);
      await notifyUser(booking.user_id, {
        title: await i18n.t('notif_refund_done_title', L, 'Remboursement effectué'),
        body:  await i18n.t('notif_refund_done_body',  L, 'Votre remboursement de {amount} FCFA a été envoyé sur votre Mobile Money.', { amount: booking.refund_amount?.toLocaleString() || '0' }),
        type:  'payment',
      });
    } catch (e) { console.log('[pawapay callback/refund] notif error:', e.message); }
    console.log('[pawapay callback/refund] ✅ Remboursement confirmé:', booking.id);
  } else if (status === 'FAILED' || status === 'REJECTED') {
    await db.from('bookings').update({ refund_status: 'failed' }).eq('id', booking.id);
    console.log('[pawapay callback/refund] ❌ Remboursement échoué (à reprendre manuellement):', booking.id);
  }
  // Autres statuts (en cours) : on attend le statut final.

  return res.json({ received: true });
}));

module.exports = router;
