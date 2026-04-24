const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { authenticate, requireAdmin, requirePartner, optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { deleteImage } = require('../config/cloudinary');

const router = express.Router();

// ─── GET /api/listings — Liste publique ───────────────────────────────────────
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
  const { type, city, min_price, max_price, sort, amenities, search, featured, limit = 20, offset = 0 } = req.query;

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

  // ✅ V10 : tri spécial covoiturage par date de départ
  if (type === 'cov') {
    q = q.order('depart_date', { ascending: true }).order('depart_time', { ascending: true });
  } else if (sort === 'price_asc')  q = q.order('price', { ascending: true });
  else if (sort === 'price_desc') q = q.order('price', { ascending: false });
  else q = q.order('featured', { ascending: false }).order('created_at', { ascending: false });

  const { data: listings, error, count } = await q;
  if (error) throw new Error(error.message);

  // Calculer note moyenne
  const withRating = listings.map(l => ({
    ...l,
    rating: l.reviews?.length
      ? (l.reviews.reduce((sum, r) => sum + r.rating, 0) / l.reviews.length).toFixed(1)
      : null,
    reviews_count: l.reviews?.length || 0,
    main_photo: l.listing_photos?.find(p => p.is_main)?.url || l.listing_photos?.[0]?.url,
  }));

  res.json({ listings: withRating, total: count });
}));

// ─── GET /api/listings/:id — Détail ──────────────────────────────────────────
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
  const { data: listing, error } = await db.from('listings')
    .select(`
      *,
      listing_photos(url, public_id, is_main, sort_order),
      listing_amenities(amenity_code, amenities(label, emoji, category)),
      reviews(id, rating, comment, verified, created_at, users(name, avatar)),
      partners(id, user_id, users(name, avatar, verified))
    `)
    .eq('id', req.params.id)
    .eq('status', 'active')
    .single();

  if (error || !listing) return res.status(404).json({ error: 'Annonce introuvable' });

  // Incrémenter vues
  await db.from('listings').update({ views: (listing.views || 0) + 1 }).eq('id', listing.id);

  // Calculer note
  const rating = listing.reviews?.length
    ? (listing.reviews.reduce((sum, r) => sum + r.rating, 0) / listing.reviews.length).toFixed(1)
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
      rating,
      reviews_count: listing.reviews?.length,
      isFavorite,
      room_types: roomTypes,
      cancel_policy_details: cancelPolicyDetails,
    },
  });
}));


// ─── GET /api/listings/:id/availability — Dates occupées
router.get('/:id/availability', asyncHandler(async (req, res) => {
  const { data: bookings } = await db.from('bookings')
    .select('start_date, end_date')
    .eq('listing_id', req.params.id)
    .in('status', ['confirmed', 'pending']);

  // Construire la liste de toutes les dates occupées
  const bookedDates = [];
  (bookings || []).forEach(b => {
    const start = new Date(b.start_date);
    const end   = new Date(b.end_date);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      bookedDates.push(d.toISOString().split('T')[0]);
    }
  });

  res.json({ bookedDates: [...new Set(bookedDates)] });
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

  // Récupérer partner_id — l'utilisateur DOIT être un partenaire approuvé
  const { data: partner } = await db.from('partners')
    .select('id, status').eq('user_id', req.user.id).single();

  if (!partner) {
    return res.status(403).json({
      error: 'Vous devez soumettre une demande partenaire avant de publier',
      reason: 'no_partner_profile',
    });
  }
  if (partner.status !== 'approved') {
    return res.status(403).json({
      error: partner.status === 'pending'
        ? 'Votre demande partenaire est en cours de vérification'
        : partner.status === 'rejected'
          ? 'Votre demande partenaire a été rejetée. Contactez le support.'
          : 'Votre compte partenaire n\'est pas actif',
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
  } = req.body;

  // ═══════════════════════════════════════════════════════════════════
  // ✅ V10 : Branche COVOITURAGE — logique spéciale
  // ═══════════════════════════════════════════════════════════════════
  if (type === 'cov') {
    if (!from_city || !to_city || !depart_date || !depart_time) {
      return res.status(400).json({ error: 'Champs covoiturage manquants (from_city, to_city, depart_date, depart_time)' });
    }
    if (!seats_total || seats_total < 1) {
      return res.status(400).json({ error: 'seats_total invalide' });
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
    }).select().single();

    if (covError) throw new Error(covError.message);

    return res.status(201).json({
      listing: covListing,
      message: 'Trajet covoiturage publié',
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
      price_5nights:      rt.price_5nights ? parseInt(rt.price_5nights, 10) : null,
      price_week:         rt.price_week    ? parseInt(rt.price_week, 10)    : null,
      price_month:        rt.price_month   ? parseInt(rt.price_month, 10)   : null,
      breakfast_included: !!rt.breakfast_included,
      quantity:           parseInt(rt.quantity, 10) || 1,
      photos:             Array.isArray(rt.photos) ? rt.photos : [],
      sort_order:         idx,
    }));
    const { error: rtError } = await db.from('listing_room_types').insert(roomTypesToInsert);
    if (rtError) console.log('Room types insert error:', rtError.message);
  }

  res.status(201).json({ listing, message: 'Annonce soumise pour approbation (24-48h)' });
}));

// ─── PATCH /api/listings/:id — Modifier annonce ───────────────────────────────
router.patch('/:id', authenticate, asyncHandler(async (req, res) => {
  const { data: listing } = await db.from('listings').select('partner_id, partners(user_id)').eq('id', req.params.id).single();
  if (!listing) return res.status(404).json({ error: 'Annonce introuvable' });

  const isOwner = listing.partners?.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Non autorisé' });

  const { amenities, ...updates } = req.body;
  if (!isAdmin) delete updates.status; // partenaire ne peut pas changer le statut

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
  const { data: listing } = await db.from('listings')
    .select('id, title, partner_id, partners(user_id)')
    .eq('id', req.params.id).single();

  if (!listing) return res.status(404).json({ error: 'Annonce introuvable' });

  const isOwner = listing.partners?.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Non autorisé' });

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
        error: 'Suppression impossible',
        reason: 'confirmed_bookings',
        count: confirmedBookings.length,
        message: `Cette annonce a ${confirmedBookings.length} réservation(s) confirmée(s). Contactez l'administrateur ZUKAGO pour procéder à la suppression.`,
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

      // Notifier chaque client
      await db.from('notifications').insert(
        confirmedDetails.map(b => ({
          user_id: b.user_id,
          title:   'Réservation annulée',
          body:    `Votre réservation confirmée pour "${listing.title}" a été annulée par l'administration ZUKAGO. Nous nous excusons pour ce désagrément.`,
          type:    'info',
        }))
      );
    }

    // Notifier le partenaire
    try {
      const { data: partnerRow } = await db.from('partners')
        .select('user_id')
        .eq('id', listing.partner_id)
        .single();
      if (partnerRow?.user_id) {
        await db.from('notifications').insert({
          user_id: partnerRow.user_id,
          title:   'Annonce supprimée par l\'administration',
          body:    `Votre annonce "${listing.title}" a été supprimée par l'équipe ZUKAGO. ${confirmedBookings.length} réservation(s) confirmée(s) ont été annulées et les clients notifiés.`,
          type:    'info',
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
      await db.from('notifications').insert(
        pendingDetails.map(b => ({
          user_id: b.user_id,
          title: 'Réservation annulée',
          body: `Votre réservation pour "${listing.title}" a été annulée car l'annonce a été supprimée.`,
          type: 'info',
        }))
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
  res.json({ message: 'Annonce supprimée définitivement', deleted: true });
}));


// ─── POST /api/listings/:id/favorite — Ajouter/retirer favori ────────────────
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
