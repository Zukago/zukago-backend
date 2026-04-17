const express = require('express');
const db      = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const emailService = require('../services/emailService');
const commissionService = require('../services/commissionService');

const router = express.Router();
router.use(authenticate, requireAdmin);

// ─── PARTENAIRES ─────────────────────────────────────────────────────────────

// GET /api/admin/partners — Liste des partenaires en attente
router.get('/partners', asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  const { data } = await db.from('partners')
    .select('*, users(name, email, phone, avatar)')
    .eq('status', status)
    .order('created_at', { ascending: false });
  res.json({ partners: data || [] });
}));

// PATCH /api/admin/partners/:id/approve — Approuver partenaire
router.patch('/partners/:id/approve', asyncHandler(async (req, res) => {
  const { data: partner } = await db.from('partners')
    .select('*, users(name, email)').eq('id', req.params.id).single();
  if (!partner) return res.status(404).json({ error: 'Partenaire introuvable' });

  await db.from('partners').update({
    status: 'approved',
    approved_by: req.user.id,
    approved_at: new Date(),
  }).eq('id', req.params.id);

  await db.from('users').update({ role: 'partner' }).eq('id', partner.user_id);

  // Email de confirmation
  await emailService.sendPartnerApproved(partner.users);

  res.json({ message: `Partenaire ${partner.users.name} approuvé` });
}));

// PATCH /api/admin/partners/:id/reject — Rejeter partenaire
router.patch('/partners/:id/reject', asyncHandler(async (req, res) => {
  const { message } = req.body;
  const { data: partner } = await db.from('partners')
    .select('*, users(name, email)').eq('id', req.params.id).single();
  if (!partner) return res.status(404).json({ error: 'Partenaire introuvable' });

  await db.from('partners').update({ status: 'rejected', rejection_msg: message }).eq('id', req.params.id);
  await emailService.sendPartnerRejected(partner.users, message);

  res.json({ message: 'Partenaire rejeté' });
}));

// PATCH /api/admin/partners/:id/suspend — Suspendre
router.patch('/partners/:id/suspend', asyncHandler(async (req, res) => {
  await db.from('partners').update({ status: 'suspended' }).eq('id', req.params.id);
  res.json({ message: 'Partenaire suspendu' });
}));

// ─── ANNONCES ─────────────────────────────────────────────────────────────────

// GET /api/admin/listings — Toutes les annonces
router.get('/listings', asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  const { data, error } = await db.from('listings')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Admin listings error:', error);
    return res.status(500).json({ error: error.message });
  }
  res.json({ listings: data || [], count: data?.length || 0 });
}));

// PATCH /api/admin/listings/:id/approve — Approuver annonce
router.patch('/listings/:id/approve', asyncHandler(async (req, res) => {
  const { featured = false } = req.body;

  // 1. Vérifier que l'annonce existe
  const { data: listing, error: listErr } = await db.from('listings')
    .select('*').eq('id', req.params.id).single();
  if (listErr || !listing) return res.status(404).json({ error: 'Annonce introuvable' });

  // 2. Approuver
  const { error: updateErr } = await db.from('listings').update({
    status: 'active',
    featured: featured || false,
    approved_by: req.user.id,
    approved_at: new Date().toISOString(),
  }).eq('id', req.params.id);

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // 3. Notifier le partenaire (sans bloquer si erreur)
  try {
    const { data: partner } = await db.from('partners').select('user_id').eq('id', listing.partner_id).single();
    if (partner) {
      await db.from('notifications').insert({
        user_id: partner.user_id,
        title: 'Annonce approuvée ✅',
        body: `Votre annonce "${listing.title}" est maintenant visible sur ZUKAGO !`,
        type: 'booking',
      });
    }
  } catch(e) { console.log('Notif error:', e.message); }

  res.json({ message: 'Annonce approuvée et publiée', listing });
}));

// PATCH /api/admin/listings/:id/reject — Rejeter annonce
router.patch('/listings/:id/reject', asyncHandler(async (req, res) => {
  const { message } = req.body;

  const { data: listing } = await db.from('listings').select('*').eq('id', req.params.id).single();
  if (!listing) return res.status(404).json({ error: 'Annonce introuvable' });

  await db.from('listings').update({
    status: 'rejected',
    rejection_msg: message || 'Ne correspond pas aux critères'
  }).eq('id', req.params.id);

  // Notifier le partenaire
  try {
    const { data: partner } = await db.from('partners').select('user_id').eq('id', listing.partner_id).single();
    if (partner) {
      await db.from('notifications').insert({
        user_id: partner.user_id,
        title: 'Annonce non approuvée ❌',
        body: `Votre annonce "${listing.title}" n'a pas été approuvée. Raison: ${message || 'Critères non respectés'}`,
        type: 'info',
      });
    }
  } catch(e) { console.log('Notif error:', e.message); }

  res.json({ message: 'Annonce rejetée' });
}));

// PATCH /api/admin/listings/:id/feature — Mettre en vedette
router.patch('/listings/:id/feature', asyncHandler(async (req, res) => {
  const { featured } = req.body;
  await db.from('listings').update({ featured }).eq('id', req.params.id);
  res.json({ message: `Annonce ${featured ? 'mise en vedette' : 'retirée des vedettes'}` });
}));

// ─── RETRAITS ─────────────────────────────────────────────────────────────────

// GET /api/admin/withdrawals — Retraits en attente
router.get('/withdrawals', asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  const { data } = await db.from('withdrawals')
    .select('*, partners(solde, users(name, email))')
    .eq('status', status)
    .order('created_at', { ascending: false });
  res.json({ withdrawals: data || [] });
}));

// PATCH /api/admin/withdrawals/:id/approve — Approuver retrait
router.patch('/withdrawals/:id/approve', asyncHandler(async (req, res) => {
  const { data: withdrawal } = await db.from('withdrawals')
    .select('*, partners(id, users(name, email))').eq('id', req.params.id).single();
  if (!withdrawal) return res.status(404).json({ error: 'Retrait introuvable' });

  // Déduire du solde partenaire
  await commissionService.debitPartner(withdrawal.partner_id, withdrawal.amount);

  await db.from('withdrawals').update({
    status: 'sent',
    processed_by: req.user.id,
    processed_at: new Date(),
  }).eq('id', req.params.id);

  await emailService.sendWithdrawalApproved(withdrawal.partners.users, withdrawal);
  res.json({ message: 'Retrait approuvé et virement effectué' });
}));

// PATCH /api/admin/withdrawals/:id/reject — Refuser retrait
router.patch('/withdrawals/:id/reject', asyncHandler(async (req, res) => {
  const { message } = req.body;
  const { data: withdrawal } = await db.from('withdrawals')
    .select('*, partners(users(name, email))').eq('id', req.params.id).single();

  await db.from('withdrawals').update({
    status: 'rejected',
    rejected_msg: message,
    processed_by: req.user.id,
  }).eq('id', req.params.id);

  await emailService.sendWithdrawalRejected(withdrawal.partners.users, message);
  res.json({ message: 'Retrait refusé' });
}));

// ─── COMMISSIONS ─────────────────────────────────────────────────────────────

// GET /api/admin/commissions/stats
router.get('/commissions/stats', asyncHandler(async (req, res) => {
  const { period = 'month' } = req.query;
  const stats = await commissionService.getStats(period);
  res.json(stats);
}));

// PATCH /api/admin/commissions/rate — Changer taux commission
router.patch('/commissions/rate', asyncHandler(async (req, res) => {
  const { rate } = req.body;
  if (!rate || rate < 0 || rate > 50) return res.status(400).json({ error: 'Taux invalide (0-50%)' });

  await db.from('app_config')
    .update({ value: String(rate), updated_by: req.user.id })
    .eq('key', 'commission_rate');

  res.json({ message: `Commission mise à jour : ${rate}%` });
}));

// ─── SERVICES ON/OFF ─────────────────────────────────────────────────────────

// GET /api/admin/services
router.get('/services', asyncHandler(async (req, res) => {
  const { data } = await db.from('services').select('*').order('sort_order');
  res.json({ services: data });
}));

// PATCH /api/admin/services/:id
router.patch('/services/:id', asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  const { data } = await db.from('services').update({ enabled }).eq('id', req.params.id).select().single();
  res.json({ service: data, message: `Service ${enabled ? 'activé' : 'désactivé'}` });
}));

// ─── BANNIÈRES PROMO ──────────────────────────────────────────────────────────

// GET /api/admin/banners
router.get('/banners', asyncHandler(async (req, res) => {
  const { data } = await db.from('promo_banners').select('*').order('sort_order');
  res.json({ banners: data });
}));

// POST /api/admin/banners
router.post('/banners', asyncHandler(async (req, res) => {
  const { text, emoji, color_from, color_to, filter_type } = req.body;
  const { data } = await db.from('promo_banners').insert({ text, emoji, color_from, color_to, filter_type }).select().single();
  res.status(201).json({ banner: data });
}));

// PATCH /api/admin/banners/:id
router.patch('/banners/:id', asyncHandler(async (req, res) => {
  const { data } = await db.from('promo_banners').update(req.body).eq('id', req.params.id).select().single();
  res.json({ banner: data });
}));

// DELETE /api/admin/banners/:id
router.delete('/banners/:id', asyncHandler(async (req, res) => {
  await db.from('promo_banners').delete().eq('id', req.params.id);
  res.json({ message: 'Bannière supprimée' });
}));

// ─── NOTIFICATIONS PUSH ───────────────────────────────────────────────────────

// POST /api/admin/notifications/send
router.post('/notifications/send', asyncHandler(async (req, res) => {
  const { title, body, target = 'all' } = req.body;

  // Récupérer users selon target
  let query = db.from('users').select('id, name, email').eq('active', true);
  if (target === 'clients')  query = query.eq('role', 'client');
  if (target === 'partners') query = query.eq('role', 'partner');

  const { data: users } = await query;

  // Créer notifications en DB
  const notifications = (users || []).map(u => ({
    user_id: u.id,
    target,
    title,
    body,
    type: 'info',
  }));

  if (notifications.length) {
    await db.from('notifications').insert(notifications);
  }

  // En Phase G : envoyer via Firebase Cloud Messaging (FCM)
  // await firebaseService.sendToUsers(users, { title, body });

  res.json({
    message: `Notification envoyée à ${users?.length || 0} utilisateurs`,
    count: users?.length || 0,
  });
}));

// ─── STATS DASHBOARD ─────────────────────────────────────────────────────────

// GET /api/admin/stats
router.get('/stats', asyncHandler(async (req, res) => {
  const [
    { count: totalUsers },
    { count: totalListings },
    { count: totalBookings },
    { count: pendingPartners },
    { count: pendingListings },
    { count: pendingWithdrawals },
  ] = await Promise.all([
    db.from('users').select('*', { count: 'exact', head: true }),
    db.from('listings').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    db.from('bookings').select('*', { count: 'exact', head: true }),
    db.from('partners').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    db.from('listings').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    db.from('withdrawals').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);

  const commStats = await commissionService.getStats('month');
  const allTimeStats = await commissionService.getStats('all');

  res.json({
    users: totalUsers,
    listings: totalListings,
    bookings: totalBookings,
    pendingPartners,
    pendingListings,
    pendingWithdrawals,
    revenusMois: commStats.total,
    revenusTotal: allTimeStats.total,
  });
}));

module.exports = router;
