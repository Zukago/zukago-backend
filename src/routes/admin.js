const express = require('express');
const db      = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const emailService = require('../services/emailService');
const commissionService = require('../services/commissionService');
const statsService      = require('../services/statsService');

const router = express.Router();
router.use(authenticate, requireAdmin);

// ─── PARTENAIRES ─────────────────────────────────────────────────────────────

// GET /api/admin/partners — Partenaires en attente de validation
// ✅ V10 : Filtre cohérent avec client-promotions
//   role='partner' + demande_verified=true + verified=false
// Retourne : liste d'users avec leur partner_info (CNI, whatsapp, etc.)
router.get('/partners', asyncHandler(async (req, res) => {
  const { data: users, error } = await db.from('users')
    .select('id, name, email, phone, whatsapp, avatar, role, demande_verified, verified, created_at')
    .eq('role', 'partner')
    .eq('demande_verified', true)
    .eq('verified', false)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[admin] GET /partners error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Joindre les détails de la table partners (CNI, whatsapp, address, bio, type...)
  const userIds = (users || []).map(u => u.id);
  let partnersMap = {};
  if (userIds.length > 0) {
    // ✅ V12 : récupérer aussi KYC photos + permis pour affichage admin complet
    const { data: partnersData } = await db.from('partners')
      .select(`
        id, user_id, type, status, cni_number, whatsapp, address, bio, created_at,
        cni_recto_url, cni_verso_url, selfie_url,
        license_category, license_obtained, license_recto_url, license_verso_url, license_verified
      `)
      .in('user_id', userIds);
    (partnersData || []).forEach(p => { partnersMap[p.user_id] = p; });
  }

  // Format compatible avec l'UI : { id (user.id), name, email, ..., partner_info, type }
  const partners = (users || []).map(u => ({
    ...u,
    partner_info: partnersMap[u.id] || null,
    type: partnersMap[u.id]?.type || 'proprietaire',
  }));

  res.json({ partners });
}));

// PATCH /api/admin/partners/:id/approve — Approuver partenaire
// ✅ V10 : :id = user.id (cohérent avec la nouvelle logique GET /partners et client-promotions)
router.patch('/partners/:id/approve', asyncHandler(async (req, res) => {
  const userId = req.params.id;

  const { data: user } = await db.from('users')
    .select('id, name, email, role').eq('id', userId).maybeSingle();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  // Mettre à jour la ligne partners si elle existe (détails de la demande)
  try {
    await db.from('partners').update({
      status:      'approved',
      approved_by: req.user.id,
      approved_at: new Date(),
    }).eq('user_id', userId);
  } catch (e) { console.log('Partner row update error:', e.message); }

  // ✅ V10 : 3 changements sur users (cohérent avec client-promotions/approve)
  // role=partner + demande_verified=true + verified=true
  await db.from('users').update({
    role:             'partner',
    demande_verified: true,
    verified:         true,
    updated_at:       new Date().toISOString(),
  }).eq('id', userId);

  // Notification in-app
  try {
    await db.from('notifications').insert({
      user_id: userId,
      title: '🎉 Compte partenaire approuvé !',
      body: `Bienvenue ${user.name} ! Vous pouvez maintenant publier vos annonces sur ZUKAGO.`,
      type: 'info',
    });
  } catch(e) { console.log('Notif partner approve error:', e.message); }

  // Email de confirmation
  try { await emailService.sendPartnerApproved(user); } catch(e) {}

  // Mettre à jour stats_daily
  statsService.updateDay();

  res.json({ message: `Partenaire ${user.name} approuvé` });
}));

// PATCH /api/admin/partners/:id/reject — Rejeter partenaire
// ✅ V10 : :id = user.id (cohérent avec approve)
router.patch('/partners/:id/reject', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { message } = req.body;

  const { data: user } = await db.from('users')
    .select('id, name, email').eq('id', userId).maybeSingle();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  // Mettre à jour la ligne partners si elle existe
  try {
    await db.from('partners').update({
      status:        'rejected',
      rejection_msg: message,
    }).eq('user_id', userId);
  } catch (e) { console.log('Partner row update error:', e.message); }

  // Reset demande_verified sur user (pour qu'il puisse re-soumettre)
  try {
    await db.from('users').update({
      demande_verified: false,
      updated_at:       new Date().toISOString(),
    }).eq('id', userId);
  } catch (e) { console.log('User reset on reject error:', e.message); }

  // Notification in-app
  try {
    await db.from('notifications').insert({
      user_id: userId,
      title: 'Demande partenaire refusée',
      body: `Votre demande partenaire n'a pas ete approuvee. ${message ? 'Raison : ' + message : 'Contactez le support.'}`,
      type: 'info',
    });
  } catch(e) { console.log('Notif partner reject error:', e.message); }

  try { await emailService.sendPartnerRejected(user, message); } catch(e) {}

  res.json({ message: 'Partenaire rejeté' });
}));

// PATCH /api/admin/partners/:id/suspend — Suspendre
router.patch('/partners/:id/suspend', asyncHandler(async (req, res) => {
  await db.from('partners').update({ status: 'suspended' }).eq('user_id', req.params.id);
  res.json({ message: 'Partenaire suspendu' });
}));

// GET /api/admin/partners/:id/impact — Impact de la suppression d'un partenaire
// ✅ V10 : :id = user.id (cohérent avec approve/reject)
router.get('/partners/:id/impact', asyncHandler(async (req, res) => {
  const userId = req.params.id;

  // Récupérer le profil partner
  const { data: partnerRow } = await db.from('partners')
    .select('id').eq('user_id', userId).maybeSingle();

  if (!partnerRow) {
    return res.json({ listings_count: 0, active_bookings: 0, confirmed_bookings: 0, clients_affected: 0 });
  }

  // Annonces du partenaire
  const { data: listings } = await db.from('listings')
    .select('id').eq('partner_id', partnerRow.id);
  const listingIds = (listings || []).map(l => l.id);

  let activeBookings = 0;
  let confirmedBookings = 0;
  let clientsAffected = 0;

  if (listingIds.length > 0) {
    const { data: bookings } = await db.from('bookings')
      .select('user_id, status')
      .in('listing_id', listingIds)
      .in('status', ['pending', 'confirmed']);

    activeBookings    = (bookings || []).length;
    confirmedBookings = (bookings || []).filter(b => b.status === 'confirmed').length;
    clientsAffected   = new Set((bookings || []).map(b => b.user_id)).size;
  }

  res.json({
    listings_count:     listingIds.length,
    active_bookings:    activeBookings,
    confirmed_bookings: confirmedBookings,
    clients_affected:   clientsAffected,
  });
}));

// DELETE /api/admin/partners/:id — Supprimer le partenaire (remet en client)
// ✅ V10 : :id = user.id. Garde l'user mais retire son statut partenaire.
router.delete('/partners/:id', asyncHandler(async (req, res) => {
  const userId = req.params.id;

  const { data: user } = await db.from('users')
    .select('id, name, email, role').eq('id', userId).maybeSingle();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (user.role === 'admin') return res.status(403).json({ error: 'Impossible de modifier un admin' });

  const log = [];

  // Récupérer le profil partner
  const { data: partnerRow } = await db.from('partners')
    .select('id').eq('user_id', userId).maybeSingle();

  let listingsDeleted = 0;

  if (partnerRow) {
    // Annonces du partenaire → cascade
    const { data: listings } = await db.from('listings')
      .select('id, title').eq('partner_id', partnerRow.id);
    const listingIds = (listings || []).map(l => l.id);
    log.push(`Listings: ${listingIds.length}`);

    if (listingIds.length > 0) {
      // Notifier les clients avec réservations actives
      const { data: activeBookings } = await db.from('bookings')
        .select('id, user_id')
        .in('listing_id', listingIds)
        .in('status', ['pending', 'confirmed']);

      if (activeBookings?.length) {
        const uniqueClientIds = [...new Set(activeBookings.map(b => b.user_id))];
        try {
          await db.from('notifications').insert(
            uniqueClientIds.map(cid => ({
              user_id: cid,
              title:   'Réservation annulée',
              body:    `Le partenaire (${user.name}) a été retiré de la plateforme. Votre réservation a été annulée. Contactez le support ZUKAGO.`,
              type:    'info',
            }))
          );
        } catch (e) { log.push(`Client notif error: ${e.message}`); }
      }

      // Cloudinary
      const { data: photos } = await db.from('listing_photos')
        .select('public_id').in('listing_id', listingIds);
      if (photos?.length) {
        const { deleteImage } = require('../config/cloudinary');
        await Promise.allSettled(
          photos.filter(p => p.public_id).map(p => deleteImage(p.public_id).catch(() => null))
        );
      }

      // Cascade DB
      try { await db.from('reviews').delete().in('listing_id', listingIds); } catch (e) { log.push(`reviews: ${e.message}`); }
      try { await db.from('favorites').delete().in('listing_id', listingIds); } catch (e) { log.push(`favorites: ${e.message}`); }
      try { await db.from('listing_photos').delete().in('listing_id', listingIds); } catch (e) { log.push(`listing_photos: ${e.message}`); }
      try { await db.from('listing_amenities').delete().in('listing_id', listingIds); } catch (e) { log.push(`listing_amenities: ${e.message}`); }
      try { await db.from('bookings').delete().in('listing_id', listingIds); } catch (e) { log.push(`bookings: ${e.message}`); }

      await db.from('listings').delete().in('id', listingIds);
      listingsDeleted = listingIds.length;
    }

    // Retraits du partenaire
    try { await db.from('withdrawals').delete().eq('partner_id', partnerRow.id); } catch (e) { log.push(`withdrawals: ${e.message}`); }

    // Supprimer le profil partner lui-même
    await db.from('partners').delete().eq('id', partnerRow.id);
    log.push('Partner profile deleted');
  }

  // Remettre l'utilisateur en client (ne PAS supprimer le compte)
  await db.from('users').update({
    role:             'client',
    demande_verified: false,
    verified:         false,
    updated_at:       new Date().toISOString(),
  }).eq('id', userId);

  // Notifier le user
  try {
    await db.from('notifications').insert({
      user_id: userId,
      title:   'Statut partenaire retiré',
      body:    'Votre compte a été remis en statut client. Contactez le support ZUKAGO pour plus d\'informations.',
      type:    'info',
    });
  } catch (e) { /* ignore */ }

  console.log(`[Admin] ✅ Partner ${user.email} removed — back to client`, log);
  res.json({
    message:          `Partenaire ${user.name} supprimé (compte remis en client)`,
    listings_deleted: listingsDeleted,
    log,
  });
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
  try {
    await db.from('notifications').insert({
      user_id: req.params.id,
      title: active ? 'Compte réactivé' : 'Compte suspendu',
      body:  active ? 'Votre compte ZUKAGO a été réactivé.' : 'Votre compte a été suspendu. Contactez le support.',
      type:  'info',
    });
  } catch (e) { /* notif non bloquante */ }

  res.json({ message: `Compte ${user.name} ${active ? 'réactivé' : 'suspendu'}` });
}));

// DELETE /api/admin/users/:id — Supprimer compte + cascade complète
router.delete('/users/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { data: user } = await db.from('users')
    .select('id, name, email, role').eq('id', id).single();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (user.role === 'admin') return res.status(403).json({ error: 'Impossible de supprimer un admin' });
  if (user.id === req.user.id) return res.status(403).json({ error: 'Impossible de supprimer votre propre compte' });

  const { deleteImage } = require('../config/cloudinary');
  const log = [];

  try {
    // ─────────────────────────────────────────────────────────────────
    // 1. Si PARTENAIRE → cascade totale sur ses annonces
    // ─────────────────────────────────────────────────────────────────
    const { data: partner } = await db.from('partners')
      .select('id').eq('user_id', id).single();

    if (partner) {
      log.push(`Partner found: ${partner.id}`);

      // 1a. Récupérer toutes ses annonces
      const { data: listings } = await db.from('listings')
        .select('id, title').eq('partner_id', partner.id);
      const listingIds = (listings || []).map(l => l.id);
      log.push(`Listings: ${listingIds.length}`);

      if (listingIds.length) {
        // 1b. Clients avec réservations actives → notifier + annuler
        const { data: activeBookings } = await db.from('bookings')
          .select('id, user_id, status')
          .in('listing_id', listingIds)
          .in('status', ['pending', 'confirmed']);

        if (activeBookings?.length) {
          const uniqueClientIds = [...new Set(activeBookings.map(b => b.user_id))];
          log.push(`Clients to notify: ${uniqueClientIds.length}`);

          await db.from('notifications').insert(
            uniqueClientIds.map(clientId => ({
              user_id: clientId,
              title:   'Réservation annulée',
              body:    `Le partenaire a quitté la plateforme. Votre réservation pour "${user.name}" a été annulée. Contactez le support ZUKAGO pour un remboursement ou une alternative.`,
              type:    'info',
            }))
          ).catch(e => log.push(`Client notif error: ${e.message}`));
        }

        // 1c. Supprimer photos Cloudinary
        const { data: photos } = await db.from('listing_photos')
          .select('public_id').in('listing_id', listingIds);
        if (photos?.length) {
          log.push(`Cloudinary photos: ${photos.length}`);
          await Promise.allSettled(
            photos
              .filter(p => p.public_id)
              .map(p => deleteImage(p.public_id).catch(() => null))
          );
        }

        // 1d. Cascade DB : supprimer tout ce qui référence ces listings
        const cascadeListings = async () => {
          try { await db.from('reviews').delete().in('listing_id', listingIds); } catch (e) { log.push(`reviews cascade: ${e.message}`); }
          try { await db.from('favorites').delete().in('listing_id', listingIds); } catch (e) { log.push(`favorites cascade: ${e.message}`); }
          try { await db.from('listing_photos').delete().in('listing_id', listingIds); } catch (e) { log.push(`listing_photos cascade: ${e.message}`); }
          try { await db.from('listing_amenities').delete().in('listing_id', listingIds); } catch (e) { log.push(`listing_amenities cascade: ${e.message}`); }
          try { await db.from('bookings').delete().in('listing_id', listingIds); } catch (e) { log.push(`bookings cascade: ${e.message}`); }
        };
        await cascadeListings();

        // 1e. Supprimer les annonces
        await db.from('listings').delete().in('id', listingIds);
        log.push(`Listings deleted`);
      }

      // 1f. Supprimer retraits du partenaire
      try { await db.from('withdrawals').delete().eq('partner_id', partner.id); } catch (e) { log.push(`withdrawals: ${e.message}`); }

      // 1g. Supprimer le profil partenaire
      await db.from('partners').delete().eq('id', partner.id);
      log.push(`Partner profile deleted`);
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. Données du USER (en tant que client OU autre)
    // ─────────────────────────────────────────────────────────────────
    const safeDelete = async (table, field = 'user_id') => {
      try {
        await db.from(table).delete().eq(field, id);
      } catch (e) {
        log.push(`${table} cleanup: ${e.message}`);
      }
    };
    await safeDelete('bookings');
    await safeDelete('reviews');
    await safeDelete('favorites');
    await safeDelete('push_tokens');
    await safeDelete('notifications');
    await safeDelete('payments');
    await safeDelete('commissions');
    log.push(`User-related tables cleaned`);

    // ─────────────────────────────────────────────────────────────────
    // 3. Supprimer l'utilisateur lui-même
    // ─────────────────────────────────────────────────────────────────
    const { error: delErr } = await db.from('users').delete().eq('id', id);
    if (delErr) {
      console.error('[Admin Delete] users.delete error:', delErr);
      return res.status(500).json({
        error: `Impossible de supprimer l'utilisateur : ${delErr.message}`,
        log,
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 4. Vérifier que le user a bien disparu
    // ─────────────────────────────────────────────────────────────────
    const { data: stillExists } = await db.from('users').select('id').eq('id', id).single();
    if (stillExists) {
      console.error('[Admin Delete] User still exists after delete!', id);
      return res.status(500).json({
        error: 'La suppression a échoué (utilisateur toujours présent). Vérifiez les contraintes FK.',
        log,
      });
    }

    console.log(`[Admin] ✅ User deleted: ${user.name} (${user.email})`, log);
    res.json({
      message: `Compte de ${user.name} supprimé avec toutes ses données.`,
      deleted: true,
    });

  } catch (e) {
    console.error('[Admin Delete] Error:', e.message, log);
    return res.status(500).json({
      error: 'Erreur suppression: ' + e.message,
      log,
    });
  }
}));


// GET /api/admin/test-email — Tester Mailgun
router.get('/test-email', asyncHandler(async (req, res) => {
  const result = await emailService.testConnection();
  res.json({ result });
}));

// ═══════════════════════════════════════════════════════════════════════════
// ✅ V9 : CLIENT PROMOTIONS — Clients en attente de devenir partenaire
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/client-promotions — Liste clients ayant soumis une demande
router.get('/client-promotions', asyncHandler(async (req, res) => {
  const { data, error } = await db.from('users')
    .select('id, name, email, phone, whatsapp, role, demande_verified, verified, avatar, created_at')
    .eq('role', 'client')
    .eq('demande_verified', true)
    .eq('verified', false)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[admin] client-promotions error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Optionnel : joindre les infos de la table partners pour voir les détails de la demande
  const userIds = (data || []).map(u => u.id);
  let partnersMap = {};
  if (userIds.length > 0) {
    // ✅ V12 : récupérer TOUS les champs nécessaires (KYC photos + permis + infos)
    const { data: partnersData } = await db.from('partners')
      .select(`
        id, user_id, type, status, cni_number, whatsapp, address, bio,
        rejection_msg, created_at,
        cni_recto_url, cni_verso_url, selfie_url,
        license_category, license_obtained, license_recto_url, license_verso_url, license_verified
      `)
      .in('user_id', userIds);
    (partnersData || []).forEach(p => { partnersMap[p.user_id] = p; });
  }

  const enriched = (data || []).map(u => ({
    ...u,
    partner_info: partnersMap[u.id] || null,
  }));

  res.json({ users: enriched, count: enriched.length });
}));

// GET /api/admin/client-promotions/:userId — Détail d'un client à promouvoir
router.get('/client-promotions/:userId', asyncHandler(async (req, res) => {
  const { data: user, error: userErr } = await db.from('users')
    .select('id, name, email, phone, whatsapp, role, demande_verified, verified, avatar, created_at')
    .eq('id', req.params.userId)
    .maybeSingle();

  if (userErr || !user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  // Récupérer détails de la demande partenaire
  const { data: partner } = await db.from('partners')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  res.json({ user, partner });
}));

// PATCH /api/admin/client-promotions/:userId/approve — Approuver (3 changements)
router.patch('/client-promotions/:userId/approve', asyncHandler(async (req, res) => {
  const userId = req.params.userId;

  // Vérifier que c'est bien un client en attente
  const { data: existingUser, error: checkErr } = await db.from('users')
    .select('id, role, demande_verified, verified')
    .eq('id', userId)
    .maybeSingle();

  if (checkErr || !existingUser) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (existingUser.role !== 'client') return res.status(400).json({ error: 'Cet utilisateur n\'est pas un client' });

  // ✅ 3 CHANGEMENTS SIMULTANÉS pour un client → partenaire
  const { data, error } = await db.from('users')
    .update({
      role:              'partner',
      demande_verified:  true,
      verified:          true,
      updated_at:        new Date().toISOString(),
    })
    .eq('id', userId)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[admin] approve client error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Aussi mettre à jour partners.status si une ligne existe
  try {
    await db.from('partners')
      .update({ status: 'approved' })
      .eq('user_id', userId);
  } catch (e) { /* ignore */ }

  // Notification au user
  try {
    await db.from('notifications').insert({
      user_id: userId,
      title:   'Félicitations ! Vous êtes maintenant partenaire ZUKAGO 🎉',
      body:    'Votre demande a été approuvée. Vous pouvez maintenant publier vos annonces.',
      type:    'success',
    });
  } catch (e) { /* ignore */ }

  console.log(`[admin] ✅ Client ${userId} promu partenaire`);
  res.json({ user: data, message: 'Client approuvé avec succès' });
}));

// PATCH /api/admin/client-promotions/:userId/reject — Refuser (reset demande_verified)
router.patch('/client-promotions/:userId/reject', asyncHandler(async (req, res) => {
  const userId = req.params.userId;
  const { message } = req.body || {};

  const { data, error } = await db.from('users')
    .update({
      demande_verified: false,
      updated_at:       new Date().toISOString(),
    })
    .eq('id', userId)
    .eq('role', 'client')
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  // Mettre la demande partners à rejected
  try {
    await db.from('partners')
      .update({ status: 'rejected', rejection_msg: message || null })
      .eq('user_id', userId);
  } catch (e) { /* ignore */ }

  // Notif
  try {
    await db.from('notifications').insert({
      user_id: userId,
      title:   'Demande partenaire non retenue',
      body:    message || 'Votre demande n\'a pas pu être validée. Vous pouvez la re-soumettre.',
      type:    'info',
    });
  } catch (e) { /* ignore */ }

  console.log(`[admin] ❌ Client ${userId} refusé`);
  res.json({ user: data, message: 'Demande refusée' });
}));

module.exports = router;
