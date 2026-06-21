const express = require('express');
const db = require('../config/database');
const { authenticate, requirePartner } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const commissionService = require('../services/commissionService');
const i18n = require('../services/i18nService');
// ✅ V14.5.4 : Helper centralisé notification (DB insert + push Expo)
const { notifyUser, notifyUsers } = require('../services/notifyUser');

const router = express.Router();

// ✅ V14.5.3 i18n : helper langue
// Routes auth → req.user.id ; route publique /public/:user_id → fallback header
async function _resolveLang(req) {
  if (req.user?.id) {
    try { return await i18n.getUserLang(req.user.id); } catch (e) {}
  }
  const accept = req.headers['accept-language'] || '';
  const code = accept.split(',')[0]?.slice(0, 2).toLowerCase();
  if (['fr', 'en', 'de'].includes(code)) return code;
  return 'fr';
}

// ─── GET /api/partners/me — Mon profil partenaire ────────────────────────────
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { data: partner } = await db.from('partners')
    .select('*, users!partners_user_id_fkey(name, email, avatar, phone, whatsapp)')
    .eq('user_id', req.user.id).single();
  if (!partner) {
    const L = await _resolveLang(req);
    return res.status(404).json({ error: await i18n.t('partners_error_profile_not_found', L, 'Profil partenaire introuvable') });
  }
  res.json({ partner });
}));

// ─── GET /api/partners/public/:user_id — Profil PUBLIC d'un conducteur ──────
// V13.5.9 : profil affichable à tous les passagers (BlaBlaCar style)
// Aucune donnée sensible exposée (CNI, photos, adresse, téléphone)
// Toutes les stats (note moyenne, nb trajets, nb avis) sont calculées dynamiquement
router.get('/public/:user_id', asyncHandler(async (req, res) => {
  const userId = req.params.user_id;
  if (!userId) {
    const L = await _resolveLang(req);
    return res.status(400).json({ error: await i18n.t('partners_error_user_id_required', L, 'user_id requis') });
  }

  // 1. Données utilisateur (publiques uniquement)
  const { data: userRow } = await db.from('users')
    .select('id, name, avatar, verified, created_at')
    .eq('id', userId)
    .maybeSingle();

  if (!userRow) {
    const L = await _resolveLang(req);
    return res.status(404).json({ error: await i18n.t('partners_error_user_not_found', L, 'Utilisateur introuvable') });
  }

  // 2. Données partenaire (filtrer les sensibles)
  const { data: partnerRow } = await db.from('partners')
    .select('id, type, bio, status, license_category, license_obtained, license_verified, cni_recto_url, selfie_url, created_at')
    .eq('user_id', userId)
    .maybeSingle();

  // Vérifications publiques (sans exposer les URLs des photos sensibles)
  // ✅ V13.5.13 : Logique métier ZUKAGO :
  //   - users.verified = true  → admin a TOUT validé (CNI + selfie + permis OK)
  //   - users.demande_verified = true → demande soumise, en attente admin
  // Donc si users.verified = true, toutes les vérifications sont OK car obligatoires
  // pour publier des annonces.
  const isFullyVerified = !!userRow.verified;
  const verifications = {
    email:           !!userRow.verified,
    cni_submitted:   isFullyVerified && !!(partnerRow?.cni_recto_url),
    selfie_submitted: isFullyVerified && !!(partnerRow?.selfie_url),
    license_verified: isFullyVerified && !!(partnerRow?.license_obtained || partnerRow?.license_verified),
    partner_active:  isFullyVerified,
  };

  // Année d'obtention du permis + années d'expérience
  let licenseInfo = null;
  if (partnerRow?.license_obtained) {
    const obtainedDate  = new Date(partnerRow.license_obtained);
    const obtainedYear  = obtainedDate.getFullYear();
    const yearsExp      = Math.max(0, new Date().getFullYear() - obtainedYear);
    licenseInfo = {
      category:         partnerRow.license_category || null,
      obtained_year:    obtainedYear,
      years_experience: yearsExp,
    };
  }

  // 3. Stats dynamiques : note moyenne + nb avis (via target_user_id pour covoit, fallback partner-listing)
  let ratingAverage = null;
  let ratingCount   = 0;

  // 3a. Avis directement liés au conducteur (covoit avec target_user_id)
  const { data: directReviews } = await db.from('reviews')
    .select('rating')
    .eq('target_user_id', userId)
    .eq('visible', true)
    .eq('verified', true);

  // 3b. Avis liés aux annonces du partenaire (apt/hotel/car/driver)
  let partnerReviews = [];
  if (partnerRow?.id) {
    const { data: partnerListings } = await db.from('listings')
      .select('id')
      .eq('partner_id', partnerRow.id);
    const listingIds = (partnerListings || []).map(l => l.id);

    if (listingIds.length > 0) {
      const { data: revs } = await db.from('reviews')
        .select('rating')
        .in('listing_id', listingIds)
        .eq('visible', true)
        .eq('verified', true)
        .is('target_user_id', null); // éviter le double comptage avec les avis covoit
      partnerReviews = revs || [];
    }
  }

  const allRatings = [...(directReviews || []), ...partnerReviews].map(r => Number(r.rating)).filter(n => Number.isFinite(n));
  if (allRatings.length > 0) {
    ratingCount   = allRatings.length;
    ratingAverage = Number((allRatings.reduce((s, n) => s + n, 0) / allRatings.length).toFixed(1));
  }

  // 4. Stats trajets/réservations effectués (bookings confirmed sur listings du partenaire, dont la date est passée)
  let tripsCompleted = 0;
  if (partnerRow?.id) {
    const today = new Date().toISOString().slice(0, 10);
    const { data: partnerListings } = await db.from('listings')
      .select('id')
      .eq('partner_id', partnerRow.id);
    const listingIds = (partnerListings || []).map(l => l.id);

    if (listingIds.length > 0) {
      const { count } = await db.from('bookings')
        .select('id', { count: 'exact', head: true })
        .in('listing_id', listingIds)
        .eq('status', 'confirmed')
        .lt('start_date', today);
      tripsCompleted = count || 0;
    }
  }

  // 5. Récupérer les 5 derniers avis avec les noms des passagers
  let reviewsList = [];
  if (partnerRow?.id) {
    // Construire un OR : reviews avec target_user_id = userId  OU  reviews sur les listings du partenaire
    const { data: partnerListings } = await db.from('listings')
      .select('id')
      .eq('partner_id', partnerRow.id);
    const listingIds = (partnerListings || []).map(l => l.id);

    // Avis covoit (target_user_id)
    const { data: revsDirect } = await db.from('reviews')
      .select('id, rating, comment, created_at, users!reviews_user_id_fkey(name, avatar)')
      .eq('target_user_id', userId)
      .eq('visible', true)
      .eq('verified', true)
      .order('created_at', { ascending: false })
      .limit(5);

    // Avis sur listings du partenaire (apt/hotel/car/driver)
    let revsListings = [];
    if (listingIds.length > 0) {
      const { data } = await db.from('reviews')
        .select('id, rating, comment, created_at, users!reviews_user_id_fkey(name, avatar)')
        .in('listing_id', listingIds)
        .eq('visible', true)
        .eq('verified', true)
        .is('target_user_id', null)
        .order('created_at', { ascending: false })
        .limit(5);
      revsListings = data || [];
    }

    // Fusionner et trier par date desc, max 5
    reviewsList = [...(revsDirect || []), ...revsListings]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5)
      .map(r => {
        const u = Array.isArray(r.users) ? r.users[0] : r.users;
        return {
          id:         r.id,
          rating:     Number(r.rating) || 0,
          comment:    typeof r.comment === 'string' ? r.comment : '',
          name:       (u && typeof u.name === 'string') ? u.name : 'Client',
          avatar:     (u && typeof u.avatar === 'string') ? u.avatar : null,
          created_at: r.created_at,
        };
      });
  }

  // 6. Réponse finale
  res.json({
    partner: {
      user_id:         userRow.id,
      name:            userRow.name || 'Conducteur',
      avatar:          userRow.avatar || null,
      verified:        !!userRow.verified,
      member_since:    userRow.created_at || null,
      bio:             (partnerRow?.bio && typeof partnerRow.bio === 'string') ? partnerRow.bio : '',
      type:            partnerRow?.type || null,
      partner_status:  partnerRow?.status || null,
      rating_average:  ratingAverage,
      rating_count:    ratingCount,
      trips_completed: tripsCompleted,
      verifications,
      license_info:    licenseInfo,
    },
    reviews: reviewsList,
  });
}));

// ─── GET /api/partners/stats — Stats du partenaire ───────────────────────────
router.get('/stats', authenticate, asyncHandler(async (req, res) => {
  const { data: partner } = await db.from('partners').select('id, solde').eq('user_id', req.user.id).maybeSingle();
  // ✅ V10 : Plus d'auto-create. Si pas de profil partner → retourner stats vides.
  if (!partner) return res.json({
    totalListings: 0, activeListings: 0, totalBookings: 0, confirmedBookings: 0,
    revenuMois: 0, totalRevenu: 0, solde: 0, pendingBalance: 0,
  });

  // ✅ V14.8 Séquestre : libérer les séjours terminés (+24h) puis lire les soldes à jour
  //    (non bloquant : si la colonne n'est pas encore migrée, on n'empêche pas le dashboard)
  let pendingBalance = 0;
  let soldeDispo = Number(partner.solde || 0);
  try {
    await commissionService.releaseMatured(partner.id);
    pendingBalance = await commissionService.getPendingBalance(partner.id);
    const { data: freshPartner } = await db.from('partners').select('solde').eq('id', partner.id).single();
    soldeDispo = Number(freshPartner?.solde || 0);
  } catch (e) { console.log('[stats sequestre]', e.message); }

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
    db.from('bookings').select('partner_gets').eq('status', 'confirmed').gte('created_at', firstOfMonth)
      .in('listing_id', (await db.from('listings').select('id').eq('partner_id', partner.id)).data?.map(l=>l.id)||[]),
    db.from('bookings').select('partner_gets').eq('status', 'confirmed')
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
    solde: soldeDispo,
    pendingBalance,
  });
}));


// ─── GET /api/partners/listings — Mes annonces ───────────────────────────────
router.get('/listings', authenticate, asyncHandler(async (req, res) => {
  const { data: partner } = await db.from('partners').select('id').eq('user_id', req.user.id).maybeSingle();
  // ✅ V10 : Plus d'auto-create. Si pas de profil partner → pas d'annonces.
  if (!partner) return res.json({ listings: [] });

  const { data: listings } = await db.from('listings')
    .select('*, listing_photos(url, is_main), listing_amenities(amenity_code), room_types:listing_room_types(*)')
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
  const L = await _resolveLang(req);
  if (!amount || amount <= 0) return res.status(400).json({ error: await i18n.t('partners_error_invalid_amount', L, 'Montant invalide') });

  const { data: partner } = await db.from('partners').select('id, solde').eq('user_id', req.user.id).single();
  // ✅ V14.8 Séquestre : libérer les fonds mûrs (non bloquant), puis vérifier le solde DISPONIBLE
  try { await commissionService.releaseMatured(partner.id); } catch (e) { console.log('[withdraw releaseMatured]', e.message); }
  const { data: freshPartner } = await db.from('partners').select('solde').eq('id', partner.id).single();
  const soldeDispo = Number(freshPartner?.solde || 0);
  if (soldeDispo < amount) return res.status(400).json({ error: await i18n.t('partners_error_insufficient_balance', L, 'Solde insuffisant ({balance} FCFA)', { balance: soldeDispo }) });

  const { data: withdrawal } = await db.from('withdrawals').insert({
    partner_id: partner.id, amount, method, account, status: 'pending',
  }).select().single();

  res.status(201).json({ withdrawal, message: await i18n.t('partners_withdraw_submitted', L, 'Demande de retrait soumise. Traitement sous 48h.') });
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
  // ✅ V14.5.3 i18n : résoudre la langue de l'user
  const L = await i18n.getUserLang(req.user.id);

  if (!cni_number) return res.status(400).json({ error: await i18n.t('partners_error_cni_required', L, 'Numéro CNI requis') });
  if (!whatsapp)   return res.status(400).json({ error: await i18n.t('partners_error_whatsapp_required', L, 'WhatsApp requis') });
  if (!address)    return res.status(400).json({ error: await i18n.t('partners_error_address_required', L, 'Adresse requise') });

  // ✅ V12 KYC : photos CNI obligatoires
  if (!cni_recto_url) return res.status(400).json({ error: await i18n.t('partners_error_cni_recto_required', L, 'Photo recto de la pièce d\'identité requise') });
  if (!selfie_url)    return res.status(400).json({ error: await i18n.t('partners_error_selfie_required', L, 'Selfie requis pour vérification') });

  // ✅ V12 : si l'user remplit le permis, vérifier cohérence (pas de demi-permis)
  const hasAnyLicenseField = license_category || license_obtained || license_recto_url || license_verso_url;
  if (hasAnyLicenseField) {
    if (!license_category || !license_obtained || !license_recto_url || !license_verso_url) {
      return res.status(400).json({
        error: await i18n.t('partners_error_license_incomplete', L, 'Pour ajouter votre permis, tous les champs sont requis : catégorie, date, recto, verso'),
      });
    }
  }

  console.log(`[Partners] POST /request by ${req.user.email}`);

  // Récupérer l'état actuel du user
  const { data: userRow } = await db.from('users')
    .select('id, role, verified, demande_verified').eq('id', req.user.id).maybeSingle();

  if (!userRow) return res.status(404).json({ error: await i18n.t('partners_error_user_not_found', L, 'Utilisateur introuvable') });

  // Si déjà validé par admin → rien à faire
  if (userRow.verified === true) {
    return res.status(409).json({ error: await i18n.t('partners_error_already_approved', L, 'Votre compte partenaire est deja approuve') });
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
      error:   await i18n.t('partners_error_save_failed', L, 'Impossible de sauvegarder la demande : {detail}', { detail: partnerSaveError.message }),
      details: await i18n.t('partners_error_save_details', L, 'Colonne manquante ou contrainte DB. Contactez le support.'),
    });
  }

  // ═══ UPDATE user : demande_verified=true seulement ═══
  const { error: updErr } = await db.from('users')
    .update({ demande_verified: true }).eq('id', req.user.id);
  if (updErr) {
    console.error(`[Partners] UPDATE user error: ${updErr.message}`);
    return res.status(500).json({ error: await i18n.t('partners_error_update_user', L, 'Erreur MAJ user : {detail}', { detail: updErr.message }) });
  }
  console.log(`[Partners] ✅ User ${req.user.email} : demande_verified=true (role inchangé: ${userRow.role})`);

  // Notification aux admins
  const { data: admins } = await db.from('users')
    .select('id').eq('role', 'admin').eq('active', true);

  if (admins?.length) {
    try {
      // ✅ V14.5.3 i18n : chaque admin reçoit la notif dans sa langue
      // ✅ V14.5.4 : notifyUser() par admin (langues différentes — pas de batch)
      const userName = req.user.name || null;
      const requestType = type || null;
      await Promise.all(
        admins.map(async (a) => {
          const adminLang = await i18n.getUserLang(a.id);
          const userNameTranslated = userName || await i18n.t('partners_a_user', adminLang, 'Un utilisateur');
          const typeTranslated = requestType || await i18n.t('partners_default_type', adminLang, 'proprietaire');
          return notifyUser(a.id, {
            title: await i18n.t('notif_new_partner_request_title', adminLang, 'Nouvelle demande partenaire'),
            body:  await i18n.t('notif_new_partner_request_body',  adminLang, '{name} a soumis une demande partenaire ({type}).', {
              name: userNameTranslated, type: typeTranslated,
            }),
            type:  'partner',
            data:  { requesting_user_id: req.user.id, request_type: requestType },
          });
        })
      );
      console.log(`[Partners] ✅ ${admins.length} admin notifications sent`);
    } catch(e) { console.log(`[Partners] admin notif error: ${e.message}`); }
  }

  console.log(`[Partners] ✅ DONE - Request submitted by ${req.user.email}`);
  res.json({ message: await i18n.t('partners_request_submitted', L, 'Demande soumise avec succès. Vérification sous 24-48h.') });
}));

// ✅ V12 : POST /api/partners/license — Ajouter le permis APRÈS soumission (pour user déjà partenaire)
router.post('/license', authenticate, asyncHandler(async (req, res) => {
  const { license_category, license_obtained, license_recto_url, license_verso_url } = req.body;
  // ✅ V14.5.3 i18n : résoudre la langue de l'user
  const L = await i18n.getUserLang(req.user.id);

  if (!license_category || !license_obtained || !license_recto_url || !license_verso_url) {
    return res.status(400).json({
      error: await i18n.t('partners_error_license_fields_required', L, 'Tous les champs permis requis : catégorie, date, recto, verso'),
    });
  }

  const { data: partner } = await db.from('partners')
    .select('id').eq('user_id', req.user.id).maybeSingle();
  if (!partner) return res.status(404).json({ error: await i18n.t('partners_error_profile_not_found', L, 'Profil partenaire introuvable') });

  const { error } = await db.from('partners').update({
    license_category,
    license_obtained,
    license_recto_url,
    license_verso_url,
    license_verified: false, // admin doit re-valider
  }).eq('id', partner.id);

  if (error) return res.status(500).json({ error: error.message });

  console.log(`[Partners] ✅ Permis ajouté/mis à jour par ${req.user.email}`);
  res.json({ message: await i18n.t('partners_license_registered', L, 'Permis enregistré. Vérification par notre équipe sous 24-48h.') });
}));

module.exports = router;
