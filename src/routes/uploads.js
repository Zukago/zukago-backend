const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { uploadListing, uploadDocument, deleteImage } = require('../config/cloudinary');

const router = express.Router();

// Types MIME autorisés pour les photos
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Middleware validation photos
const validatePhotos = (req, res, next) => {
  if (!req.files?.length) return next();
  for (const file of req.files) {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return res.status(400).json({ error: `Type de fichier non autorise: ${file.mimetype}. Utilisez JPG, PNG ou WebP.` });
    }
    if (file.size > MAX_FILE_SIZE) {
      return res.status(400).json({ error: `Fichier trop volumineux (max 10MB): ${file.originalname}` });
    }
  }
  next();
};

// ─── POST /api/uploads/listing/:id — Photos d'une annonce ────────────────────
router.post('/listing/:id', authenticate,
  uploadListing.array('photos', 10),
  validatePhotos,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!req.files?.length) return res.status(400).json({ error: 'Aucune photo envoyée' });

    const photos = req.files.map((file, index) => ({
      listing_id: id,
      url:        file.path,
      public_id:  file.filename,
      is_main:    index === 0,
      sort_order: index,
    }));

    const { data: savedPhotos, error } = await db.from('listing_photos').insert(photos).select();
    if (error) throw new Error(error.message);

    res.status(201).json({ photos: savedPhotos, message: `${savedPhotos.length} photo(s) uploadée(s)` });
  })
);

// ─── DELETE /api/uploads/photo/:id — Supprimer une photo ─────────────────────
router.delete('/photo/:id', authenticate, asyncHandler(async (req, res) => {
  const { data: photo } = await db.from('listing_photos').select('public_id').eq('id', req.params.id).single();
  if (!photo) return res.status(404).json({ error: 'Photo introuvable' });

  await deleteImage(photo.public_id);
  await db.from('listing_photos').delete().eq('id', req.params.id);
  res.json({ message: 'Photo supprimée' });
}));

// ─── POST /api/uploads/room-type/:id — Photos d'un type de chambre (V11 Sprint B) ───
router.post('/room-type/:id', authenticate,
  uploadListing.array('photos', 5),
  validatePhotos,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!req.files?.length) return res.status(400).json({ error: 'Aucune photo envoyée' });

    // Récupérer les URLs
    const newUrls = req.files.map(file => file.path);

    // Fusionner avec les photos existantes
    const { data: existing } = await db.from('listing_room_types')
      .select('photos').eq('id', id).single();
    const merged = [...(existing?.photos || []), ...newUrls];

    const { data: updated, error } = await db.from('listing_room_types')
      .update({ photos: merged, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select().single();
    if (error) throw new Error(error.message);

    res.status(201).json({ room_type: updated, photos: newUrls, message: `${newUrls.length} photo(s) uploadée(s)` });
  })
);

// ─── POST /api/uploads/document — Document partenaire ────────────────────────
router.post('/document', authenticate,
  uploadDocument.single('document'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier envoyé' });

    await db.from('partners')
      .update({ id_document: req.file.path })
      .eq('user_id', req.user.id);

    res.json({ url: req.file.path, message: 'Document uploadé' });
  })
);

module.exports = router;
