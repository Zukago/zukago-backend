/**
 * ZUKAGO — routes/messages.js (V14.3.2 PRO)
 *
 * 🎯 Système de chat in-app entre clients et partenaires
 *
 * ✅ V14.3.2 PRO — Fonctionnalités :
 *   - 5 endpoints chat (conversation, send, list, unread, mark-read)
 *   - Push notifications Expo (intégrées, pas de require externe)
 *   - Multilingue (FR/EN/DE) lu depuis users.preferred_lang
 *   - Notifications BDD multilingues
 *   - Auto-marquage des messages comme lus à l'ouverture
 *
 * 🔐 Sécurité :
 *   - JWT custom via middleware authenticate
 *   - Receiver = listing.partners.user_id
 *   - Si partenaire répond → bookingId requis
 *   - Anti self-message
 *
 * 📦 Dépendances minimales :
 *   - express, db, authenticate, asyncHandler
 *   - PAS de require de notifications.js (push intégré)
 *   - PAS de require de i18nService (multilingue intégré)
 */

const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const i18n = require('../services/i18nService');

const router = express.Router();

console.log('[Messages V14.3.2] Module chargé — chat in-app activé (push + i18n)');

// ═══════════════════════════════════════════════════════════════════════════
// 🌍 TRADUCTIONS PUSH NOTIFICATIONS (multilingue intégré)
// ═══════════════════════════════════════════════════════════════════════════
const I18N = {
  fr: {
    notif_title_prefix: '💬 Message de',
    notif_someone:      'Quelqu\'un',
  },
  en: {
    notif_title_prefix: '💬 Message from',
    notif_someone:      'Someone',
  },
  de: {
    notif_title_prefix: '💬 Nachricht von',
    notif_someone:      'Jemand',
  },
};

const VALID_LANGS = ['fr', 'en', 'de'];
const DEFAULT_LANG = 'fr';

/**
 * Résout la langue préférée d'un user (multi-fallback style Booking/Airbnb)
 * 1. users.preferred_lang
 * 2. push_tokens.locale (le plus récent)
 * 3. 'fr' (fallback)
 */
async function getUserLang(userId) {
  if (!userId) return DEFAULT_LANG;

  try {
    // 1. users.preferred_lang
    const { data: user } = await db.from('users')
      .select('preferred_lang')
      .eq('id', userId)
      .maybeSingle();

    if (user?.preferred_lang && VALID_LANGS.includes(user.preferred_lang)) {
      return user.preferred_lang;
    }

    // 2. fallback push_tokens.locale
    const { data: token } = await db.from('push_tokens')
      .select('locale')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (token?.locale && VALID_LANGS.includes(token.locale)) {
      return token.locale;
    }
  } catch (e) {
    console.log('[Messages] getUserLang error:', e.message);
  }

  return DEFAULT_LANG;
}

/**
 * Traduction d'une clé selon la langue
 */
function t(key, lang = DEFAULT_LANG) {
  const langTbl = I18N[lang] || I18N[DEFAULT_LANG];
  return langTbl[key] || I18N[DEFAULT_LANG][key] || key;
}

// ═══════════════════════════════════════════════════════════════════════════
// 📬 ENVOI PUSH NOTIFICATION VIA EXPO (intégré, sans require externe)
// ═══════════════════════════════════════════════════════════════════════════
async function sendExpoPush(receiverId, title, body, data = {}) {
  try {
    // Récupérer le push token du receiver
    const { data: tokenRow } = await db.from('push_tokens')
      .select('expo_push_token')
      .eq('user_id', receiverId)
      .maybeSingle();

    if (!tokenRow?.expo_push_token) {
      console.log('[Messages] Pas de push token pour user', receiverId);
      return false;
    }

    const expoPushToken = tokenRow.expo_push_token;

    // Vérifier que c'est un token Expo valide
    if (!expoPushToken.startsWith('ExponentPushToken[') &&
        !expoPushToken.startsWith('ExpoPushToken[')) {
      console.log('[Messages] Token Expo invalide:', expoPushToken);
      return false;
    }

    // Envoyer via Expo Push API
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: {
        'Accept':       'application/json',
        'Content-Type': 'application/json',
        'host':         'exp.host',
      },
      body: JSON.stringify({
        to:       expoPushToken,
        title,
        body,
        data,
        sound:    'default',
        priority: 'high',
        badge:    1,
      }),
    });

    if (!response.ok) {
      console.log('[Messages] Expo push HTTP error:', response.status);
      return false;
    }

    const result = await response.json();
    if (result?.data?.status === 'error') {
      console.log('[Messages] Expo push send error:', result.data.message);
      return false;
    }

    console.log('[Messages] Push envoyé à', receiverId);
    return true;
  } catch (e) {
    console.log('[Messages] sendExpoPush error:', e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/messages/conversation/:listingId
// Récupère l'historique de la conversation entre l'user connecté et l'autre participant
// ═══════════════════════════════════════════════════════════════════════════
router.get('/conversation/:listingId', authenticate, asyncHandler(async (req, res) => {
  const { listingId } = req.params;
  const userId = req.user.id;
  // ✅ V14.5.3 i18n : résoudre la langue de l'user pour les errors
  const L = await i18n.getUserLang(userId);

  // ✅ V14.6.1 — Fix Bug #1 Privacy : accepter other_user_id en query param
  // → Quand le partner ouvre une conversation pour un listing,
  //   il DOIT préciser avec quel client il veut discuter (sinon mélange des threads)
  // → Quand le client ouvre, il n'a pas besoin de préciser (le partner est unique)
  const otherUserIdFromQuery = req.query.other_user_id || null;

  // Récupérer le listing avec partner.user_id
  const { data: listing, error: lErr } = await db.from('listings')
    .select('id, type, title, partner_id, partners!inner(user_id)')
    .eq('id', listingId)
    .single();

  if (lErr || !listing) {
    return res.status(404).json({ error: await i18n.t('messages_error_listing_not_found', L, 'Annonce introuvable') });
  }

  const partnerUserId = listing.partners?.user_id;
  if (!partnerUserId) {
    return res.status(500).json({ error: await i18n.t('messages_error_partner_not_found', L, 'Partenaire de cette annonce introuvable') });
  }

  // Identifier l'autre participant
  const isPartner = (userId === partnerUserId);
  let otherUserId = isPartner ? otherUserIdFromQuery : partnerUserId;

  // ✅ V14.6.1 — Validation : si partner sans other_user_id → erreur 400
  // → Avant ce fix, le partner voyait TOUS les messages mélangés (privacy leak)
  if (isPartner && !otherUserId) {
    return res.status(400).json({
      error: await i18n.t('messages_error_other_user_required', L, "other_user_id requis quand le partenaire ouvre une conversation")
    });
  }

  // Filtre OR — TOUJOURS strict maintenant (plus de mélange)
  const filter = `and(sender_id.eq.${userId},receiver_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},receiver_id.eq.${userId})`;

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

  // Mark as read (les messages reçus par moi)
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
// Envoyer un message — déclenche push notification multilingue au receiver
// ═══════════════════════════════════════════════════════════════════════════
router.post('/', authenticate, asyncHandler(async (req, res) => {
  const { listing_id, content, booking_id } = req.body;
  const senderId = req.user.id;
  // ✅ V14.5.3 i18n : résoudre la langue du sender pour les errors
  const L = await i18n.getUserLang(senderId);

  // Validations
  if (!listing_id) {
    return res.status(400).json({ error: await i18n.t('messages_error_listing_id_required', L, 'listing_id requis') });
  }
  if (!content?.trim()) {
    return res.status(400).json({ error: await i18n.t('messages_error_empty', L, 'Message vide') });
  }
  if (content.length > 2000) {
    return res.status(400).json({ error: await i18n.t('messages_error_too_long', L, 'Message trop long (max 2000 caractères)') });
  }

  // Récupérer le listing
  const { data: listing, error: lErr } = await db.from('listings')
    .select('id, type, title, partner_id, partners!inner(user_id)')
    .eq('id', listing_id)
    .single();

  if (lErr || !listing) {
    return res.status(404).json({ error: await i18n.t('messages_error_listing_not_found', L, 'Annonce introuvable') });
  }

  const partnerUserId = listing.partners?.user_id;
  if (!partnerUserId) {
    return res.status(500).json({ error: await i18n.t('messages_error_partner_not_found', L, 'Partenaire de cette annonce introuvable') });
  }

  // Déterminer le receiver
  let receiverId;
  if (senderId === partnerUserId) {
    // Le partenaire répond
    if (!booking_id) {
      return res.status(400).json({
        error: await i18n.t('messages_error_booking_id_required', L, 'booking_id requis quand le partenaire répond à un client')
      });
    }
    const { data: booking } = await db.from('bookings')
      .select('user_id')
      .eq('id', booking_id)
      .maybeSingle();
    if (!booking) {
      return res.status(404).json({ error: await i18n.t('messages_error_booking_not_found', L, 'Réservation introuvable') });
    }
    receiverId = booking.user_id;
  } else {
    // Un client envoie au partenaire
    receiverId = partnerUserId;
  }

  // Anti self-message
  if (senderId === receiverId) {
    return res.status(400).json({
      error: await i18n.t('messages_error_self_message', L, 'Impossible de s\'envoyer un message à soi-même')
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

  // ═══ NOTIFICATIONS MULTILINGUES (DB + Push Expo) ═══════════════════════
  try {
    // 1. Récupérer la langue du receiver
    const receiverLang = await getUserLang(receiverId);

    // 2. Récupérer le nom de l'envoyeur
    const senderName = req.user.name
      || message.sender?.name
      || t('notif_someone', receiverLang);

    // 3. Construire title traduit
    const titlePrefix = t('notif_title_prefix', receiverLang);
    const title = `${titlePrefix} ${senderName}`;

    // 4. Preview body
    const preview = content.length > 50 ? content.slice(0, 50) + '...' : content;

    // 5. Insérer notification DB
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
      console.log('[Messages] Notification DB error:', e.message);
    }

    // 6. Envoyer push Expo
    await sendExpoPush(receiverId, title, preview, {
      type:       'message',
      listing_id,
      message_id: message.id,
      sender_id:  senderId,
      booking_id: booking_id || null,
    });
  } catch (e) {
    console.log('[Messages] Notification flow error:', e.message);
    // Ne bloque pas la réponse
  }

  res.status(201).json({ message });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/messages/conversations
// Liste de toutes mes conversations (groupées par listing + autre user)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/conversations', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user.id;

  console.log('[Messages] /conversations called by user:', userId);

  // V14.3.4 : jointure photos avec BONS noms de colonnes (url + sort_order, pas position)
  // Tri sur is_main + sort_order pour avoir la photo principale en premier
  const { data: allMessages, error } = await db.from('messages')
    .select(`
      id, content, created_at, read,
      listing_id, sender_id, receiver_id,
      listing:listings!listing_id(
        id, type, title,
        photos:listing_photos(url, is_main, sort_order)
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

  console.log('[Messages] /conversations found', (allMessages || []).length, 'messages for user', userId);

  const convMap = new Map();
  for (const msg of (allMessages || [])) {
    const otherUserId = (msg.sender_id === userId) ? msg.receiver_id : msg.sender_id;
    const otherUser   = (msg.sender_id === userId) ? msg.receiver    : msg.sender;
    const key = `${msg.listing_id}::${otherUserId}`;

    if (!convMap.has(key)) {
      // V14.3.4 : trier les photos (is_main d'abord, puis sort_order)
      const sortedPhotos = (msg.listing?.photos || []).slice().sort((a, b) => {
        if (a.is_main !== b.is_main) return b.is_main ? 1 : -1;
        return (a.sort_order ?? 99) - (b.sort_order ?? 99);
      });

      convMap.set(key, {
        listing: msg.listing ? { ...msg.listing, photos: sortedPhotos } : msg.listing,
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
