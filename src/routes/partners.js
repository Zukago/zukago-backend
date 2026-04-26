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
router.get('/stats', authenticate, asyncHandler(async (req, res) => {
  const { data: partner } = await db.from('partners').select('id, solde').eq('user_id', req.user.id).maybeSingle();
  // ✅ V10 : Plus d'auto-create. Si pas de profil partner → retourner stats vides.
  if (!partner) return res.json({
    totalListings: 0, activeListings: 0, totalBookings: 0, confirmedBookings: 0,
    revenuMois: 0, totalRevenu: 0, solde: 0,
  });

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
router.get('/listings', authenticate, asyncHandler(async (req, res) => {
  const { data: partner } = await db.from('partners').select('id').eq('user_id', req.user.id).maybeSingle();
  // ✅ V10 : Plus d'auto-create. Si pas de profil partner → pas d'annonces.
  if (!partner) return res.json({ listings: [] });

  const { data: listings } = await db.from('listings')
    .select('*, listing_photos(url, is_main)')
    .eq('partner_id', partner.id)
    .order('created_at', { ascending: false });

  res.json({ listings: listings || [] });
}));

// ─── GET /api/partners/bookings — Mes réservations ───────────────────────────
router.get('/bookings', authenticate, asyncHandler(async (req, res) => {
  const { data: partner } = await db.from('partners').select('id').eq('user_id', req.user.id).maybeSingle();
  // ✅ V10 : Plus d'auto-create. Si pas de profil partner → pas de réservations.
  if (!partner) return res.json({ bookings: [] });

  // Récupérer tous les listing_ids de ce partenaire (tous statuts, pas seulement active)
  const { data: myListings } = await db.from('listings')
    .select('id')
    .eq('partner_id', partner.id);

  const listingIds = (myListings || []).map(l => l.id);
  if (!listingIds.length) return res.json({ bookings: [] });

  // Récupérer les réservations — TOUS les statuts visibles (pending + confirmed + cancelled)
  const { data: bookings, error } = await db.from('bookings')
    .select(`
      *,
      listings(id, title, type, city_code, price, emoji, listing_photos(url, is_main)),
      users(id, name, email, phone, avatar)
    `)
    .in('listing_id', listingIds)
    .in('status', ['pending', 'confirmed', 'cancelled'])
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Partner bookings error:', error.message);
    return res.status(500).json({ error: error.message });
  }

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


// ─── GET /api/partners/status — Statut du compte partenaire ──────────────────
router.get('/status', authenticate, asyncHandler(async (req, res) => {
  const { data: partner } = await db.from('partners')
    .select(`
      id, status, type, cni_number, whatsapp, address, bio, rejection_msg, created_at,
      cni_recto_url, cni_verso_url, selfie_url,
      license_category, license_obtained, license_recto_url, license_verso_url, license_verified
    `)
    .eq('user_id', req.user.id)
    .maybeSingle();
  res.json({ partner: partner || null });
}));

// ─── POST /api/partners/request — Soumettre demande partenaire ───────────────
router.post('/request', authenticate, asyncHandler(async (req, res) => {
  const {
    type, cni_number, whatsapp, address, bio,
    // ✅ V12 KYC : photos identité (obligatoires)
    cni_recto_url, cni_verso_url, selfie_url,
    // ✅ V12 KYC : permis (optionnel — requis si pub voiture/chauffeur/covoit)
    license_category, license_obtained, license_recto_url, license_verso_url,
  } = req.body;

  if (!cni_number) return res.status(400).json({ error: 'Numéro CNI requis' });
  if (!whatsapp)   return res.status(400).json({ error: 'WhatsApp requis' });
  if (!address)    return res.status(400).json({ error: 'Adresse requise' });

  // ✅ V12 KYC : photos CNI obligatoires
  if (!cni_recto_url) return res.status(400).json({ error: 'Photo recto de la pièce d\'identité requise' });
  if (!selfie_url)    return res.status(400).json({ error: 'Selfie requis pour vérification' });

  // ✅ V12 : si l'user remplit le permis, vérifier cohérence (pas de demi-permis)
  const hasAnyLicenseField = license_category || license_obtained || license_recto_url || license_verso_url;
  if (hasAnyLicenseField) {
    if (!license_category || !license_obtained || !license_recto_url || !license_verso_url) {
      return res.status(400).json({
        error: 'Pour ajouter votre permis, tous les champs sont requis : catégorie, date, recto, verso',
      });
    }
  }

  console.log(`[Partners] POST /request by ${req.user.email}`);

  // Récupérer l'état actuel du user
  const { data: userRow } = await db.from('users')
    .select('id, role, verified, demande_verified').eq('id', req.user.id).maybeSingle();

  if (!userRow) return res.status(404).json({ error: 'Utilisateur introuvable' });

  // Si déjà validé par admin → rien à faire
  if (userRow.verified === true) {
    return res.status(409).json({ error: 'Votre compte partenaire est deja approuve' });
  }

  // Vérifier si demande déjà existante
  const { data: existing } = await db.from('partners')
    .select('id, status').eq('user_id', req.user.id).maybeSingle();

  // ═══ Construire le payload ═══
  const partnerPayload = {
    type:          type || 'proprietaire',
    cni_number,
    whatsapp,
    address,
    bio:           bio || '',
    status:        'pending',
    rejection_msg: null,
    // ✅ V12 KYC
    cni_recto_url,
    cni_verso_url:    cni_verso_url || null,
    selfie_url,
  };

  // ✅ V12 : ajouter permis seulement si fourni (sinon laisser NULL)
  if (hasAnyLicenseField) {
    partnerPayload.license_category   = license_category;
    partnerPayload.license_obtained   = license_obtained;
    partnerPayload.license_recto_url  = license_recto_url;
    partnerPayload.license_verso_url  = license_verso_url;
    partnerPayload.license_verified   = false; // l'admin doit valider
  }

  // ═══ INSERT ou UPDATE dans partners ═══
  let partnerSaveError = null;

  if (existing) {
    const { error } = await db.from('partners').update(partnerPayload).eq('id', existing.id);
    partnerSaveError = error;
    if (error) console.error(`[Partners] UPDATE error: ${error.message}`);
    else       console.log(`[Partners] ✅ UPDATE partner ${existing.id}`);
  } else {
    const { data: inserted, error } = await db.from('partners').insert({
      user_id: req.user.id,
      ...partnerPayload,
    }).select('id').maybeSingle();
    partnerSaveError = error;
    if (error) console.error(`[Partners] INSERT error: ${error.message}`);
    else       console.log(`[Partners] ✅ INSERT partner ${inserted?.id}`);
  }

  if (partnerSaveError) {
    return res.status(500).json({
      error:   'Impossible de sauvegarder la demande : ' + partnerSaveError.message,
      details: 'Colonne manquante ou contrainte DB. Contactez le support.',
    });
  }

  // ═══ UPDATE user : demande_verified=true seulement ═══
  const { error: updErr } = await db.from('users')
    .update({ demande_verified: true }).eq('id', req.user.id);
  if (updErr) {
    console.error(`[Partners] UPDATE user error: ${updErr.message}`);
    return res.status(500).json({ error: 'Erreur MAJ user : ' + updErr.message });
  }
  console.log(`[Partners] ✅ User ${req.user.email} : demande_verified=true (role inchangé: ${userRow.role})`);

  // Notification aux admins
  const { data: admins } = await db.from('users')
    .select('id').eq('role', 'admin').eq('active', true);

  if (admins?.length) {
    try {
      await db.from('notifications').insert(
        admins.map(a => ({
          user_id: a.id,
          title:   'Nouvelle demande partenaire',
          body:    `${req.user.name || 'Un utilisateur'} a soumis une demande partenaire (${type || 'proprietaire'}).`,
          type:    'partner',
        }))
      );
      console.log(`[Partners] ✅ ${admins.length} admin notifications sent`);
    } catch(e) { console.log(`[Partners] admin notif error: ${e.message}`); }
  }

  console.log(`[Partners] ✅ DONE - Request submitted by ${req.user.email}`);
  res.json({ message: 'Demande soumise avec succès. Vérification sous 24-48h.' });
}));

// ✅ V12 : POST /api/partners/license — Ajouter le permis APRÈS soumission (pour user déjà partenaire)
router.post('/license', authenticate, asyncHandler(async (req, res) => {
  const { license_category, license_obtained, license_recto_url, license_verso_url } = req.body;

  if (!license_category || !license_obtained || !license_recto_url || !license_verso_url) {
    return res.status(400).json({
      error: 'Tous les champs permis requis : catégorie, date, recto, verso',
    });
  }

  const { data: partner } = await db.from('partners')
    .select('id').eq('user_id', req.user.id).maybeSingle();
  if (!partner) return res.status(404).json({ error: 'Profil partenaire introuvable' });

  const { error } = await db.from('partners').update({
    license_category,
    license_obtained,
    license_recto_url,
    license_verso_url,
    license_verified: false, // admin doit re-valider
  }).eq('id', partner.id);

  if (error) return res.status(500).json({ error: error.message });

  console.log(`[Partners] ✅ Permis ajouté/mis à jour par ${req.user.email}`);
  res.json({ message: 'Permis enregistré. Vérification par notre équipe sous 24-48h.' });
}));

module.exports = router;
