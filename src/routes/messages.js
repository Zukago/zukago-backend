/**
 * ZUKAGO — routes/messages.js (V14.3)
 *
 * Système de chat in-app entre clients et partenaires
 *
 * 🎯 Architecture :
 *   - Compatible TOUS les types listings (apt, hotel, car, driver, cov)
 *   - Receiver = listing.partners.user_id (le propriétaire)
 *   - Sécurité via JWT custom (middleware authenticate)
 *   - PAS de RLS Supabase
 *
 * 🌍 Multilingue PRO (style Booking/Airbnb) :
 *   - Notifications DB traduites côté serveur (i18nService)
 *   - Push notifications traduites côté serveur
 *   - Multi-fallback : users.preferred_lang → push_tokens.locale → 'fr'
 *
 * 📦 5 endpoints :
 *   - GET    /api/messages/conversation/:listingId  (historique d'une conversation)
 *   - POST   /api/messages                           (envoyer un message)
 *   - GET    /api/messages/conversations             (liste de toutes mes conversations)
 *   - GET    /api/messages/unread-count              (badge nombre non lus)
 *   - PATCH  /api/messages/mark-read/:listingId      (marquer comme lus)
 */

const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const i18n = require('../services/i18nService');

// Helper pour push notifications (exporté depuis notifications.js)
const notificationsRouter = require('./notifications');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/messages/conversation/:listingId
// Récupère l'historique de la conversation entre l'user connecté et le partenaire
// (ou le client, si l'user est partenaire) pour un listing donné.
// Marque automatiquement les messages reçus comme lus.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/conversation/:listingId', authenticate, asyncHandler(async (req, res) => {
  const { listingId } = req.params;
  const userId = req.user.id;

  // 1. Vérifier que le listing existe et récupérer le partner.user_id
  const { data: listing, error: lErr } = await db.from('listings')
    .select('id, type, title, partner_id, partners!inner(user_id)')
    .eq('id', listingId)
    .single();

  if (lErr || !listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }

  const partnerUserId = listing.partners?.user_id;
  if (!partnerUserId) {
    return res.status(500).json({ error: 'Partenaire de cette annonce introuvable' });
  }

  // 2. Identifier l'autre participant
  // Si user = partenaire → l'autre est un client précédent (à identifier via messages existants)
  // Si user = client → l'autre est le partenaire
  let otherUserId = (userId === partnerUserId) ? null : partnerUserId;

  // 3. Construire le filtre OR pour récupérer les messages des deux sens
  let filter;
  if (otherUserId) {
    // Cas client : récupère messages entre user et partenaire
    filter = `and(sender_id.eq.${userId},receiver_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},receiver_id.eq.${userId})`;
  } else {
    // Cas partenaire : récupère TOUS les messages où il est sender ou receiver pour CE listing
    filter = `sender_id.eq.${userId},receiver_id.eq.${userId}`;
  }

  // 4. Récupérer les messages
  const { data: messages, error } = await db.from('messages')
    .select(`
      id, content, created_at, read, read_at,
      sender_id, receiver_id, booking_id,
      sender:users!sender_id(id, name, avatar),
      receiver:users!receiver_id(id, name, avatar)
    `)
    .eq('listing_id', listingId)
    .or(filter)
    .order('created_at', { ascending: true });

  if (error) {
    console.log('[Messages] Conversation fetch error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // 5. Marquer comme lus tous les messages reçus par l'user
  const unreadIds = (messages || [])
    .filter(m => m.receiver_id === userId && !m.read)
    .map(m => m.id);

  if (unreadIds.length > 0) {
    await db.from('messages')
      .update({ read: true, read_at: new Date().toISOString() })
      .in('id', unreadIds);
  }

  res.json({
    messages: messages || [],
    listing: {
      id:              listing.id,
      type:            listing.type,
      title:           listing.title,
      partner_user_id: partnerUserId,
    },
  });
}));

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/messages
// Envoyer un message
// Body : { listing_id, content, booking_id? }
// ═══════════════════════════════════════════════════════════════════════════
router.post('/', authenticate, asyncHandler(async (req, res) => {
  const { listing_id, content, booking_id } = req.body;
  const senderId = req.user.id;

  // ─── Validations ───────────────────────────────────────────────────────
  if (!listing_id) {
    return res.status(400).json({ error: 'listing_id requis' });
  }
  if (!content?.trim()) {
    return res.status(400).json({ error: 'Message vide' });
  }
  if (content.length > 2000) {
    return res.status(400).json({ error: 'Message trop long (max 2000 caractères)' });
  }

  // ─── 1. Récupérer le listing ───────────────────────────────────────────
  const { data: listing, error: lErr } = await db.from('listings')
    .select('id, type, title, partner_id, partners!inner(user_id)')
    .eq('id', listing_id)
    .single();

  if (lErr || !listing) {
    return res.status(404).json({ error: 'Annonce introuvable' });
  }

  const partnerUserId = listing.partners?.user_id;
  if (!partnerUserId) {
    return res.status(500).json({ error: 'Partenaire de cette annonce introuvable' });
  }

  // ─── 2. Déterminer le receiver ─────────────────────────────────────────
  // - Si sender = partenaire → receiver = client (via booking_id obligatoire)
  // - Sinon (sender = client) → receiver = partner.user_id
  let receiverId;
  if (senderId === partnerUserId) {
    // Le partenaire répond → besoin d'identifier le client via booking_id
    if (!booking_id) {
      return res.status(400).json({
        error: 'booking_id requis quand le partenaire répond à un client'
      });
    }
    const { data: booking } = await db.from('bookings')
      .select('user_id')
      .eq('id', booking_id)
      .maybeSingle();
    if (!booking) {
      return res.status(404).json({ error: 'Réservation introuvable' });
    }
    receiverId = booking.user_id;
  } else {
    // Un client envoie au partenaire
    receiverId = partnerUserId;
  }

  // ─── 3. Sécurité : pas de message à soi-même ───────────────────────────
  if (senderId === receiverId) {
    return res.status(400).json({
      error: 'Impossible de s\'envoyer un message à soi-même'
    });
  }

  // ─── 4. Insérer le message en DB ───────────────────────────────────────
  const { data: message, error } = await db.from('messages')
    .insert({
      listing_id,
      booking_id:  booking_id || null,
      sender_id:   senderId,
      receiver_id: receiverId,
      content:     content.trim(),
    })
    .select(`
      *,
      sender:users!sender_id(id, name, avatar),
      receiver:users!receiver_id(id, name, avatar)
    `)
    .single();

  if (error) {
    console.log('[Messages] Insert error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // ─── 5. Notification DB + Push (multilingue PRO via i18nService) ──────
  try {
    // Récupérer la langue du receiver (via i18nService multi-fallback)
    const receiverLang = await i18n.getUserLang(receiverId);

    // Nom de l'expéditeur
    const senderName = req.user.name || await i18n.t('chat.notif_someone', receiverLang, 'Quelqu\'un');

    // Construire le titre traduit : "💬 Message de {name}" ou "💬 Message from {name}" etc.
    const titlePrefix = await i18n.t('chat.notif_title_prefix', receiverLang, '💬 Message de');
    const title = `${titlePrefix} ${senderName}`;

    // Preview du body (trimmed à 50 caractères)
    const preview = content.length > 50 ? content.slice(0, 50) + '...' : content;

    // ─── 5a. Insérer notification dans la table notifications ──────────
    try {
      await db.from('notifications').insert({
        user_id: receiverId,
        title,
        body:    preview,
        type:    'message',
        data:    JSON.stringify({
          listing_id,
          message_id: message.id,
          sender_id:  senderId,
          booking_id: booking_id || null,
        }),
      });
    } catch (e) {
      console.log('[Messages] Notification DB insert error:', e.message);
    }

    // ─── 5b. Envoyer la push notification (Expo) ───────────────────────
    try {
      if (typeof notificationsRouter.sendPushToUser === 'function') {
        await notificationsRouter.sendPushToUser(
          receiverId,
          title,
          preview,
          {
            type: 'message',
            listing_id,
            message_id: message.id,
            sender_id:  senderId,
            booking_id: booking_id || null,
          }
        );
      }
    } catch (e) {
      console.log('[Messages] Push send error:', e.message);
    }
  } catch (e) {
    console.log('[Messages] Notification flow error:', e.message);
    // On ne bloque pas la réponse en cas d'erreur de notification
  }

  res.status(201).json({ message });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/messages/conversations
// Liste de toutes les conversations de l'user (groupées par listing + autre user)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/conversations', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Récupérer TOUS les messages où l'user est sender ou receiver
  const { data: allMessages, error } = await db.from('messages')
    .select(`
      id, content, created_at, read,
      listing_id, sender_id, receiver_id,
      listing:listings!listing_id(
        id, type, title,
        photos:listing_photos(url, position)
      ),
      sender:users!sender_id(id, name, avatar),
      receiver:users!receiver_id(id, name, avatar)
    `)
    .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
    .order('created_at', { ascending: false });

  if (error) {
    console.log('[Messages] Conversations fetch error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Grouper par "conversation" (listing_id + l'autre user)
  const convMap = new Map();
  for (const msg of (allMessages || [])) {
    const otherUserId = (msg.sender_id === userId) ? msg.receiver_id : msg.sender_id;
    const otherUser   = (msg.sender_id === userId) ? msg.receiver    : msg.sender;
    const key = `${msg.listing_id}::${otherUserId}`;

    if (!convMap.has(key)) {
      // Premier message rencontré pour cette conversation = le plus récent (ordre DESC)
      convMap.set(key, {
        listing:    msg.listing,
        other_user: otherUser,
        last_message: {
          content:    msg.content,
          created_at: msg.created_at,
          is_mine:    msg.sender_id === userId,
          read:       msg.read,
        },
        unread_count: 0,
      });
    }

    // Compter les non-lus reçus par moi
    if (msg.receiver_id === userId && !msg.read) {
      convMap.get(key).unread_count++;
    }
  }

  res.json({ conversations: Array.from(convMap.values()) });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/messages/unread-count
// Nombre total de messages non lus (pour badge sur l'icône Conversations)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/unread-count', authenticate, asyncHandler(async (req, res) => {
  const { count, error } = await db.from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('receiver_id', req.user.id)
    .eq('read', false);

  if (error) {
    console.log('[Messages] Unread count error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json({ unread: count || 0 });
}));

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /api/messages/mark-read/:listingId
// Marquer comme lus tous les messages reçus dans cette conversation
// ═══════════════════════════════════════════════════════════════════════════
router.patch('/mark-read/:listingId', authenticate, asyncHandler(async (req, res) => {
  const { listingId } = req.params;
  const userId = req.user.id;

  const { error } = await db.from('messages')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('listing_id', listingId)
    .eq('receiver_id', userId)
    .eq('read', false);

  if (error) {
    console.log('[Messages] Mark-read error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true });
}));

module.exports = router;
