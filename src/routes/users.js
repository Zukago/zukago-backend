const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// ─── GET /api/users/me ────────────────────────────────────────────────────────
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { data: user } = await db.from('users')
    .select('id, name, email, role, avatar, phone, whatsapp, verified, created_at')
    .eq('id', req.user.id).single();
  res.json({ user });
}));

// ─── PATCH /api/users/me — Modifier profil ────────────────────────────────────
router.patch('/me', authenticate, asyncHandler(async (req, res) => {
  const { name, phone, whatsapp, avatar } = req.body;
  const { data: user } = await db.from('users')
    .update({ name, phone, whatsapp, avatar, updated_at: new Date() })
    .eq('id', req.user.id)
    .select('id, name, email, role, avatar, phone, whatsapp').single();
  res.json({ user });
}));

module.exports = router;
