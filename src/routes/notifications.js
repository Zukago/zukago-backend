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

// ─── POST /api/notifications/register-token — Enregistrer token Expo ─────────
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

// ─── GET /api/notifications — Mes notifications ───────────────────────────────
// ✅ INCHANGÉ — garde la logique broadcast (target.eq.all)
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const { data: notifications } = await db.from('notifications')
    .select('*')
    .or(`user_id.eq.${req.user.id},target.eq.all,target.eq.${req.user.role}s`)
    .order('created_at', { ascending: false })
    .limit(50);

  const unread = notifications?.filter(n => !n.read).length || 0;
  res.json({ notifications: notifications || [], unread });
}));

// ─── PATCH /api/notifications/:id/read — Marquer comme lu ────────────────────
// ✅ INCHANGÉ
router.patch('/:id/read', authenticate, asyncHandler(async (req, res) => {
  await db.from('notifications').update({ read: true })
    .eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ message: 'Notification lue' });
}));

// ─── PATCH /api/notifications/read-all — Tout marquer comme lu ───────────────
// ✅ INCHANGÉ
router.patch('/read-all', authenticate, asyncHandler(async (req, res) => {
  await db.from('notifications').update({ read: true }).eq('user_id', req.user.id);
  res.json({ message: 'Toutes les notifications lues' });
}));

// Export helper pour les autres routes (bookings, reviews...)
router.sendPushToUser = async (userId, title, body, data = {}) => {
  try {
    const { data: row } = await db.from('push_tokens')
      .select('expo_push_token').eq('user_id', userId).single();
    if (row?.expo_push_token) await sendExpoPush([row.expo_push_token], title, body, data);
  } catch (e) {}
};

module.exports = router;
