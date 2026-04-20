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

  if (sort === 'price_asc')  q = q.order('price', { ascending: true });
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
      listing_amenities(amenity_code, amenities(label, emoji)),
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

  res.json({ listing: { ...listing, rating, reviews_count: listing.reviews?.length, isFavorite } });
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
router.post('/', authenticate, requirePartner, [
  body('type').isIn(['apt', 'hotel', 'car', 'driver']),
  body('title').trim().isLength({ min: 2, max: 100 }),
  body('description').trim().isLength({ min: 2 }),
  body('price').isNumeric(),
  body('city_code').notEmpty(),
  body('quartier').notEmpty(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  // Récupérer partner_id
  const { data: partner } = await db.from('partners')
    .select('id, status').eq('user_id', req.user.id).single();

  // Si pas de partner → créer automatiquement
  let partnerId;
  if (!partner) {
    const { data: newPartner } = await db.from('partners')
      .insert({ user_id: req.user.id, type: 'proprietaire', status: 'approved' })
      .select().single();
    partnerId = newPartner?.id;
  } else {
    // Auto-approuver si role=partner dans users
    if (partner.status !== 'approved') {
      await db.from('partners').update({ status: 'approved' }).eq('id', partner.id);
    }
    partnerId = partner.id;
  }

  const { type, title, description, sub_type, city_code, quartier, address,
          price, price_weekend, unit, min_nights, caution, whatsapp, contact_email, amenities } = req.body;

  const { data: listing, error } = await db.from('listings').insert({
    partner_id: partnerId,
    type, title, description, sub_type,
    city_code, quartier, address,
    price, price_weekend: price_weekend || null,
    unit: unit || (type === 'car' || type === 'driver' ? 'jour' : 'nuit'),
    min_nights: min_nights || 1,
    caution: caution || null,
    whatsapp, contact_email,
    status: 'pending',
  }).select().single();

  if (error) throw new Error(error.message);

  // Ajouter équipements
  if (amenities?.length) {
    await db.from('listing_amenities').insert(
      amenities.map(code => ({ listing_id: listing.id, amenity_code: code }))
    );
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
