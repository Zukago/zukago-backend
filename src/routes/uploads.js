const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { uploadListing, uploadDocument, deleteImage } = require('../config/cloudinary');

const router = express.Router();

// ─── POST /api/uploads/listing/:id — Photos d'une annonce ────────────────────
router.post('/listing/:id', authenticate,
  uploadListing.array('photos', 10),
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
