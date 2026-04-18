const express = require('express');
const db = require('../config/database');
const { authenticate, requirePartner } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const commissionService = require('../services/commissionService');

const router = express.Router();

// ─── GET /api/partners/me — Mon profil partenaire ────────────────────────────
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { data: partner } = await db.from('partners')
    .select('*, users(name, email, avatar, phone, whatsapp)')
    .eq('user_id', req.user.id).single();
  if (!partner) return res.status(404).json({ error: 'Profil partenaire introuvable' });
  res.json({ partner });
}));

// ─── GET /api/partners/stats — Stats du partenaire ───────────────────────────
router.get('/stats', authenticate, requirePartner, asyncHandler(async (req, res) => {
  let { data: partner } = await db.from('partners').select('id, solde').eq('user_id', req.user.id).single();
  if (!partner) {
    const { data: np } = await db.from('partners')
      .insert({ user_id: req.user.id, type: 'proprietaire', status: 'approved' })
      .select().single();
    partner = np;
  }
  if (!partner) return res.json({});

  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [
    { count: totalListings },
    { count: activeListings },
    { count: totalBookings },
    { count: confirmedBookings },
    { data: monthBookings },
    { data: allBookings },
  ] = await Promise.all([
    db.from('listings').select('*', { count: 'exact', head: true }).eq('partner_id', partner.id),
    db.from('listings').select('*', { count: 'exact', head: true }).eq('partner_id', partner.id).eq('status', 'active'),
    db.from('bookings').select('*', { count: 'exact', head: true })
      .in('listing_id', (await db.from('listings').select('id').eq('partner_id', partner.id)).data?.map(l=>l.id)||[]),
    db.from('bookings').select('*', { count: 'exact', head: true }).eq('status', 'confirmed')
      .in('listing_id', (await db.from('listings').select('id').eq('partner_id', partner.id)).data?.map(l=>l.id)||[]),
    db.from('bookings').select('partner_gets').gte('created_at', firstOfMonth)
      .in('listing_id', (await db.from('listings').select('id').eq('partner_id', partner.id)).data?.map(l=>l.id)||[]),
    db.from('bookings').select('partner_gets')
      .in('listing_id', (await db.from('listings').select('id').eq('partner_id', partner.id)).data?.map(l=>l.id)||[]),
  ]);

  const revenuMois = (monthBookings || []).reduce((s, b) => s + (b.partner_gets || 0), 0);
  const totalRevenu = (allBookings || []).reduce((s, b) => s + (b.partner_gets || 0), 0);

  res.json({
    totalListings:     totalListings || 0,
    activeListings:    activeListings || 0,
    totalBookings:     totalBookings || 0,
    confirmedBookings: confirmedBookings || 0,
    revenuMois,
    totalRevenu,
    solde: partner.solde || 0,
  });
}));


// ─── GET /api/partners/listings — Mes annonces ───────────────────────────────
router.get('/listings', authenticate, requirePartner, asyncHandler(async (req, res) => {
  const { data: partner } = await db.from('partners').select('id').eq('user_id', req.user.id).single();

  const { data: listings } = await db.from('listings')
    .select('*, listing_photos(url, is_main)')
    .eq('partner_id', partner.id)
    .order('created_at', { ascending: false });

  res.json({ listings: listings || [] });
}));

// ─── GET /api/partners/bookings — Mes réservations ───────────────────────────
router.get('/bookings', authenticate, requirePartner, asyncHandler(async (req, res) => {
  let { data: partner } = await db.from('partners').select('id').eq('user_id', req.user.id).single();
  if (!partner) {
    const { data: np } = await db.from('partners')
      .insert({ user_id: req.user.id, type: 'proprietaire', status: 'approved' })
      .select().single();
    partner = np;
  }
  if (!partner) return res.json({ bookings: [] });

  const { data: myListings } = await db.from('listings').select('id').eq('partner_id', partner.id);
  const listingIds = (myListings || []).map(l => l.id);

  if (!listingIds.length) return res.json({ bookings: [] });

  const { data: bookings } = await db.from('bookings')
    .select('*, listings(id, title, type, city_code, price, emoji), users(name, email)')
    .in('listing_id', listingIds)
    .order('created_at', { ascending: false });

  res.json({ bookings: bookings || [] });
}));

// ─── POST /api/partners/withdraw — Demander un retrait ───────────────────────
router.post('/withdraw', authenticate, requirePartner, asyncHandler(async (req, res) => {
  const { amount, method, account } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Montant invalide' });

  const { data: partner } = await db.from('partners').select('id, solde').eq('user_id', req.user.id).single();
  if (Number(partner.solde) < amount) return res.status(400).json({ error: `Solde insuffisant (${partner.solde} FCFA)` });

  const { data: withdrawal } = await db.from('withdrawals').insert({
    partner_id: partner.id, amount, method, account,
  }).select().single();

  res.status(201).json({ withdrawal, message: 'Demande de retrait soumise. Traitement sous 48h.' });
}));

module.exports = router;
