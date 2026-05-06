/**
 * ZUKAGO — routes/messages.js (V14.3.1 - SIMPLIFIÉ pour debug Railway)
 *
 * Version sans dépendances complexes :
 *   - PAS de i18nService (multilingue désactivé temporairement)
 *   - PAS de notifications.js (push désactivé temporairement)
 *
 * Une fois cette version qui marche, on remettra le multilingue et les push.
 *
 * 5 endpoints :
 *   - GET    /api/messages/conversation/:listingId
 *   - POST   /api/messages
 *   - GET    /api/messages/conversations
 *   - GET    /api/messages/unread-count
 *   - PATCH  /api/messages/mark-read/:listingId
 */

const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

console.log('[Messages V14.3.1] Module chargé — chat in-app activé');

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/messages/conversation/:listingId
// ═══════════════════════════════════════════════════════════════════════════
router.get('/conversation/:listingId', authenticate, asyncHandler(async (req, res) => {
  const { listingId } = req.params;
  const userId = req.user.id;

  // Récupérer le listing avec partner.user_id
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

  // Identifier l'autre participant
  let otherUserId = (userId === partnerUserId) ? null : partnerUserId;

  // Filtre OR
  let filter;
  if (otherUserId) {
    filter = `and(sender_id.eq.${userId},receiver_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},receiver_id.eq.${userId})`;
  } else {
    filter = `sender_id.eq.${userId},receiver_id.eq.${userId}`;
  }

  // Récupérer messages
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

  // Mark as read
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
// ═══════════════════════════════════════════════════════════════════════════
router.post('/', authenticate, asyncHandler(async (req, res) => {
  const { listing_id, content, booking_id } = req.body;
  const senderId = req.user.id;

  if (!listing_id) {
    return res.status(400).json({ error: 'listing_id requis' });
  }
  if (!content?.trim()) {
    return res.status(400).json({ error: 'Message vide' });
  }
  if (content.length > 2000) {
    return res.status(400).json({ error: 'Message trop long (max 2000 caractères)' });
  }

  // Récupérer le listing
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

  // Déterminer le receiver
  let receiverId;
  if (senderId === partnerUserId) {
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
    receiverId = partnerUserId;
  }

  if (senderId === receiverId) {
    return res.status(400).json({
      error: 'Impossible de s\'envoyer un message à soi-même'
    });
  }

  // Insérer le message
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

  // Notification DB simple (sans push pour l'instant)
  try {
    const senderName = req.user.name || 'Quelqu\'un';
    const preview = content.length > 50 ? content.slice(0, 50) + '...' : content;

    await db.from('notifications').insert({
      user_id: receiverId,
      title:   `💬 Message de ${senderName}`,
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

  res.status(201).json({ message });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/messages/conversations
// ═══════════════════════════════════════════════════════════════════════════
router.get('/conversations', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user.id;

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

  const convMap = new Map();
  for (const msg of (allMessages || [])) {
    const otherUserId = (msg.sender_id === userId) ? msg.receiver_id : msg.sender_id;
    const otherUser   = (msg.sender_id === userId) ? msg.receiver    : msg.sender;
    const key = `${msg.listing_id}::${otherUserId}`;

    if (!convMap.has(key)) {
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

    if (msg.receiver_id === userId && !msg.read) {
      convMap.get(key).unread_count++;
    }
  }

  res.json({ conversations: Array.from(convMap.values()) });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/messages/unread-count
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
