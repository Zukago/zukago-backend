const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, requireAdmin, requirePartner, optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { deleteImage } = require('../config/cloudinary');
const i18n = require('../services/i18nService');
// ✅ V14.5.4 : Helper centralisé notification (DB insert + push Expo)
const { notifyUser } = require('../services/notifyUser');

const router = express.Router();

// ✅ V14.5.3 i18n : helper langue
// Routes auth → req.user.id ; routes optionalAuth/publiques → fallback header
async function _resolveLang(req) {
  if (req.user?.id) {
    try { return await i18n.getUserLang(req.user.id); } catch (e) {}
  }
  const accept = req.headers['accept-language'] || '';
  const code = accept.split(',')[0]?.slice(0, 2).toLowerCase();
  if (['fr', 'en', 'de'].includes(code)) return code;
  return 'fr';
}

// ─── GET /api/listings — Liste publique ───────────────────────────────────────
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
  // ✅ V14.6.0 — Ajout date_start + date_end (PURE ADD : ignorés si non fournis)
  const { type, city, min_price, max_price, sort, amenities, search, featured, limit = 20, offset = 0, date_start, date_end } = req.query;

  let q = db.from('listings')
    .select(`
      *,
      listing_photos(url, is_main),
      listing_amenities(amenity_code),
      reviews(rating)
    `)
    .eq('status', 'active')
    .limit(Number(limit))
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (type)       q = q.eq('type', type);
  if (city)       q = q.eq('city_code', city);
  if (min_price)  q = q.gte('price', min_price);
  if (max_price)  q = q.lte('price', max_price);
  if (featured === 'true') q = q.eq('featured', true);
  if (search)     q = q.or(`title.ilike.%${search}%,description.ilike.%${search}%`);

  // ✅ V14.6.0 — Auto-masquage covoit expiré (J+1)
  // → Règle : covoit dont depart_date < aujourd'hui (en UTC) sont masqués
  // → Visible TOUTE la journée J (jour du départ), disparaît dès J+1 minuit UTC
  // → S'applique UNIQUEMENT aux requêtes filtrées sur type='cov'
  // → Les autres types (apt/hotel/car/driver) NE SONT PAS affectés
  // → MyBookings/MyListings/Dashboard partner ne passent PAS par cette route → preservés
  if (type === 'cov') {
    const todayUTC = new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
    q = q.gte('depart_date', todayUTC);
  }

  // ✅ V10 : tri spécial covoiturage par date de départ
  if (type === 'cov') {
    q = q.order('depart_date', { ascending: true }).order('depart_time', { ascending: true });
  } else if (sort === 'price_asc')  q = q.order('price', { ascending: true });
  else if (sort === 'price_desc') q = q.order('price', { ascending: false });
  else q = q.order('featured', { ascending: false }).order('created_at', { ascending: false });

  const { data: listings, error, count } = await q;
  if (error) throw new Error(error.message);

  // Calculer note moyenne
  // ✅ V13.5 FIX : on remplace le tableau "reviews" brut par "reviews_count" (nombre)
  //    pour éviter tout risque "Objects are not valid as a React child" côté frontend
  const withRating = listings.map(l => {
    const ratingsArr = Array.isArray(l.reviews) ? l.reviews : [];
    const { reviews: _drop, ...rest } = l;
    return {
      ...rest,
      rating: ratingsArr.length
        ? (ratingsArr.reduce((sum, r) => sum + (Number(r?.rating) || 0), 0) / ratingsArr.length).toFixed(1)
        : null,
      reviews_count: ratingsArr.length,
      main_photo: l.listing_photos?.find(p => p.is_main)?.url || l.listing_photos?.[0]?.url,
    };
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // ✅ V14.6.0 — Filtre par dates (PURE ADD)
  // → Activé UNIQUEMENT si date_start ET date_end sont fournis
  // → Sinon : comportement INTACT (statu quo)
  // → Conventions :
  //    • apt/hotel/car  : booking 4→6 bloque 4 et 5 (check-out 6 = libre)
  //    • driver         : booking 5→7 bloque 5, 6 ET 7 (inclusif)
  //    • cov            : depart_date doit être dans [date_start, date_end]
  //    • hotel          : passe TOUS (filtrage stock par room_type fait en V14.7)
  // → Graceful degradation : si la query bookings échoue, on renvoie withRating
  //   non filtré (mieux que crash — l'user verra peut-être 1-2 annonces bookées)
  // ═════════════════════════════════════════════════════════════════════════════
  if (date_start && date_end) {
    try {
      // Validation format date YYYY-MM-DD basique
      const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
      if (!isValidDate(date_start) || !isValidDate(date_end)) {
        // Format invalide → on ignore le filtre dates (comportement statu quo)
        return res.json({ listings: withRating, total: count });
      }

      // 1. Récupérer TOUS les bookings actifs qui chevauchent [date_start, date_end]
      //    Convention chevauchement strict (apt/hotel/car) : start < date_end ET end > date_start
      //    NB : pour driver (inclusif), on fait un 2e fetch séparé
      const { data: overlappingBookingsExclusive } = await db.from('bookings')
        .select('listing_id, start_date, end_date')
        .in('status', ['confirmed', 'pending'])
        .lt('start_date', date_end)   // booking commence AVANT la fin demandée
        .gt('end_date', date_start);  // booking finit APRÈS le début demandé

      // 2. Pour driver, convention inclusive : start <= date_end ET end >= date_start
      const { data: overlappingBookingsInclusive } = await db.from('bookings')
        .select('listing_id, start_date, end_date')
        .in('status', ['confirmed', 'pending'])
        .lte('start_date', date_end)
        .gte('end_date', date_start);

      // Map listing_id → set de types de blocage
      const blockedIdsExclusive = new Set((overlappingBookingsExclusive || []).map(b => b.listing_id));
      const blockedIdsInclusive = new Set((overlappingBookingsInclusive || []).map(b => b.listing_id));

      // 3. Filtre intelligent par type
      const filtered = withRating.filter(l => {
        // HOTEL : on garde tout — le filtrage stock par room_type sera fait en V14.7
        if (l.type === 'hotel') return true;

        // COV (covoiturage) : depart_date doit être DANS [date_start, date_end]
        if (l.type === 'cov') {
          if (!l.depart_date) return false;
          return l.depart_date >= date_start && l.depart_date <= date_end;
        }

        // DRIVER : convention inclusive (jour de fin compté)
        if (l.type === 'driver') {
          return !blockedIdsInclusive.has(l.id);
        }

        // APT / CAR : convention exclusive (jour de check-out libre)
        return !blockedIdsExclusive.has(l.id);
      });

      return res.json({ listings: filtered, total: filtered.length });
    } catch (filterError) {
      // Graceful degradation : si erreur sur la query bookings, on renvoie withRating non filtré
      console.error('[V14.6.0] Date filter error (graceful fallback):', filterError.message);
      // → continue vers le res.json statu quo ci-dessous
    }
  }
  // ═════════════════════════════════════════════════════════════════════════════
  // ✅ V14.6.0 — Fin du bloc filtre dates
  // ═════════════════════════════════════════════════════════════════════════════

  res.json({ listings: withRating, total: count });
}));

// ─── GET /api/listings/:id — Détail ──────────────────────────────────────────
// 🔧 V13.5 fix : faire les JOINs séparément pour éviter qu'un sous-select cassé fasse échouer toute la requête.
//    Avant : un seul gros .select avec 4 JOINs imbriqués → si un échoue, 404 "Annonce introuvable"
//    Après : query principale simple + sous-queries séparées avec fallback à []
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
  // 1) Query principale ULTRA-SIMPLE (juste le listing) — ne peut pas échouer pour cause de JOIN
  const { data: listing, error } = await db.from('listings')
    .select('*')
    .eq('id', req.params.id)
    .eq('status', 'active')
    .single();

  if (error || !listing) {
    console.log('[GET /:id] Listing not found:', req.params.id, error?.message);
    const L = await _resolveLang(req);
    return res.status(404).json({ error: await i18n.t('listings_error_not_found', L, 'Annonce introuvable') });
  }

  // 2) Photos (séparé, fallback [])
  let listing_photos = [];
  try {
    const { data: photos } = await db.from('listing_photos')
      .select('url, public_id, is_main, sort_order')
      .eq('listing_id', listing.id)
      .order('sort_order', { ascending: true });
    listing_photos = photos || [];
  } catch (e) { console.log('[GET /:id] photos error:', e.message); }

  // 3) Amenities (séparé, avec JOIN sur amenities)
  let listing_amenities = [];
  try {
    const { data: amenities } = await db.from('listing_amenities')
      .select('amenity_code, amenities(label, emoji, category)')
      .eq('listing_id', listing.id);
    listing_amenities = amenities || [];
  } catch (e) { console.log('[GET /:id] amenities error:', e.message); }

  // 4) Reviews (séparé, avec users)
  let reviews = [];
  try {
    const { data: revs } = await db.from('reviews')
      .select('id, rating, comment, verified, created_at, users!reviews_user_id_fkey(name, avatar)')
      .eq('listing_id', listing.id);
    reviews = revs || [];
  } catch (e) { console.log('[GET /:id] reviews error:', e.message); }

  // 5) Partner info (séparé, avec users)
  // ✅ V13.5.12 : préciser la FK partners_user_id_fkey car partners a 2 relations vers users
  // (user_id = le partenaire, approved_by = l'admin qui a validé)
  let partners = null;
  try {
    if (listing.partner_id) {
      const { data: p } = await db.from('partners')
        .select('id, user_id, users!partners_user_id_fkey(name, avatar, verified)')
        .eq('id', listing.partner_id)
        .single();
      partners = p || null;
    }
  } catch (e) { console.log('[GET /:id] partner error:', e.message); }

  // Incrémenter vues
  await db.from('listings').update({ views: (listing.views || 0) + 1 }).eq('id', listing.id);

  // Calculer note
  const rating = reviews.length
    ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
    : null;

  // Vérifier si favori (si connecté)
  let isFavorite = false;
  if (req.user) {
    const { data: fav } = await db.from('favorites')
      .select('user_id').eq('user_id', req.user.id).eq('listing_id', listing.id).single();
    isFavorite = !!fav;
  }

  // ✅ V11 : room_types pour hotel
  let roomTypes = null;
  if (listing.type === 'hotel') {
    const { data: rt } = await db.from('listing_room_types')
      .select('*')
      .eq('listing_id', listing.id)
      .order('sort_order', { ascending: true });
    roomTypes = rt || [];
  }

  // ✅ V13.5 (Phase 5) Solution pro : pour covoit, recalculer seats_available
  // dynamiquement depuis les bookings (source de vérité)
  let seatsAvailableDynamic = listing.seats_available;
  if (listing.type === 'cov' && Number(listing.seats_total) > 0) {
    const { data: activeBookings } = await db.from('bookings')
      .select('seats_booked')
      .eq('listing_id', listing.id)
      .in('status', ['pending', 'confirmed']);
    const taken = (activeBookings || [])
      .reduce((sum, b) => sum + (Number(b.seats_booked) || 0), 0);
    seatsAvailableDynamic = Math.max(0, Number(listing.seats_total) - taken);
  }

  // ✅ V11 : politique d'annulation détaillée (texte client)
  let cancelPolicyDetails = null;
  if (listing.cancel_policy) {
    const { data: cp } = await db.from('cancellation_policies')
      .select('code, label, description, emoji')
      .eq('code', listing.cancel_policy)
      .single();
    cancelPolicyDetails = cp || null;
  }

  res.json({
    listing: {
      ...listing,
      listing_photos,
      listing_amenities,
      // ✅ V13.5 FIX : ne PAS exposer la clé "reviews" au frontend (crash React child)
      // Le frontend lit reviews_count pour le nombre, et /api/reviews/listing/:id pour la liste
      reviews_list: reviews,
      partners,
      // ✅ V13.5 : pour covoit, override avec la valeur dynamique (source de vérité)
      seats_available: seatsAvailableDynamic,
      rating,
      reviews_count: reviews.length,
      isFavorite,
      room_types: roomTypes,
      cancel_policy_details: cancelPolicyDetails,
    },
  });
}));


// ─── GET /api/listings/:id/availability — Dates occupées
// 🔧 V13 fix : pour apt/hotel/car, end_date est le jour de check-out, donc PAS occupé.
//    Convention : booking 4→6 mai bloque les nuits 4 et 5, pas le 6.
//    Le 6 mai est libre pour un nouveau check-in.
// ✅ V13.5.4 : pour driver mode 'day', end_date EST occupé (dernier jour de prestation).
//    Convention : prestation chauffeur 5→7 mai bloque 5, 6 ET 7 (3 jours prestés).
router.get('/:id/availability', asyncHandler(async (req, res) => {
  // ✅ V13.5.4 : récupérer le type de listing pour adapter la convention
  const { data: listing } = await db.from('listings')
    .select('type')
    .eq('id', req.params.id)
    .single();

  const isDriver = listing?.type === 'driver';

  const { data: bookings } = await db.from('bookings')
    .select('start_date, end_date')
    .eq('listing_id', req.params.id)
    .in('status', ['confirmed', 'pending']);

  // Construire la liste de toutes les dates occupées
  // - apt/hotel/car : du start au end EXCLUS (convention nuits)
  // - driver       : du start au end INCLUS (convention prestation)
  const bookedDates = [];
  (bookings || []).forEach(b => {
    if (!b.start_date || !b.end_date) return;
    const start = new Date(b.start_date);
    const end   = new Date(b.end_date);
    if (isDriver) {
      // ✅ V13.5.4 driver : inclusif (<=)
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        bookedDates.push(d.toISOString().split('T')[0]);
      }
    } else {
      // ✅ V13 apt/hotel/car : strict less than (<) — le jour de check-out n'est PAS occupé
      for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        bookedDates.push(d.toISOString().split('T')[0]);
      }
    }
  });

  // ✅ V14.8 — Blocages manuels du propriétaire, fusionnés dans bookedDates
  //    Convention INCLUSIVE : bloqué du 4 au 6 = 4, 5 ET 6 indisponibles.
  //    PURE ADD : ne touche pas au calcul des bookings ci-dessus.
  try {
    const { data: blocks } = await db.from('listing_blocked_dates')
      .select('start_date, end_date')
      .eq('listing_id', req.params.id);
    (blocks || []).forEach(b => {
      if (!b.start_date || !b.end_date) return;
      const bStart = new Date(b.start_date);
      const bEnd   = new Date(b.end_date);
      for (let d = new Date(bStart); d <= bEnd; d.setDate(d.getDate() + 1)) {
        bookedDates.push(d.toISOString().split('T')[0]);
      }
    });
  } catch (e) { console.log('[GET /:id/availability] blocked_dates error:', e.message); }

  res.json({ bookedDates: [...new Set(bookedDates)] });
}));

// ═══════════════════════════════════════════════════════════════════════════
// ✅ V14.8 — Blocages manuels du propriétaire (calendrier partenaire)
// ═══════════════════════════════════════════════════════════════════════════
// Helper : l'annonce existe-t-elle et appartient-elle à l'user (ou admin) ?
// Renvoie le listing si OK, sinon répond (404/403) et renvoie null.
async function _assertListingOwner(req, res) {
  const L = await i18n.getUserLang(req.user.id);
  const { data: listing } = await db.from('listings')
    .select('id, partner_id, partners(user_id)')
    .eq('id', req.params.id)
    .single();
  if (!listing) {
    res.status(404).json({ error: await i18n.t('listings_error_not_found', L, 'Annonce introuvable') });
    return null;
  }
  const isOwner = listing.partners?.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: await i18n.t('listings_error_unauthorized', L, 'Non autorisé') });
    return null;
  }
  return listing;
}

// ─── GET /api/listings/:id/blocks — Liste des blocages manuels (propriétaire) ──
router.get('/:id/blocks', authenticate, asyncHandler(async (req, res) => {
  const listing = await _assertListingOwner(req, res);
  if (!listing) return;
  const { data: blocks, error } = await db.from('listing_blocked_dates')
    .select('id, start_date, end_date, reason, created_at')
    .eq('listing_id', req.params.id)
    .order('start_date', { ascending: true });
  if (error) throw new Error(error.message);
  res.json({ blocks: blocks || [] });
}));

// ─── POST /api/listings/:id/blocks — Créer un blocage (propriétaire) ───────────
router.post('/:id/blocks', authenticate, asyncHandler(async (req, res) => {
  const L = await i18n.getUserLang(req.user.id);
  const listing = await _assertListingOwner(req, res);
  if (!listing) return;
  const { start_date, end_date, reason } = req.body;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: await i18n.t('blocks_error_dates_required', L, 'Dates de début et de fin requises') });
  }
  if (new Date(end_date) < new Date(start_date)) {
    return res.status(400).json({ error: await i18n.t('blocks_error_range_invalid', L, 'La date de fin doit être après la date de début') });
  }
  const { data, error } = await db.from('listing_blocked_dates')
    .insert({ listing_id: req.params.id, start_date, end_date, reason: reason || null })
    .select().single();
  if (error) throw new Error(error.message);
  res.status(201).json({ block: data });
}));

// ─── DELETE /api/listings/:id/blocks/:blockId — Supprimer un blocage ───────────
router.delete('/:id/blocks/:blockId', authenticate, asyncHandler(async (req, res) => {
  const listing = await _assertListingOwner(req, res);
  if (!listing) return;
  const { error } = await db.from('listing_blocked_dates')
    .delete()
    .eq('id', req.params.blockId)
    .eq('listing_id', req.params.id);
  if (error) throw new Error(error.message);
  res.json({ success: true });
}));

// ─── GET /api/listings/:id/seats-available — Places restantes (covoit, calcul dynamique)
// ✅ V13.5 Solution pro : ne lit PAS la colonne, calcule depuis les bookings
//    (source unique de vérité, zéro risque de surbooking)
router.get('/:id/seats-available', asyncHandler(async (req, res) => {
  const { data: listing } = await db.from('listings')
    .select('seats_total, type').eq('id', req.params.id).single();

  if (!listing) {
    const L = await _resolveLang(req);
    return res.status(404).json({ error: await i18n.t('listings_error_not_found', L, 'Annonce introuvable') });
  }
  if (listing.type !== 'cov') {
    const L = await _resolveLang(req);
    return res.status(400).json({ error: await i18n.t('listings_error_carpool_only', L, 'Cet endpoint est réservé aux trajets de covoiturage') });
  }

  const seatsTotal = Number(listing.seats_total) || 0;

  const { data: activeBookings } = await db.from('bookings')
    .select('seats_booked')
    .eq('listing_id', req.params.id)
    .in('status', ['pending', 'confirmed']);

  const taken = (activeBookings || [])
    .reduce((sum, b) => sum + (Number(b.seats_booked) || 0), 0);

  const seatsAvailable = Math.max(0, seatsTotal - taken);

  res.json({
    seats_total:     seatsTotal,
    seats_available: seatsAvailable,
    seats_taken:     taken,
  });
}));

// ─── POST /api/listings — Créer annonce (partenaire) ─────────────────────────
// ✅ V10 : support du type 'cov' (covoiturage)
// ✅ V11 : support de tous les champs apt/hotel/car/driver + room_types pour hotel
router.post('/', authenticate, requirePartner, [
  body('type').isIn(['apt', 'hotel', 'car', 'driver', 'cov']),
  body('title').trim().isLength({ min: 2, max: 100 }),
  body('description').optional({ checkFalsy: true }).trim().isLength({ min: 2 }),
  body('price').optional({ checkFalsy: true }).isNumeric(),
  body('city_code').optional(),
  body('quartier').optional(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  // ✅ V14.5.3 i18n : résoudre la langue de l'user (utilisée partout dans le handler)
  const L = await i18n.getUserLang(req.user.id);

  // Récupérer partner_id — l'utilisateur DOIT être un partenaire approuvé
  const { data: partner } = await db.from('partners')
    .select('id, status').eq('user_id', req.user.id).single();

  if (!partner) {
    return res.status(403).json({
      error: await i18n.t('listings_error_no_partner_profile', L, 'Vous devez soumettre une demande partenaire avant de publier'),
      reason: 'no_partner_profile',
    });
  }
  if (partner.status !== 'approved') {
    let errKey, errFr;
    if (partner.status === 'pending') {
      errKey = 'listings_error_partner_pending';
      errFr  = 'Votre demande partenaire est en cours de vérification';
    } else if (partner.status === 'rejected') {
      errKey = 'listings_error_partner_rejected';
      errFr  = 'Votre demande partenaire a été rejetée. Contactez le support.';
    } else {
      errKey = 'listings_error_partner_inactive';
      errFr  = 'Votre compte partenaire n\'est pas actif';
    }
    return res.status(403).json({
      error: await i18n.t(errKey, L, errFr),
      reason: 'partner_not_approved',
      status: partner.status,
    });
  }
  const partnerId = partner.id;

  const {
    // COMMUN
    type, title, description, sub_type, city_code, city_name, quartier, address,
    price, price_weekend, unit, min_nights, max_nights, caution, whatsapp, contact_email, amenities,
    cancel_policy,
    check_in_time, check_out_time,

    // V11 COMMUN APT/HOTEL
    capacity, bedrooms, beds, bathrooms, surface_m2,
    smoking_allowed, pets_allowed, children_allowed,
    events_party, events_birthday, events_wedding,
    events_seminar, events_baptism, events_conference,
    house_rules,

    // V11 APT + CAR : prix long terme
    price_5nights, price_week, price_month,

    // V11 HOTEL
    stars, standing, total_rooms, year_built, breakfast_policy, deposit_pct,
    room_types,   // array d'objets : [{name, capacity, price_night, price_5nights, price_week, price_month, breakfast_included, quantity}]

    // V11 CAR
    brand, model, year, color, fuel, transmission, seats_passenger, doors,
    air_conditioning, bluetooth, trunk_size, with_driver, without_driver,
    price_in_city, price_out_city, long_rental_discount_pct, fuel_included,
    pickup_location, return_location, min_age, license_required, deposit_type, insurance_type,

    // V11 DRIVER
    years_experience, languages, license_category, service_cities,
    long_trips_ok, intl_trips_ok,
    price_halfday, price_hour, price_longdistance, airport_fee,
    work_days, work_hours_start, work_hours_end, available_nights,

    // COVOIT (V10)
    from_city, to_city, via_cities, depart_date, depart_time,
    seats_total, seats_available, car_model, car_color, plate_number,
    smoking_ok, music_ok, pets_ok, luggage, status,

    // ✅ V14.5.4 : Géolocalisation (Google Places autocomplete + future map)
    latitude, longitude,
  } = req.body;

  // ═══════════════════════════════════════════════════════════════════
  // ✅ V10 : Branche COVOITURAGE — logique spéciale
  // ═══════════════════════════════════════════════════════════════════
  if (type === 'cov') {
    if (!from_city || !to_city || !depart_date || !depart_time) {
      return res.status(400).json({ error: await i18n.t('listings_error_carpool_fields_missing', L, 'Champs covoiturage manquants (from_city, to_city, depart_date, depart_time)') });
    }
    if (!seats_total || seats_total < 1) {
      return res.status(400).json({ error: await i18n.t('listings_error_invalid_seats', L, 'seats_total invalide') });
    }

    const { data: covListing, error: covError } = await db.from('listings').insert({
      partner_id: partnerId,
      type: 'cov',
      title:        title || `${from_city} → ${to_city}`,
      description:  description || '',
      price,
      unit:         'place',
      status:       status || 'active',
      whatsapp,
      contact_email,
      from_city,
      to_city,
      via_cities:       Array.isArray(via_cities) ? via_cities : [],
      depart_date,
      depart_time,
      seats_total:      parseInt(seats_total, 10),
      seats_available:  parseInt(seats_available ?? seats_total, 10),
      car_model:        car_model  || null,
      car_color:        car_color  || null,
      plate_number:     plate_number || null,
      smoking_ok:       smoking_ok !== undefined ? !!smoking_ok : true,
      music_ok:         music_ok   !== undefined ? !!music_ok   : true,
      pets_ok:          pets_ok    !== undefined ? !!pets_ok    : false,
      luggage:          luggage    || 'medium',
      cancel_policy:    cancel_policy || null,
      // ✅ V14.5.4 : Géolocalisation (covoiturage = point de départ)
      latitude:         latitude  || null,
      longitude:        longitude || null,
    }).select().single();

    if (covError) throw new Error(covError.message);

    return res.status(201).json({
      listing: covListing,
      message: await i18n.t('listings_carpool_published', L, 'Trajet covoiturage publié'),
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Branche CLASSIQUE (apt / hotel / car / driver)
  // ═══════════════════════════════════════════════════════════════════

  // ✅ Auto-création ville si elle n'existe pas dans cities — §3.7
  // ✅ V11 : vérif D'ABORD par label (case-insensitive) pour éviter les doublons
  //    (bug V10 : on ne vérifiait que par code généré, donc 'baf' + 'bafoussam' = 2 lignes)
  let validCityCode = city_code || null;
  const cityLabel   = city_name || city_code || '';

  if (cityLabel) {
    // 1) D'abord chercher si une ville avec ce LABEL existe déjà (case-insensitive)
    const { data: existingByLabel } = await db.from('cities')
      .select('code, label')
      .ilike('label', cityLabel.trim())
      .limit(1);

    if (existingByLabel && existingByLabel.length > 0) {
      // Ville déjà en DB avec ce label → on réutilise son code, pas de doublon
      validCityCode = existingByLabel[0].code;
    } else {
      // 2) Sinon, générer un code et créer la ville
      const generatedCode = cityLabel
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '_')
        .substring(0, 20);

      // Vérif de secours par code (au cas où)
      const { data: existingByCode } = await db.from('cities')
        .select('code').eq('code', generatedCode).single();

      if (existingByCode) {
        validCityCode = generatedCode;
      } else {
        try {
          await db.from('cities').insert({
            code:       generatedCode,
            label:      cityLabel.trim(),
            active:     true,
            sort_order: 999,
          });
          validCityCode = generatedCode;
        } catch(e) {
          // Race condition : qqun d'autre a créé la ville entre-temps → retry by label
          const { data: retry } = await db.from('cities')
            .select('code').ilike('label', cityLabel.trim()).limit(1);
          validCityCode = retry?.[0]?.code || null;
        }
      }
    }
  }

  // ✅ V11 : construire l'objet d'insertion avec uniquement les champs pertinents selon le type
  // Les champs non fournis / non-applicables restent NULL en DB (cohérent)
  const listingData = {
    // Communs
    partner_id: partnerId,
    type, title, description, sub_type,
    city_code: validCityCode,
    quartier:  quartier || '',
    address,
    price, price_weekend: price_weekend || null,
    unit: unit || (type === 'car' || type === 'driver' ? 'jour' : 'nuit'),
    min_nights: min_nights || 1,
    max_nights: max_nights || null,
    caution: caution || null,
    whatsapp, contact_email,
    status: 'pending',
    cancel_policy: cancel_policy || null,
    check_in_time: check_in_time || null,
    check_out_time: check_out_time || null,
    // ✅ V14.5.4 : Géolocalisation (Google Places autocomplete + future map)
    latitude:  latitude  || null,
    longitude: longitude || null,
  };

  // ── APT / HOTEL : caractéristiques communes ──
  if (type === 'apt' || type === 'hotel') {
    listingData.capacity   = capacity  || null;
    listingData.bedrooms   = bedrooms  || null;
    listingData.beds       = beds      || null;
    listingData.bathrooms  = bathrooms || null;
    listingData.surface_m2 = surface_m2 || null;
    // Règles maison
    listingData.smoking_allowed  = !!smoking_allowed;
    listingData.pets_allowed     = !!pets_allowed;
    listingData.children_allowed = children_allowed !== undefined ? !!children_allowed : true;
    listingData.events_party     = !!events_party;
    listingData.events_birthday  = !!events_birthday;
    listingData.events_wedding   = !!events_wedding;
    listingData.events_seminar   = !!events_seminar;
    listingData.events_baptism   = !!events_baptism;
    listingData.events_conference= !!events_conference;
    listingData.house_rules      = house_rules || null;
  }

  // ── APT uniquement : prix long terme ──
  if (type === 'apt') {
    listingData.price_5nights = price_5nights || null;
    listingData.price_week    = price_week    || null;
    listingData.price_month   = price_month   || null;
  }

  // ── HOTEL : champs spécifiques ──
  if (type === 'hotel') {
    listingData.stars             = stars || null;
    listingData.standing          = standing || null;
    listingData.total_rooms       = total_rooms || null;
    listingData.year_built        = year_built || null;
    listingData.breakfast_policy  = breakfast_policy || null;
    listingData.deposit_pct       = deposit_pct || null;
  }

  // ── CAR : champs spécifiques ──
  if (type === 'car') {
    listingData.brand                    = brand || null;
    listingData.model                    = model || null;
    listingData.year                     = year  || null;
    listingData.color                    = color || null;
    listingData.fuel                     = fuel || null;
    listingData.transmission             = transmission || null;
    listingData.seats_passenger          = seats_passenger || null;
    listingData.doors                    = doors || null;
    listingData.air_conditioning         = air_conditioning !== undefined ? !!air_conditioning : true;
    listingData.bluetooth                = !!bluetooth;
    listingData.trunk_size               = trunk_size || null;
    listingData.with_driver              = !!with_driver;
    listingData.without_driver           = without_driver !== undefined ? !!without_driver : true;
    listingData.price_week               = price_week || null;
    listingData.price_month              = price_month || null;
    listingData.price_in_city            = price_in_city || null;
    listingData.price_out_city           = price_out_city || null;
    listingData.long_rental_discount_pct = long_rental_discount_pct || null;
    listingData.fuel_included            = !!fuel_included;
    listingData.pickup_location          = pickup_location || null;
    listingData.return_location          = return_location || null;
    listingData.min_age                  = min_age || null;
    listingData.license_required         = license_required || null;
    listingData.deposit_type             = deposit_type || null;
    listingData.insurance_type           = insurance_type || null;
  }

  // ── DRIVER : champs spécifiques ──
  if (type === 'driver') {
    listingData.years_experience  = years_experience || null;
    listingData.languages         = Array.isArray(languages) ? languages : null;
    listingData.license_category  = license_category || null;
    listingData.service_cities    = Array.isArray(service_cities) ? service_cities : null;
    listingData.long_trips_ok     = !!long_trips_ok;
    listingData.intl_trips_ok     = !!intl_trips_ok;
    listingData.price_halfday     = price_halfday || null;
    listingData.price_hour        = price_hour || null;
    listingData.price_longdistance= price_longdistance || null;
    listingData.airport_fee       = airport_fee || null;
    listingData.fuel_included     = !!fuel_included;
    listingData.work_days         = Array.isArray(work_days) ? work_days : null;
    listingData.work_hours_start  = work_hours_start || null;
    listingData.work_hours_end    = work_hours_end || null;
    listingData.available_nights  = !!available_nights;
    // Véhicule du chauffeur (réutilise colonnes car)
    listingData.brand             = brand || null;
    listingData.model             = model || null;
    listingData.year              = year  || null;
    listingData.color             = color || null;
    listingData.seats_passenger   = seats_passenger || null;
    listingData.air_conditioning  = air_conditioning !== undefined ? !!air_conditioning : true;
    listingData.bluetooth         = !!bluetooth;
  }

  const { data: listing, error } = await db.from('listings').insert(listingData).select().single();
  if (error) throw new Error(error.message);

  // Ajouter équipements
  if (amenities?.length) {
    await db.from('listing_amenities').insert(
      amenities.map(code => ({ listing_id: listing.id, amenity_code: code }))
    );
  }

  // ✅ V11 : Ajouter types de chambres pour HOTEL
  if (type === 'hotel' && Array.isArray(room_types) && room_types.length > 0) {
    const roomTypesToInsert = room_types.map((rt, idx) => ({
      listing_id:         listing.id,
      name:               rt.name,
      capacity:           parseInt(rt.capacity, 10) || 1,
      price_night:        parseInt(rt.price_night, 10),
      price_weekend:      rt.price_weekend ? parseInt(rt.price_weekend, 10) : null,
      breakfast_included: !!rt.breakfast_included,
      quantity:           parseInt(rt.quantity, 10) || 1,
      photos:             Array.isArray(rt.photos) ? rt.photos : [],
      sort_order:         idx,
    }));
    const { error: rtError } = await db.from('listing_room_types').insert(roomTypesToInsert);
    if (rtError) console.log('Room types insert error:', rtError.message);
  }

  res.status(201).json({ listing, message: await i18n.t('listings_submitted_for_approval', L, 'Annonce soumise pour approbation (24-48h)') });
}));

// ─── PATCH /api/listings/:id — Modifier annonce ───────────────────────────────
router.patch('/:id', authenticate, asyncHandler(async (req, res) => {
  const L = await i18n.getUserLang(req.user.id);
  const { data: listing } = await db.from('listings').select('partner_id, partners(user_id)').eq('id', req.params.id).single();
  if (!listing) return res.status(404).json({ error: await i18n.t('listings_error_not_found', L, 'Annonce introuvable') });

  const isOwner = listing.partners?.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: await i18n.t('listings_error_unauthorized', L, 'Non autorisé') });

  const { amenities, room_types, city_name, ...updates } = req.body;
  if (!isAdmin) delete updates.status; // partenaire ne peut pas changer le statut
  // ✅ V14.8 — Édition : mapper le libellé ville vers la vraie colonne city_label
  //    (cohérent avec la création). On sort aussi city_name/room_types/amenities du
  //    spread pour ne pas écrire de colonnes inexistantes ('city_name', 'room_types').
  if (city_name !== undefined) updates.city_label = city_name;

  const { data, error } = await db.from('listings')
    .update({ ...updates, updated_at: new Date() })
    .eq('id', req.params.id)
    .select().single();

  if (error) throw new Error(error.message);

  // Mettre à jour équipements si fournis
  if (amenities) {
    await db.from('listing_amenities').delete().eq('listing_id', req.params.id);
    if (amenities.length) {
      await db.from('listing_amenities').insert(
        amenities.map(code => ({ listing_id: req.params.id, amenity_code: code }))
      );
    }
  }

  res.json({ listing: data });
}));

// ─── DELETE /api/listings/:id — Supprimer ─────────────────────────────────────
router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
  // ✅ V14.5.3 i18n : résoudre la langue de l'user
  const L = await i18n.getUserLang(req.user.id);

  const { data: listing } = await db.from('listings')
    .select('id, title, partner_id, partners(user_id)')
    .eq('id', req.params.id).single();

  if (!listing) return res.status(404).json({ error: await i18n.t('listings_error_not_found', L, 'Annonce introuvable') });

  const isOwner = listing.partners?.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: await i18n.t('listings_error_unauthorized', L, 'Non autorisé') });

  // ── Vérifier les réservations actives
  const { data: activeBookings } = await db.from('bookings')
    .select('id, status')
    .eq('listing_id', req.params.id)
    .in('status', ['confirmed', 'pending']);

  const confirmedBookings = (activeBookings || []).filter(b => b.status === 'confirmed');

  if (confirmedBookings.length > 0) {
    // Réservations confirmées → seul l'admin peut forcer la suppression
    if (!isAdmin) {
      return res.status(409).json({
        error: await i18n.t('listings_error_cannot_delete', L, 'Suppression impossible'),
        reason: 'confirmed_bookings',
        count: confirmedBookings.length,
        message: await i18n.t('listings_error_cannot_delete_message', L, 'Cette annonce a {count} réservation(s) confirmée(s). Contactez l\'administrateur ZUKAGO pour procéder à la suppression.', { count: confirmedBookings.length }),
      });
    }

    // Admin force-delete → annuler les bookings confirmés + notifier clients et partenaire
    const { data: confirmedDetails } = await db.from('bookings')
      .select('id, user_id')
      .eq('listing_id', req.params.id)
      .eq('status', 'confirmed');

    if (confirmedDetails?.length) {
      // Annuler les réservations confirmées
      await db.from('bookings')
        .update({ status: 'cancelled' })
        .in('id', confirmedDetails.map(b => b.id));

      // ✅ V14.5.3 i18n : notif multilingue à chaque client (broadcast)
      // ✅ V14.5.4 : notifyUser() par client (langues différentes — pas de batch)
      await Promise.all(
        confirmedDetails.map(async (b) => {
          const clientLang = await i18n.getUserLang(b.user_id);
          return notifyUser(b.user_id, {
            title: await i18n.t('notif_booking_cancelled_title', clientLang, 'Réservation annulée'),
            body:  await i18n.t('notif_booking_cancelled_admin_body', clientLang, 'Votre réservation confirmée pour "{title}" a été annulée par l\'administration ZUKAGO. Nous nous excusons pour ce désagrément.', { title: listing.title }),
            type:  'info',
            data:  { booking_id: b.id, listing_id: listing.id },
          });
        })
      );
    }

    // Notifier le partenaire
    try {
      const { data: partnerRow } = await db.from('partners')
        .select('user_id')
        .eq('id', listing.partner_id)
        .single();
      if (partnerRow?.user_id) {
        // ✅ V14.5.3 i18n : notif au partenaire dans sa langue
        // ✅ V14.5.4 : helper notifyUser (DB + push Expo)
        const partnerLang = await i18n.getUserLang(partnerRow.user_id);
        await notifyUser(partnerRow.user_id, {
          title: await i18n.t('notif_listing_deleted_title', partnerLang, 'Annonce supprimée par l\'administration'),
          body:  await i18n.t('notif_listing_deleted_body',  partnerLang, 'Votre annonce "{title}" a été supprimée par l\'équipe ZUKAGO. {count} réservation(s) confirmée(s) ont été annulées et les clients notifiés.', {
            title: listing.title, count: confirmedBookings.length,
          }),
          type:  'info',
          data:  { listing_id: listing.id },
        });
      }
    } catch (e) { console.log('Partner notif error:', e.message); }
  }

  // ── Annuler les réservations en attente
  const pendingBookings = (activeBookings || []).filter(b => b.status === 'pending');
  if (pendingBookings.length > 0) {
    await db.from('bookings')
      .update({ status: 'cancelled' })
      .in('id', pendingBookings.map(b => b.id));

    // Notifier les clients dont la réservation est annulée
    const { data: pendingDetails } = await db.from('bookings')
      .select('user_id')
      .in('id', pendingBookings.map(b => b.id));

    if (pendingDetails?.length) {
      // ✅ V14.5.3 i18n : notif multilingue à chaque client (pending)
      // ✅ V14.5.4 : notifyUser() par client (langues différentes — pas de batch)
      await Promise.all(
        pendingDetails.map(async (b) => {
          const clientLang = await i18n.getUserLang(b.user_id);
          return notifyUser(b.user_id, {
            title: await i18n.t('notif_booking_cancelled_title', clientLang, 'Réservation annulée'),
            body:  await i18n.t('notif_booking_cancelled_listing_deleted_body', clientLang, 'Votre réservation pour "{title}" a été annulée car l\'annonce a été supprimée.', { title: listing.title }),
            type:  'info',
            data:  { listing_id: listing.id },
          });
        })
      );
    }
  }

  // 1. Récupérer et supprimer les photos Cloudinary
  const { data: photos } = await db.from('listing_photos')
    .select('id, public_id').eq('listing_id', req.params.id);

  if (photos?.length) {
    await Promise.all(
      photos.map(p => p.public_id ? deleteImage(p.public_id).catch(e => console.log('Cloudinary delete error:', e.message)) : Promise.resolve())
    );
    await db.from('listing_photos').delete().eq('listing_id', req.params.id);
  }

  // 2. Supprimer toutes les données liées
  await Promise.all([
    db.from('listing_amenities').delete().eq('listing_id', req.params.id),
    db.from('reviews').delete().eq('listing_id', req.params.id),
    db.from('favorites').delete().eq('listing_id', req.params.id),
    db.from('bookings').update({ status: 'cancelled' }).eq('listing_id', req.params.id),
  ]);

  // 3. Supprimer l'annonce
  const { error } = await db.from('listings').delete().eq('id', req.params.id);
  if (error) throw new Error(error.message);

  console.log(`✅ Listing ${req.params.id} supprimé par ${req.user.id}`);
  res.json({ message: await i18n.t('listings_deleted_success', L, 'Annonce supprimée définitivement'), deleted: true });
}));


// ═══════════════════════════════════════════════════════════════════════════
// ✅ V11 SPRINT B — Gestion des types de chambres d'un hôtel
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET /api/listings/:id/room-types — Lister les types de chambres ────────
router.get('/:id/room-types', asyncHandler(async (req, res) => {
  const { data: rooms, error } = await db.from('listing_room_types')
    .select('*')
    .eq('listing_id', req.params.id)
    .order('sort_order', { ascending: true });
  if (error) throw new Error(error.message);
  res.json(rooms || []);
}));

// ─── POST /api/listings/:id/room-types — Ajouter un type de chambre ─────────
// Body : { name, capacity, price_night, price_5nights?, price_week?, price_month?,
//          breakfast_included?, quantity, photos? (array URLs) }
router.post('/:id/room-types', authenticate, asyncHandler(async (req, res) => {
  const listingId = req.params.id;
  // ✅ V14.5.3 i18n : résoudre la langue
  const L = await i18n.getUserLang(req.user.id);

  // Vérifier que le listing appartient à l'user (ou admin)
  const { data: listing } = await db.from('listings')
    .select('id, partner_id, partners(user_id)')
    .eq('id', listingId).single();
  if (!listing) return res.status(404).json({ error: await i18n.t('listings_error_not_found', L, 'Annonce introuvable') });
  if (req.user.role !== 'admin' && listing.partners?.user_id !== req.user.id) {
    return res.status(403).json({ error: await i18n.t('listings_error_unauthorized', L, 'Non autorisé') });
  }

  const {
    name, capacity, price_night, price_weekend,
    breakfast_included, quantity, photos, sort_order,
  } = req.body;

  if (!name || !price_night) {
    return res.status(400).json({ error: await i18n.t('listings_error_room_fields_required', L, 'name et price_night sont obligatoires') });
  }

  // Trouver le sort_order suivant si non fourni
  let finalSortOrder = sort_order;
  if (finalSortOrder === undefined || finalSortOrder === null) {
    const { data: last } = await db.from('listing_room_types')
      .select('sort_order').eq('listing_id', listingId)
      .order('sort_order', { ascending: false }).limit(1);
    finalSortOrder = (last?.[0]?.sort_order || 0) + 1;
  }

  const { data: newRoom, error } = await db.from('listing_room_types').insert({
    listing_id:         listingId,
    name,
    capacity:           parseInt(capacity, 10) || 1,
    price_night:        parseInt(price_night, 10),
    price_weekend:      price_weekend ? parseInt(price_weekend, 10) : null,
    breakfast_included: !!breakfast_included,
    quantity:           parseInt(quantity, 10) || 1,
    photos:             Array.isArray(photos) ? photos : [],
    sort_order:         finalSortOrder,
  }).select().single();

  if (error) throw new Error(error.message);
  res.status(201).json(newRoom);
}));

// ─── PATCH /api/listings/room-types/:id — Modifier un type de chambre ───────
router.patch('/room-types/:id', authenticate, asyncHandler(async (req, res) => {
  // ✅ V14.5.3 i18n
  const L = await i18n.getUserLang(req.user.id);
  // Vérifier ownership via le listing parent
  const { data: room } = await db.from('listing_room_types')
    .select('id, listing_id, listings!inner(partner_id, partners(user_id))')
    .eq('id', req.params.id).single();
  if (!room) return res.status(404).json({ error: await i18n.t('listings_error_room_type_not_found', L, 'Type de chambre introuvable') });
  if (req.user.role !== 'admin' && room.listings?.partners?.user_id !== req.user.id) {
    return res.status(403).json({ error: await i18n.t('listings_error_unauthorized', L, 'Non autorisé') });
  }

  const allowed = [
    'name', 'capacity', 'price_night', 'price_weekend',
    'breakfast_included', 'quantity', 'photos', 'sort_order',
  ];
  const updates = { updated_at: new Date().toISOString() };
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      if (['capacity', 'price_night', 'price_weekend', 'quantity', 'sort_order'].includes(k)) {
        updates[k] = req.body[k] === null ? null : parseInt(req.body[k], 10);
      } else if (k === 'breakfast_included') {
        updates[k] = !!req.body[k];
      } else if (k === 'photos') {
        updates[k] = Array.isArray(req.body[k]) ? req.body[k] : [];
      } else {
        updates[k] = req.body[k];
      }
    }
  }

  const { data: updated, error } = await db.from('listing_room_types')
    .update(updates)
    .eq('id', req.params.id)
    .select().single();
  if (error) throw new Error(error.message);
  res.json(updated);
}));

// ─── DELETE /api/listings/room-types/:id — Supprimer un type de chambre ─────
router.delete('/room-types/:id', authenticate, asyncHandler(async (req, res) => {
  // ✅ V14.5.3 i18n
  const L = await i18n.getUserLang(req.user.id);
  const { data: room } = await db.from('listing_room_types')
    .select('id, listing_id, listings!inner(partner_id, partners(user_id))')
    .eq('id', req.params.id).single();
  if (!room) return res.status(404).json({ error: await i18n.t('listings_error_room_type_not_found', L, 'Type de chambre introuvable') });
  if (req.user.role !== 'admin' && room.listings?.partners?.user_id !== req.user.id) {
    return res.status(403).json({ error: await i18n.t('listings_error_unauthorized', L, 'Non autorisé') });
  }

  const { error } = await db.from('listing_room_types').delete().eq('id', req.params.id);
  if (error) throw new Error(error.message);
  res.json({ deleted: true });
}));



router.post('/:id/favorite', authenticate, asyncHandler(async (req, res) => {
  const { data: existing } = await db.from('favorites')
    .select('user_id').eq('user_id', req.user.id).eq('listing_id', req.params.id).single();

  if (existing) {
    await db.from('favorites').delete().eq('user_id', req.user.id).eq('listing_id', req.params.id);
    res.json({ favorited: false });
  } else {
    await db.from('favorites').insert({ user_id: req.user.id, listing_id: req.params.id });
    res.json({ favorited: true });
  }
}));

// ─── GET /api/listings/user/favorites — Mes favoris ──────────────────────────
router.get('/user/favorites', authenticate, asyncHandler(async (req, res) => {
  const { data } = await db.from('favorites')
    .select('listing_id, listings(*, listing_photos(url, is_main))')
    .eq('user_id', req.user.id);
  res.json({ favorites: data?.map(f => f.listings) || [] });
}));

module.exports = router;
