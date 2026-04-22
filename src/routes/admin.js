const express = require('express');
const db      = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const emailService = require('../services/emailService');
const commissionService = require('../services/commissionService');
const statsService      = require('../services/statsService');

const router = express.Router();
router.use(authenticate, requireAdmin);

// ═══════════════════════════════════════════════════════════════════════════
// HELPER — Exécuter une query Supabase sans planter en cas d'erreur
// (Supabase queries n'ont pas .catch() natif, il faut await dans try/catch)
// ═══════════════════════════════════════════════════════════════════════════
const safe = async (promiseLike, label = '') => {
  try { return await promiseLike; }
  catch (e) { if (label) console.log(`[safe] ${label}: ${e.message}`); return null; }
};

// ─── PARTENAIRES ─────────────────────────────────────────────────────────────

// GET /api/admin/partners — Liste des partenaires (filtrés par demande_verified)
router.get('/partners', asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  console.log(`[Admin] GET /partners status=${status} by ${req.user?.email}`);

  // Essai avec relation users complète
  const { data, error } = await db.from('partners')
    .select('*, users(id, name, email, phone, avatar, whatsapp, verified, demande_verified)')
    .eq('status', status)
    .order('created_at', { ascending: false });

  let result;

  if (error) {
    console.error('[Admin] /partners error with users relation:', error.message);

    // Fallback : sans relation users (colonnes manquantes)
    const { data: partners2, error: err2 } = await db.from('partners')
      .select('*').eq('status', status).order('created_at', { ascending: false });

    if (err2) {
      console.error('[Admin] /partners fallback error:', err2.message);
      return res.status(500).json({ error: err2.message, partners: [] });
    }

    // Hydrater manuellement les users
    const userIds = (partners2 || []).map(p => p.user_id).filter(Boolean);
    let usersMap = {};
    if (userIds.length) {
      const { data: usersData } = await db.from('users')
        .select('id, name, email, avatar, verified, demande_verified').in('id', userIds);
      (usersData || []).forEach(u => { usersMap[u.id] = u; });
    }
    result = (partners2 || []).map(p => ({ ...p, users: usersMap[p.user_id] || null }));
  } else {
    result = data || [];
  }

  // ✅ FILTRAGE : pour les pending, n'afficher que ceux dont l'user.demande_verified = true
  // (protection contre les partners auto-créés par erreur)
  if (status === 'pending') {
    result = result.filter(p => p.users?.demande_verified === true);
  }

  console.log(`[Admin] /partners OK, ${result.length} rows after filter`);
  res.json({ partners: result });
}));

// PATCH /api/admin/partners/:id/approve — Approuver partenaire
router.patch('/partners/:id/approve', asyncHandler(async (req, res) => {
  console.log(`[Admin] PATCH /partners/${req.params.id}/approve by ${req.user?.email}`);

  // Récupérer le partner SEUL (sans relation users qui peut foirer)
  const { data: partner, error: pErr } = await db.from('partners')
    .select('*').eq('id', req.params.id).maybeSingle();
  if (pErr)    { console.error('[Admin] approve query error:', pErr.message); return res.status(500).json({ error: pErr.message }); }
  if (!partner) { console.warn(`[Admin] approve - partner ${req.params.id} not found`); return res.status(404).json({ error: 'Partenaire introuvable' }); }

  // Récupérer le user séparément
  const { data: user } = await db.from('users')
    .select('id, name, email').eq('id', partner.user_id).maybeSingle();

  // Update status partner
  const { error: uErr } = await db.from('partners').update({
    status: 'approved',
    approved_by: req.user.id,
    approved_at: new Date(),
  }).eq('id', req.params.id);
  if (uErr) { console.error('[Admin] approve update error:', uErr.message); return res.status(500).json({ error: uErr.message }); }

  // Update role user
  await safe(db.from('users').update({ role: 'partner' }).eq('id', partner.user_id), 'approve-role');

  // Notification in-app
  try {
    await db.from('notifications').insert({
      user_id: partner.user_id,
      title: '🎉 Compte partenaire approuvé !',
      body: `Bienvenue ${user?.name || ''} ! Vous pouvez maintenant publier vos annonces sur ZUKAGO.`,
      type: 'info',
    });
  } catch(e) { console.log('Notif partner approve error:', e.message); }

  // Email
  if (user?.email) {
    try { await emailService.sendPartnerApproved(user); } catch(e) { console.log('Email approve error:', e.message); }
  }

  // Stats
  try { statsService.updateDay(); } catch(e) {}

  console.log(`[Admin] ✅ Partner ${req.params.id} approved (${user?.email || ''})`);
  res.json({ message: `Partenaire ${user?.name || ''} approuvé` });
}));

// PATCH /api/admin/partners/:id/reject — Rejeter partenaire
router.patch('/partners/:id/reject', asyncHandler(async (req, res) => {
  const { message } = req.body;
  console.log(`[Admin] PATCH /partners/${req.params.id}/reject by ${req.user?.email}`);

  const { data: partner, error: pErr } = await db.from('partners')
    .select('*').eq('id', req.params.id).maybeSingle();
  if (pErr)    return res.status(500).json({ error: pErr.message });
  if (!partner) return res.status(404).json({ error: 'Partenaire introuvable' });

  const { data: user } = await db.from('users')
    .select('id, name, email').eq('id', partner.user_id).maybeSingle();

  const { error: uErr } = await db.from('partners')
    .update({ status: 'rejected', rejection_msg: message || null })
    .eq('id', req.params.id);
  if (uErr) return res.status(500).json({ error: uErr.message });

  // ✅ Reset demande_verified = false pour que le user puisse refaire une demande
  await safe(
    db.from('users').update({ demande_verified: false }).eq('id', partner.user_id),
    'reject-reset-demande'
  );

  // Notification in-app
  try {
    await db.from('notifications').insert({
      user_id: partner.user_id,
      title: 'Demande partenaire refusée',
      body: `Votre demande partenaire n'a pas ete approuvee. ${message ? 'Raison : ' + message : 'Contactez le support.'} Vous pouvez soumettre une nouvelle demande.`,
      type: 'info',
    });
  } catch(e) { console.log('Notif partner reject error:', e.message); }

  if (user) {
    try { await emailService.sendPartnerRejected(user, message); } catch(e) { console.log('Email reject error:', e.message); }
  }

  console.log(`[Admin] ✅ Partner ${req.params.id} rejected, demande_verified reset to false`);
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
        title: 'Annonce approuvée',
        body: `Votre annonce "${listing.title}" est maintenant visible sur ZUKAGO. Bonne chance !`,
        type: 'info',
      });
    }
  } catch(e) { console.log('Notif error:', e.message); }

  // Mettre à jour stats_daily
  statsService.updateDay();

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

  // Notification in-app
  try {
    await db.from('notifications').insert({
      user_id: withdrawal.partners?.user_id || null,
      title: 'Virement effectué',
      body: `Votre retrait de ${withdrawal.amount?.toLocaleString()} FCFA a été traité. Vous devriez le recevoir sous 24-48h.`,
      type: 'payment',
    });
  } catch(e) { console.log('Notif withdrawal approve error:', e.message); }

  try { await emailService.sendWithdrawalApproved(withdrawal.partners.users, withdrawal); } catch(e) {}
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
    title,
    body,
    type: 'push',
    read: false,
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


// ─── STATS DÉTAILLÉES — lecture depuis stats_daily ───────────────────────────

// GET /api/admin/stats/daily?year=2026&month=4
// Retourne les données jour par jour pour un mois donné
router.get('/stats/daily', asyncHandler(async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;

  const data = await statsService.getMonth(year, month);

  // Formater pour le frontend : label = jour du mois ("01".."31")
  const formatted = data.map(row => ({
    date:             row.date,
    label:            row.date.slice(8, 10), // "01".."31"
    new_partners:     row.new_partners     || 0,
    new_users:        row.new_users        || 0,
    new_listings:     row.new_listings     || 0,
    total_bookings:   row.total_bookings   || 0,
    total_revenue:    Number(row.total_revenue    || 0),
    total_commission: Number(row.total_commission || 0),
  }));

  // Totaux du mois
  const totals = formatted.reduce((acc, row) => ({
    new_partners:     acc.new_partners     + row.new_partners,
    new_users:        acc.new_users        + row.new_users,
    new_listings:     acc.new_listings     + row.new_listings,
    total_bookings:   acc.total_bookings   + row.total_bookings,
    total_revenue:    acc.total_revenue    + row.total_revenue,
    total_commission: acc.total_commission + row.total_commission,
  }), { new_partners: 0, new_users: 0, new_listings: 0, total_bookings: 0, total_revenue: 0, total_commission: 0 });

  res.json({ data: formatted, totals, year, month });
}));

// GET /api/admin/stats/daily/year?year=2026
// Retourne les données mois par mois pour une année (agrégé)
router.get('/stats/daily/year', asyncHandler(async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const rows = await statsService.getYear(year);

  // Grouper par mois
  const byMonth = {};
  for (const row of rows) {
    const m = row.date.slice(0, 7); // "2026-04"
    if (!byMonth[m]) byMonth[m] = { label: m, new_partners: 0, new_users: 0, new_listings: 0, total_bookings: 0, total_revenue: 0, total_commission: 0 };
    byMonth[m].new_partners     += row.new_partners     || 0;
    byMonth[m].new_users        += row.new_users        || 0;
    byMonth[m].new_listings     += row.new_listings     || 0;
    byMonth[m].total_bookings   += row.total_bookings   || 0;
    byMonth[m].total_revenue    += Number(row.total_revenue    || 0);
    byMonth[m].total_commission += Number(row.total_commission || 0);
  }

  res.json({ data: Object.values(byMonth), year });
}));

// POST /api/admin/stats/rebuild
// Reconstruit stats_daily depuis l'origine des données — bouton admin
router.post('/stats/rebuild', asyncHandler(async (req, res) => {
  const result = await statsService.rebuildAll();
  res.json({
    message: `Stats reconstruites : ${result.rebuilt} jour(s) du ${result.from} au ${result.to}`,
    ...result,
  });
}));

// POST /api/admin/stats/update-today
// Force la mise à jour de stats_daily pour aujourd'hui
router.post('/stats/update-today', asyncHandler(async (req, res) => {
  await statsService.updateDay();
  res.json({ message: `Stats du ${statsService.today()} mises à jour` });
}));


// ─── GESTION UTILISATEURS ─────────────────────────────────────────────────────

// GET /api/admin/users — Liste tous les utilisateurs
router.get('/users', asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, search = '', role = '' } = req.query;
  const offset = (page - 1) * limit;

  let query = db.from('users')
    .select('id, name, email, role, active, verified, created_at, avatar, provider', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  }
  if (role) {
    query = query.eq('role', role);
  }

  const { data: users, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ users: users || [], total: count || 0, page: Number(page), limit: Number(limit) });
}));

// PATCH /api/admin/users/:id/suspend — Suspendre / réactiver un compte
router.patch('/users/:id/suspend', asyncHandler(async (req, res) => {
  const { active } = req.body; // true = réactiver, false = suspendre

  const { data: user } = await db.from('users').select('name, email').eq('id', req.params.id).single();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  // Empêcher de suspendre un admin
  const { data: target } = await db.from('users').select('role').eq('id', req.params.id).single();
  if (target?.role === 'admin') return res.status(403).json({ error: 'Impossible de suspendre un admin' });

  await db.from('users').update({ active }).eq('id', req.params.id);

  // Notif in-app
  await safe(db.from('notifications').insert({
    user_id: req.params.id,
    title: active ? 'Compte réactivé' : 'Compte suspendu',
    body:  active ? 'Votre compte ZUKAGO a été réactivé.' : 'Votre compte a été suspendu. Contactez le support.',
    type:  'info',
  }));

  res.json({ message: `Compte ${user.name} ${active ? 'réactivé' : 'suspendu'}` });
}));

// DELETE /api/admin/users/:id — Supprimer compte + cascade + vérification
router.delete('/users/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(`[Admin] DELETE /users/${id} by ${req.user?.email}`);

  const { data: user } = await db.from('users')
    .select('id, name, email, role').eq('id', id).maybeSingle();
  if (!user)                    return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (user.role === 'admin')    return res.status(403).json({ error: 'Impossible de supprimer un admin' });
  if (user.id === req.user.id)  return res.status(403).json({ error: 'Impossible de supprimer votre propre compte' });

  const log = [];

  try {
    // ─────────────────────────────────────────────────────────────
    // 1. Si partenaire → cascade sur annonces
    // ─────────────────────────────────────────────────────────────
    const { data: partner } = await db.from('partners')
      .select('id').eq('user_id', id).maybeSingle();

    if (partner) {
      log.push(`partner=${partner.id}`);

      const { data: listings } = await db.from('listings')
        .select('id, title').eq('partner_id', partner.id);
      const listingIds = (listings || []).map(l => l.id);
      log.push(`listings=${listingIds.length}`);

      if (listingIds.length) {
        // Notifier clients avec réservations actives
        const { data: activeBookings } = await db.from('bookings')
          .select('user_id').in('listing_id', listingIds)
          .in('status', ['pending', 'confirmed']);

        if (activeBookings?.length) {
          const uniqueClients = [...new Set(activeBookings.map(b => b.user_id))];
          await safe(db.from('notifications').insert(
            uniqueClients.map(cid => ({
              user_id: cid,
              title:   'Reservation annulee',
              body:    'Un partenaire a quitte la plateforme. Votre reservation a ete annulee. Contactez le support ZUKAGO.',
              type:    'info',
            }))
          ), 'client-notifs');
        }

        // Cascade manuelle
        await safe(db.from('reviews').delete().in('listing_id', listingIds),          'reviews');
        await safe(db.from('favorites').delete().in('listing_id', listingIds),        'favorites');
        await safe(db.from('listing_photos').delete().in('listing_id', listingIds),   'photos');
        await safe(db.from('listing_amenities').delete().in('listing_id', listingIds),'amenities');
        await safe(db.from('bookings').delete().in('listing_id', listingIds),         'bookings');
        await safe(db.from('listings').delete().in('id', listingIds),                 'listings');
      }

      await safe(db.from('withdrawals').delete().eq('partner_id', partner.id), 'withdrawals');
      await safe(db.from('partners').delete().eq('id', partner.id),            'partner');
      log.push('partner-deleted');
    }

    // ─────────────────────────────────────────────────────────────
    // 2. Nettoyage tables avec user_id
    // ⚠️ commissions n'a PAS de user_id (juste booking_id + partner_id)
    // ⚠️ donc PAS de db.from('commissions').delete().eq('user_id', id)
    // ─────────────────────────────────────────────────────────────
    await safe(db.from('bookings').delete().eq('user_id', id),      'user-bookings');
    await safe(db.from('reviews').delete().eq('user_id', id),       'user-reviews');
    await safe(db.from('favorites').delete().eq('user_id', id),     'user-favorites');
    await safe(db.from('push_tokens').delete().eq('user_id', id),   'user-tokens');
    await safe(db.from('notifications').delete().eq('user_id', id), 'user-notifs');
    await safe(db.from('payments').delete().eq('user_id', id),      'user-payments');
    log.push('user-tables-cleaned');

    // ─────────────────────────────────────────────────────────────
    // 3. Supprimer l'user
    // ─────────────────────────────────────────────────────────────
    const { error: delErr } = await db.from('users').delete().eq('id', id);
    if (delErr) {
      console.error('[Admin] users.delete error:', delErr, log);
      return res.status(500).json({
        error: `Impossible de supprimer l'utilisateur : ${delErr.message}`,
        log,
      });
    }

    // ─────────────────────────────────────────────────────────────
    // 4. VÉRIFICATION POST-DELETE
    // ─────────────────────────────────────────────────────────────
    const { data: stillExists } = await db.from('users').select('id').eq('id', id).maybeSingle();
    if (stillExists) {
      console.error('[Admin] ❌ User still exists after delete!', id, log);
      return res.status(500).json({
        error: 'La suppression a echoue (utilisateur toujours present). Verifiez les FK CASCADE.',
        log,
      });
    }

    console.log(`[Admin] ✅ User deleted: ${user.name} (${user.email})`, log);
    return res.json({
      message: `Compte de ${user.name} supprime avec toutes ses donnees.`,
      deleted: true,
    });

  } catch (e) {
    console.error('[Admin] Delete exception:', e.message, log);
    return res.status(500).json({
      error: 'Erreur suppression: ' + e.message,
      log,
    });
  }
}));

// ═══════════════════════════════════════════════════════════════════════════
// DELETE LISTINGS/PARTNERS — routes admin avec cascade + notifs
// ═══════════════════════════════════════════════════════════════════════════

// DELETE /api/admin/listings/:id — Force suppression annonce + cascade + notifs
router.delete('/listings/:id', asyncHandler(async (req, res) => {
  const { deleteImage } = require('../config/cloudinary');
  const listingId = req.params.id;
  console.log(`[Admin] DELETE /listings/${listingId} by ${req.user?.email}`);

  const { data: listing } = await db.from('listings')
    .select('id, title, partner_id').eq('id', listingId).maybeSingle();
  if (!listing) return res.status(404).json({ error: 'Annonce introuvable' });

  // Bookings actifs → notifier clients
  const { data: activeBookings } = await db.from('bookings')
    .select('id, user_id, status').eq('listing_id', listingId)
    .in('status', ['pending', 'confirmed']);

  if (activeBookings?.length) {
    const uniqueClients = [...new Set(activeBookings.map(b => b.user_id))];
    await safe(db.from('notifications').insert(
      uniqueClients.map(cid => ({
        user_id: cid,
        title:   'Reservation annulee',
        body:    `Votre reservation pour "${listing.title}" a ete annulee par l'administration ZUKAGO.`,
        type:    'info',
      }))
    ), 'listing-delete-clients');
  }

  // Notifier le partenaire
  if (listing.partner_id) {
    const { data: partnerRow } = await db.from('partners')
      .select('user_id').eq('id', listing.partner_id).maybeSingle();
    if (partnerRow?.user_id) {
      await safe(db.from('notifications').insert({
        user_id: partnerRow.user_id,
        title:   'Annonce supprimee par ZUKAGO',
        body:    `Votre annonce "${listing.title}" a ete supprimee. ${activeBookings?.length || 0} reservation(s) annulee(s).`,
        type:    'info',
      }), 'listing-delete-partner');
    }
  }

  // Photos Cloudinary
  const { data: photos } = await db.from('listing_photos')
    .select('public_id').eq('listing_id', listingId);
  if (photos?.length) {
    await Promise.allSettled(
      photos.filter(p => p.public_id).map(p => deleteImage(p.public_id).catch(() => null))
    );
  }

  // Cascade manuelle
  await safe(db.from('listing_photos').delete().eq('listing_id', listingId),    'ph');
  await safe(db.from('listing_amenities').delete().eq('listing_id', listingId), 'am');
  await safe(db.from('reviews').delete().eq('listing_id', listingId),           'rv');
  await safe(db.from('favorites').delete().eq('listing_id', listingId),         'fa');
  await safe(db.from('bookings').delete().eq('listing_id', listingId),          'bk');

  // Delete
  const { error } = await db.from('listings').delete().eq('id', listingId);
  if (error) return res.status(500).json({ error: `Erreur suppression : ${error.message}` });

  // Vérif post-delete
  const { data: stillExists } = await db.from('listings').select('id').eq('id', listingId).maybeSingle();
  if (stillExists) return res.status(500).json({ error: 'La suppression a echoue (ligne toujours presente).' });

  console.log(`[Admin] ✅ Listing deleted: ${listing.title}`);
  res.json({
    message: 'Annonce supprimee definitivement',
    deleted: true,
    bookings_cancelled: activeBookings?.length || 0,
  });
}));

// GET /api/admin/partners/:id/impact — Impact d'une suppression partenaire
router.get('/partners/:id/impact', asyncHandler(async (req, res) => {
  const partnerId = req.params.id;

  const { data: partner } = await db.from('partners')
    .select('id, user_id').eq('id', partnerId).maybeSingle();
  if (!partner) return res.status(404).json({ error: 'Partenaire introuvable' });

  const { data: user } = await db.from('users')
    .select('id, name').eq('id', partner.user_id).maybeSingle();

  const { data: listings } = await db.from('listings')
    .select('id').eq('partner_id', partnerId);
  const listingIds = (listings || []).map(l => l.id);

  let activeBookings = 0, pendingBookings = 0, confirmedBookings = 0, clientsAffected = 0;
  if (listingIds.length) {
    const { data: bookings } = await db.from('bookings')
      .select('user_id, status').in('listing_id', listingIds)
      .in('status', ['pending', 'confirmed']);
    if (bookings?.length) {
      activeBookings    = bookings.length;
      pendingBookings   = bookings.filter(b => b.status === 'pending').length;
      confirmedBookings = bookings.filter(b => b.status === 'confirmed').length;
      clientsAffected   = new Set(bookings.map(b => b.user_id)).size;
    }
  }

  res.json({
    partner_name:       user?.name || '',
    listings_count:     listingIds.length,
    active_bookings:    activeBookings,
    pending_bookings:   pendingBookings,
    confirmed_bookings: confirmedBookings,
    clients_affected:   clientsAffected,
  });
}));

// DELETE /api/admin/partners/:id — Force suppression partenaire + cascade totale
router.delete('/partners/:id', asyncHandler(async (req, res) => {
  const { deleteImage } = require('../config/cloudinary');
  const partnerId = req.params.id;
  console.log(`[Admin] DELETE /partners/${partnerId} by ${req.user?.email}`);

  const { data: partner } = await db.from('partners')
    .select('id, user_id').eq('id', partnerId).maybeSingle();
  if (!partner) return res.status(404).json({ error: 'Partenaire introuvable' });

  const { data: user } = await db.from('users')
    .select('id, name').eq('id', partner.user_id).maybeSingle();

  // Annonces
  const { data: listings } = await db.from('listings')
    .select('id, title').eq('partner_id', partnerId);
  const listingIds = (listings || []).map(l => l.id);

  if (listingIds.length) {
    // Notifier clients bookings actifs
    const { data: activeBookings } = await db.from('bookings')
      .select('user_id').in('listing_id', listingIds)
      .in('status', ['pending', 'confirmed']);
    if (activeBookings?.length) {
      const uniqueClients = [...new Set(activeBookings.map(b => b.user_id))];
      await safe(db.from('notifications').insert(
        uniqueClients.map(cid => ({
          user_id: cid,
          title:   'Reservation annulee',
          body:    `Le partenaire ${user?.name || ''} a ete retire de la plateforme. Votre reservation a ete annulee. Contactez le support pour un remboursement ou une alternative.`,
          type:    'info',
        }))
      ), 'partner-delete-clients');
    }

    // Photos Cloudinary
    const { data: photos } = await db.from('listing_photos')
      .select('public_id').in('listing_id', listingIds);
    if (photos?.length) {
      await Promise.allSettled(
        photos.filter(p => p.public_id).map(p => deleteImage(p.public_id).catch(() => null))
      );
    }

    // Cascade manuelle
    await safe(db.from('listing_photos').delete().in('listing_id', listingIds),    'ph');
    await safe(db.from('listing_amenities').delete().in('listing_id', listingIds), 'am');
    await safe(db.from('reviews').delete().in('listing_id', listingIds),           'rv');
    await safe(db.from('favorites').delete().in('listing_id', listingIds),         'fa');
    await safe(db.from('bookings').delete().in('listing_id', listingIds),          'bk');
    await safe(db.from('listings').delete().in('id', listingIds),                  'ls');
  }

  // Notifier le partenaire lui-même
  await safe(db.from('notifications').insert({
    user_id: partner.user_id,
    title:   'Compte partenaire supprime',
    body:    `Votre compte partenaire a ete supprime par l'administration ZUKAGO. Vous pouvez soumettre une nouvelle demande si besoin.`,
    type:    'info',
  }), 'partner-self-notif');

  // Retraits
  await safe(db.from('withdrawals').delete().eq('partner_id', partnerId), 'withdrawals');

  // Delete partner
  const { error } = await db.from('partners').delete().eq('id', partnerId);
  if (error) return res.status(500).json({ error: `Erreur suppression : ${error.message}` });

  // Vérif post-delete
  const { data: stillExists } = await db.from('partners').select('id').eq('id', partnerId).maybeSingle();
  if (stillExists) return res.status(500).json({ error: 'La suppression a echoue.' });

  // Remettre user en 'client'
  await safe(db.from('users').update({ role: 'client' }).eq('id', partner.user_id), 'role-client');

  console.log(`[Admin] ✅ Partner ${partnerId} deleted (${listingIds.length} listings)`);
  res.json({
    message:          `Partenaire ${user?.name || ''} supprime.`,
    deleted:          true,
    listings_deleted: listingIds.length,
  });
}));


// GET /api/admin/test-email — Tester Mailgun
router.get('/test-email', asyncHandler(async (req, res) => {
  const result = await emailService.testConnection();
  res.json({ result });
}));

module.exports = router;
