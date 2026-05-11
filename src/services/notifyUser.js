/**
 * ZUKAGO — services/notifyUser.js (V14.5.4)
 *
 * 🎯 Helper centralisé pour CRÉER une notification :
 *    1. INSERT en table 'notifications' (Supabase)
 *    2. ENVOI push notification via Expo Push API
 *
 * 🛡️ Bénéfices :
 *    - Plus jamais d'oubli de push (était le bug V14.5.3 — seul messages.js
 *      envoyait du push, les 27 autres inserts étaient silencieux)
 *    - i18n préservée (les title/body doivent être traduits par le caller)
 *    - Robustesse : si push échoue, DB insert continue
 *    - Logs centralisés pour debug
 *
 * 📋 Usage :
 *
 *    const { notifyUser } = require('../services/notifyUser');
 *
 *    // Le caller fait la traduction i18n AVANT d'appeler notifyUser
 *    const L = await i18n.getUserLang(userId);
 *    await notifyUser(userId, {
 *      title: await i18n.t('notif_xxx_title', L, '...fallback...'),
 *      body:  await i18n.t('notif_xxx_body',  L, '...fallback...', { name }),
 *      type:  'booking',         // optional, default 'info'
 *      data:  { booking_id: 42 } // optional, pour deep linking dans l'app
 *    });
 *
 * 📋 Usage BATCH (plusieurs users d'un coup) :
 *
 *    await notifyUsers([userId1, userId2, userId3], {
 *      title: '...',
 *      body:  '...',
 *      type:  'broadcast',
 *    });
 *
 * 📋 Types acceptés (compatibles colonne notifications.type existante) :
 *    - 'info'      : info générale
 *    - 'booking'   : réservation
 *    - 'payment'   : paiement
 *    - 'review'    : avis
 *    - 'message'   : message (mais messages.js a son propre push intégré)
 *    - 'partner'   : partenaire
 *    - 'admin'     : admin
 *    - 'system'    : système
 *
 * ⚠️ NE PAS UTILISER directement pour les messages : messages.js a déjà
 *    sa propre logique de push intégrée (sendExpoPush local). Préserver
 *    pour ne rien casser de ce qui marche.
 */

const db = require('../config/database');

// ═══════════════════════════════════════════════════════════════════════════
// 📬 ENVOI PUSH NOTIFICATION VIA EXPO (intégré, sans require externe)
// ═══════════════════════════════════════════════════════════════════════════
// 🛡️ Note : on intègre le code Expo Push ici plutôt que de require()
//           depuis routes/notifications.js, pour éviter dépendance circulaire
//           (notifications.js peut un jour vouloir notifier via ce helper).
async function sendExpoPushInternal(receiverId, title, body, data = {}) {
  try {
    // Récupérer le push token du receiver
    const { data: tokenRow } = await db.from('push_tokens')
      .select('expo_push_token')
      .eq('user_id', receiverId)
      .maybeSingle();

    if (!tokenRow?.expo_push_token) {
      // Pas de token = user pas encore enregistré device, OK silencieux
      return false;
    }

    const expoPushToken = tokenRow.expo_push_token;

    // Vérifier que c'est un token Expo valide
    if (!expoPushToken.startsWith('ExponentPushToken[') &&
        !expoPushToken.startsWith('ExpoPushToken[')) {
      console.log('[notifyUser] Token Expo invalide pour user', receiverId);
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
      console.log('[notifyUser] Expo push HTTP error:', response.status);
      return false;
    }

    const result = await response.json();
    if (result?.data?.status === 'error') {
      console.log('[notifyUser] Expo push send error:', result.data.message);
      return false;
    }

    return true;
  } catch (e) {
    console.log('[notifyUser] sendExpoPush error:', e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🎯 NOTIFY USER — Helper principal (1 user)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Notifie UN user : DB insert + push.
 *
 * @param {string} userId - UUID du user destinataire
 * @param {Object} params
 * @param {string} params.title - Titre déjà traduit (i18n)
 * @param {string} params.body - Body déjà traduit (i18n)
 * @param {string} [params.type='info'] - Type de notif
 * @param {Object} [params.data={}] - Data libre pour deep linking
 * @returns {Promise<{db_ok: boolean, push_ok: boolean}>}
 */
async function notifyUser(userId, params) {
  const result = { db_ok: false, push_ok: false };

  if (!userId) {
    console.log('[notifyUser] userId manquant, skip');
    return result;
  }
  if (!params?.title || !params?.body) {
    console.log('[notifyUser] title ou body manquant, skip');
    return result;
  }

  const {
    title,
    body,
    type = 'info',
    data = {},
  } = params;

  // ── 1. Insert DB (table 'notifications')
  try {
    const { error: dbErr } = await db.from('notifications').insert({
      user_id: userId,
      title,
      body,
      type,
    });
    if (dbErr) {
      console.log('[notifyUser] DB insert error:', dbErr.message);
    } else {
      result.db_ok = true;
    }
  } catch (e) {
    console.log('[notifyUser] DB insert exception:', e.message);
  }

  // ── 2. Push notification (non bloquant : si échec, DB déjà OK)
  try {
    result.push_ok = await sendExpoPushInternal(userId, title, body, data);
  } catch (e) {
    console.log('[notifyUser] Push exception:', e.message);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🎯 NOTIFY USERS — Helper BATCH (plusieurs users d'un coup)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Notifie PLUSIEURS users avec le MÊME message.
 * Utile pour broadcasts (ex: tous les clients sur un nouvel événement).
 *
 * ⚠️ Le message est IDENTIQUE pour tous → pas d'i18n par user ici.
 *    Pour notifier en plusieurs langues, faire plusieurs appels notifyUsers()
 *    avec des sous-groupes par langue (ou loop avec notifyUser()).
 *
 * @param {string[]} userIds - Array d'UUIDs des destinataires
 * @param {Object} params - Mêmes params que notifyUser
 * @returns {Promise<{db_ok: number, push_ok: number, total: number}>}
 */
async function notifyUsers(userIds, params) {
  const result = { db_ok: 0, push_ok: 0, total: 0 };

  if (!Array.isArray(userIds) || userIds.length === 0) {
    return result;
  }
  if (!params?.title || !params?.body) {
    console.log('[notifyUsers] title ou body manquant, skip');
    return result;
  }

  result.total = userIds.length;

  const {
    title,
    body,
    type = 'info',
    data = {},
  } = params;

  // ── 1. Insert DB en BATCH (1 seule requête, plus performant)
  try {
    const rows = userIds.map(uid => ({
      user_id: uid,
      title,
      body,
      type,
    }));
    const { error: dbErr } = await db.from('notifications').insert(rows);
    if (dbErr) {
      console.log('[notifyUsers] DB batch insert error:', dbErr.message);
    } else {
      result.db_ok = userIds.length;
    }
  } catch (e) {
    console.log('[notifyUsers] DB batch exception:', e.message);
  }

  // ── 2. Push notification (loop, non bloquant)
  // 🛡️ On envoie en parallèle (Promise.all) pour rapidité
  try {
    const pushResults = await Promise.all(
      userIds.map(uid => sendExpoPushInternal(uid, title, body, data))
    );
    result.push_ok = pushResults.filter(ok => ok === true).length;
  } catch (e) {
    console.log('[notifyUsers] Push batch exception:', e.message);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 📤 EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  notifyUser,
  notifyUsers,
};
