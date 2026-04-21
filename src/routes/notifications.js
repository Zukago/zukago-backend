const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// ── Helper : envoyer push via Expo Push API (non bloquant)
async function sendExpoPush(tokens, title, body, data = {}) {
  if (!tokens?.length) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens.map(token => ({
        to: token, sound: 'default', title, body, data, priority: 'high',
      }))),
    });
  } catch (e) { console.log('Expo Push error:', e.message); }
}

// ─── POST /api/notifications/register-token ───────────────────────────────────
router.post('/register-token', authenticate, asyncHandler(async (req, res) => {
  const { expo_push_token, platform } = req.body;
  if (!expo_push_token) return res.status(400).json({ error: 'Token requis' });
  try {
    await db.from('push_tokens').upsert({
      user_id: req.user.id,
      expo_push_token,
      platform: platform || 'unknown',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
  } catch (e) { console.log('push_tokens upsert:', e.message); }
  res.json({ message: 'Token enregistré' });
}));

// ─── GET /api/notifications ───────────────────────────────────────────────────
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { data: notifications } = await db.from('notifications')
    .select('*')
    .or(`user_id.eq.${req.user.id},target.eq.all,target.eq.${req.user.role}s`)
    // Ne retourner QUE les non supprimées (colonne deleted, default false)
    .neq('deleted', true)
    .order('created_at', { ascending: false })
    .limit(50);

  const unread = notifications?.filter(n => !n.read).length || 0;
  res.json({ notifications: notifications || [], unread });
}));

// ─── PATCH /api/notifications/:id/read ───────────────────────────────────────
router.patch('/:id/read', authenticate, asyncHandler(async (req, res) => {
  await db.from('notifications').update({ read: true })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  res.json({ message: 'Notification lue' });
}));

// ─── PATCH /api/notifications/read-all ───────────────────────────────────────
router.patch('/read-all', authenticate, asyncHandler(async (req, res) => {
  await db.from('notifications').update({ read: true })
    .eq('user_id', req.user.id);
  res.json({ message: 'Toutes les notifications lues' });
}));

// ─── DELETE /api/notifications/:id — Supprimer une notification ───────────────
// Soft delete : on marque deleted=true plutôt que de supprimer la ligne
// (les notifications broadcast target=all ne peuvent pas être supprimées physiquement
//  car elles appartiennent à user_id=null — on les cache côté user)
router.delete('/:id', authenticate, asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Essayer d'abord un vrai delete (notifications personnelles)
  const { error: delErr } = await db.from('notifications')
    .delete()
    .eq('id', id)
    .eq('user_id', req.user.id);

  if (delErr) {
    // Fallback : soft-delete via colonne deleted (notifications broadcast)
    // On insère une ligne dans user_notification_hidden si elle existe,
    // sinon on update directement
    try {
      await db.from('notifications')
        .update({ deleted: true })
        .eq('id', id);
    } catch (e) {
      console.log('soft delete fallback:', e.message);
    }
  }

  res.json({ message: 'Notification supprimée' });
}));

// ─── DELETE /api/notifications — Supprimer toutes les notifications ───────────
router.delete('/', authenticate, asyncHandler(async (req, res) => {
  // Supprimer les notifications personnelles
  await db.from('notifications')
    .delete()
    .eq('user_id', req.user.id);

  res.json({ message: 'Toutes les notifications supprimées' });
}));

// Export helper
router.sendPushToUser = async (userId, title, body, data = {}) => {
  try {
    const { data: row } = await db.from('push_tokens')
      .select('expo_push_token').eq('user_id', userId).single();
    if (row?.expo_push_token) await sendExpoPush([row.expo_push_token], title, body, data);
  } catch (e) {}
};

module.exports = router;
