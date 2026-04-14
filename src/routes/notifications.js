const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// ─── GET /api/notifications — Mes notifications ───────────────────────────────
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
router.patch('/:id/read', authenticate, asyncHandler(async (req, res) => {
  await db.from('notifications').update({ read: true })
    .eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ message: 'Notification lue' });
}));

// ─── PATCH /api/notifications/read-all — Tout marquer comme lu ───────────────
router.patch('/read-all', authenticate, asyncHandler(async (req, res) => {
  await db.from('notifications').update({ read: true }).eq('user_id', req.user.id);
  res.json({ message: 'Toutes les notifications lues' });
}));

module.exports = router;
