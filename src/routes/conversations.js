// ═══════════════════════════════════════════════════════════════════════════
// ZUKAGO — Routes /api/conversations (V14.7.0 — Strangler Pattern Phase 2)
// ═══════════════════════════════════════════════════════════════════════════
//
// 🎯 OBJECTIF
//   Nouveaux endpoints REST utilisant la table `conversations` créée en V14.7.0.
//   Plus performant, plus propre, privacy garantie par DB.
//
// 🛡️ STRATEGIE STRANGLER
//   - Ces endpoints coexistent avec les anciens /api/messages/conversations
//   - L'app mobile 1.0.2 actuelle utilise encore les anciens
//   - L'app mobile 1.0.3 future utilisera ces nouveaux
//   - Quand 100% des users sont sur 1.0.3, on supprimera les anciens
//
// 📋 ENDPOINTS
//   GET   /api/conversations              → liste des conversations du user
//   GET   /api/conversations/:id          → détail (conversation + messages)
//   PATCH /api/conversations/:id/read     → marque tous les messages comme lus
//
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const i18n    = require('../services/i18nService');


// ═══════════════════════════════════════════════════════════════════════════
// GET /api/conversations
// Liste les conversations de l'utilisateur connecté (client OU partner)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user.id;

  console.log('[Conversations] GET / called by user:', userId);

  // Récupérer toutes les conversations où le user est client OU partner
  // Avec jointures : listing (photos), client, partner
  const { data: conversations, error } = await db.from('conversations')
    .select(`
      id,
      listing_id,
      client_id,
      partner_id,
      last_message_at,
      last_message_preview,
      last_message_sender,
      unread_for_client,
      unread_for_partner,
      archived_by_client,
      archived_by_partner,
      created_at,
      listing:listings!listing_id(
        id, type, title,
        photos:listing_photos(url, is_main, sort_order)
      ),
      client:users!client_id(id, name, avatar),
      partner:users!partner_id(id, name, avatar)
    `)
    .or(`client_id.eq.${userId},partner_id.eq.${userId}`)
    .order('last_message_at', { ascending: false, nullsFirst: false });

  if (error) {
    console.log('[Conversations] List fetch error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Enrichir : déterminer qui est l'"autre", quel est le unread pour MOI, etc.
  const enriched = (conversations || [])
    // Filtrer les archivées par moi
    .filter(c => {
      const iAmClient = (c.client_id === userId);
      return iAmClient ? !c.archived_by_client : !c.archived_by_partner;
    })
    .map(c => {
      const iAmClient = (c.client_id === userId);
      const otherUser = iAmClient ? c.partner : c.client;
      const unreadCount = iAmClient ? c.unread_for_client : c.unread_for_partner;

      // Trier les photos (is_main d'abord, puis sort_order)
      const sortedPhotos = (c.listing?.photos || []).slice().sort((a, b) => {
        if (a.is_main !== b.is_main) return b.is_main ? 1 : -1;
        return (a.sort_order ?? 99) - (b.sort_order ?? 99);
      });

      return {
        id:           c.id,
        listing:      c.listing ? { ...c.listing, photos: sortedPhotos } : null,
        other_user:   otherUser,
        last_message: {
          content:    c.last_message_preview,
          created_at: c.last_message_at,
          is_mine:    c.last_message_sender === userId,
        },
        unread_count: unreadCount || 0,
        i_am_client:  iAmClient,
      };
    });

  console.log('[Conversations] Returning', enriched.length, 'conversations for user', userId);
  res.json({ conversations: enriched });
}));


// ═══════════════════════════════════════════════════════════════════════════
// GET /api/conversations/:id
// Récupère le détail d'une conversation : metadata + messages
// Marque automatiquement les messages comme lus pour le user courant
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const L = await i18n.getUserLang(userId);

  // 1. Récupérer la conversation avec sécurité (le user doit être client OU partner)
  const { data: conversation, error: convErr } = await db.from('conversations')
    .select(`
      id, listing_id, client_id, partner_id,
      last_message_at, last_message_preview,
      unread_for_client, unread_for_partner,
      created_at,
      listing:listings!listing_id(id, type, title, partner_id),
      client:users!client_id(id, name, avatar),
      partner:users!partner_id(id, name, avatar)
    `)
    .eq('id', id)
    .single();

  if (convErr || !conversation) {
    return res.status(404).json({ error: await i18n.t('conversations_error_not_found', L, 'Conversation introuvable') });
  }

  // Vérification sécurité — le user doit être client OU partner
  if (conversation.client_id !== userId && conversation.partner_id !== userId) {
    return res.status(403).json({ error: await i18n.t('conversations_error_forbidden', L, 'Accès refusé à cette conversation') });
  }

  // 2. Récupérer tous les messages de cette conversation (ordre chronologique)
  const { data: messages, error: msgErr } = await db.from('messages')
    .select(`
      id, content, created_at, read, read_at,
      sender_id, receiver_id, booking_id,
      sender:users!sender_id(id, name, avatar),
      receiver:users!receiver_id(id, name, avatar)
    `)
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });

  if (msgErr) {
    console.log('[Conversations] Messages fetch error:', msgErr.message);
    return res.status(500).json({ error: msgErr.message });
  }

  // 3. Marquer comme lu (messages reçus par moi et non encore lus)
  const unreadIds = (messages || [])
    .filter(m => m.receiver_id === userId && !m.read)
    .map(m => m.id);

  if (unreadIds.length > 0) {
    // Marquer les messages comme lus
    await db.from('messages')
      .update({ read: true, read_at: new Date().toISOString() })
      .in('id', unreadIds);

    // Remettre à 0 le compteur unread pour le user courant
    const iAmClient = (conversation.client_id === userId);
    const updateField = iAmClient ? 'unread_for_client' : 'unread_for_partner';
    await db.from('conversations')
      .update({ [updateField]: 0, updated_at: new Date().toISOString() })
      .eq('id', id);
  }

  // 4. Renvoyer la conversation + messages
  res.json({
    conversation: {
      id:                conversation.id,
      listing:           conversation.listing,
      client:            conversation.client,
      partner:           conversation.partner,
      i_am_client:       conversation.client_id === userId,
      partner_user_id:   conversation.partner_id,
      last_message_at:   conversation.last_message_at,
    },
    messages: messages || [],
  });
}));


// ═══════════════════════════════════════════════════════════════════════════
// PATCH /api/conversations/:id/read
// Marque manuellement la conversation comme lue (sans charger les messages)
// Utile pour swipe ou bouton "tout marquer comme lu"
// ═══════════════════════════════════════════════════════════════════════════
router.patch('/:id/read', authenticate, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const L = await i18n.getUserLang(userId);

  // Récupérer la conversation pour vérifier l'accès
  const { data: conversation } = await db.from('conversations')
    .select('client_id, partner_id')
    .eq('id', id)
    .single();

  if (!conversation) {
    return res.status(404).json({ error: await i18n.t('conversations_error_not_found', L, 'Conversation introuvable') });
  }
  if (conversation.client_id !== userId && conversation.partner_id !== userId) {
    return res.status(403).json({ error: await i18n.t('conversations_error_forbidden', L, 'Accès refusé') });
  }

  // Marquer tous les messages reçus par moi comme lus
  await db.from('messages')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('conversation_id', id)
    .eq('receiver_id', userId)
    .eq('read', false);

  // Remettre à 0 le compteur unread pour le user courant
  const iAmClient = (conversation.client_id === userId);
  const updateField = iAmClient ? 'unread_for_client' : 'unread_for_partner';
  await db.from('conversations')
    .update({ [updateField]: 0, updated_at: new Date().toISOString() })
    .eq('id', id);

  res.json({ success: true });
}));


// ═══════════════════════════════════════════════════════════════════════════
// GET /api/conversations/unread/count
// Compte total des messages non-lus du user (pour badge tab Profil)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/unread/count', authenticate, asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Somme des unread_for_client (si user est client) + unread_for_partner (si user est partner)
  const { data: conversations } = await db.from('conversations')
    .select('client_id, partner_id, unread_for_client, unread_for_partner')
    .or(`client_id.eq.${userId},partner_id.eq.${userId}`);

  let totalUnread = 0;
  for (const c of (conversations || [])) {
    if (c.client_id === userId) totalUnread += (c.unread_for_client || 0);
    if (c.partner_id === userId) totalUnread += (c.unread_for_partner || 0);
  }

  res.json({ unread_count: totalUnread });
}));


module.exports = router;
