const express = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { uploadListing, uploadDocument, uploadAvatar, deleteImage } = require('../config/cloudinary');
const i18n = require('../services/i18nService');

const router = express.Router();

// ✅ V14.5.3 i18n : helper langue (toutes routes authentifiées ici)
async function _resolveLang(req) {
  if (req.user?.id) {
    try { return await i18n.getUserLang(req.user.id); } catch (e) {}
  }
  const accept = req.headers['accept-language'] || '';
  const code = accept.split(',')[0]?.slice(0, 2).toLowerCase();
  if (['fr', 'en', 'de'].includes(code)) return code;
  return 'fr';
}

// Types MIME autorisés pour les photos
const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/heic', 'image/heif',
  'application/octet-stream', // ✅ V12 : iOS envoie parfois ce mimetype pour les photos
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Middleware validation photos
const validatePhotos = async (req, res, next) => {
  if (!req.files?.length) return next();
  try {
    // ✅ V14.5.3 i18n : résoudre la langue (middleware appelé après authenticate)
    const L = await _resolveLang(req);
    for (const file of req.files) {
      // ✅ V12 : tolérance — si octet-stream, vérifier l'extension
      if (file.mimetype === 'application/octet-stream') {
        const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
        if (!['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext)) {
          return res.status(400).json({ error: await i18n.t('uploads_error_invalid_type_file', L, 'Type de fichier non autorise: {file}', { file: file.originalname }) });
        }
      } else if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        return res.status(400).json({ error: await i18n.t('uploads_error_invalid_mimetype', L, 'Type de fichier non autorise: {mime}. Utilisez JPG, PNG ou WebP.', { mime: file.mimetype }) });
      }
      if (file.size > MAX_FILE_SIZE) {
        return res.status(400).json({ error: await i18n.t('uploads_error_file_too_large', L, 'Fichier trop volumineux (max 10MB): {file}', { file: file.originalname }) });
      }
    }
    next();
  } catch (e) {
    // Safety net : si i18n.t throw, on continue avec le fallback FR pour éviter de hang la requête
    console.log('[validatePhotos] i18n error:', e.message);
    next();
  }
};

// ─── POST /api/uploads/listing/:id — Photos d'une annonce ────────────────────
router.post('/listing/:id', authenticate,
  uploadListing.array('photos', 15),
  validatePhotos,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const L = await _resolveLang(req);
    if (!req.files?.length) return res.status(400).json({ error: await i18n.t('uploads_error_no_photo', L, 'Aucune photo envoyée') });

    const photos = req.files.map((file, index) => ({
      listing_id: id,
      url:        file.path,
      public_id:  file.filename,
      is_main:    index === 0,
      sort_order: index,
    }));

    const { data: savedPhotos, error } = await db.from('listing_photos').insert(photos).select();
    if (error) throw new Error(error.message);

    res.status(201).json({ photos: savedPhotos, message: await i18n.t('uploads_photos_uploaded', L, '{count} photo(s) uploadée(s)', { count: savedPhotos.length }) });
  })
);

// ─── DELETE /api/uploads/photo/:id — Supprimer une photo ─────────────────────
router.delete('/photo/:id', authenticate, asyncHandler(async (req, res) => {
  const L = await _resolveLang(req);
  const { data: photo } = await db.from('listing_photos').select('public_id').eq('id', req.params.id).single();
  if (!photo) return res.status(404).json({ error: await i18n.t('uploads_error_photo_not_found', L, 'Photo introuvable') });

  await deleteImage(photo.public_id);
  await db.from('listing_photos').delete().eq('id', req.params.id);
  res.json({ message: await i18n.t('uploads_photo_deleted', L, 'Photo supprimée') });
}));

// ─── POST /api/uploads/room-type/:id — Photos d'un type de chambre (V11 Sprint B) ───
router.post('/room-type/:id', authenticate,
  uploadListing.array('photos', 15),
  validatePhotos,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const L = await _resolveLang(req);
    console.log(`[upload room-type] id=${id} files=${req.files?.length || 0}`);
    if (!req.files?.length) return res.status(400).json({ error: await i18n.t('uploads_error_no_photo', L, 'Aucune photo envoyée') });

    // Récupérer les URLs Cloudinary
    const newUrls = req.files.map(file => file.path);
    console.log(`[upload room-type] ${id} new URLs:`, newUrls);

    // Fusionner avec les photos existantes
    const { data: existing, error: selectErr } = await db.from('listing_room_types')
      .select('photos').eq('id', id).single();
    if (selectErr) {
      console.error(`[upload room-type] select error:`, selectErr);
      return res.status(404).json({ error: await i18n.t('uploads_error_room_type_not_found', L, 'Type de chambre introuvable') });
    }
    const merged = [...(existing?.photos || []), ...newUrls];

    const { data: updated, error } = await db.from('listing_room_types')
      .update({ photos: merged, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select().single();
    if (error) {
      console.error(`[upload room-type] update error:`, error);
      throw new Error(error.message);
    }

    console.log(`[upload room-type] ${id} success, total photos:`, merged.length);
    res.status(201).json({ room_type: updated, photos: newUrls, message: await i18n.t('uploads_photos_uploaded', L, '{count} photo(s) uploadée(s)', { count: newUrls.length }) });
  })
);

// ─── POST /api/uploads/document — Document partenaire ────────────────────────
router.post('/document', authenticate,
  uploadDocument.single('document'),
  asyncHandler(async (req, res) => {
    const L = await _resolveLang(req);
    if (!req.file) return res.status(400).json({ error: await i18n.t('uploads_error_no_file', L, 'Aucun fichier envoyé') });

    await db.from('partners')
      .update({ id_document: req.file.path })
      .eq('user_id', req.user.id);

    res.json({ url: req.file.path, message: await i18n.t('uploads_document_uploaded', L, 'Document uploadé') });
  })
);

// ─── POST /api/uploads/partner-doc — V12 KYC : upload document spécifique ────
// Accepte un type ('cni_recto' | 'cni_verso' | 'selfie' | 'license_recto' | 'license_verso')
// → uploade vers Cloudinary
// → retourne l'URL (le frontend l'envoie ensuite avec /partners/request ou /partners/license)
// ⚠️ Ne touche PAS à la DB ici (la ligne partners n'existe pas forcément encore)
router.post('/partner-doc', authenticate,
  uploadDocument.single('document'),
  asyncHandler(async (req, res) => {
    const L = await _resolveLang(req);
    if (!req.file) return res.status(400).json({ error: await i18n.t('uploads_error_no_file', L, 'Aucun fichier envoyé') });

    const validTypes = ['cni_recto', 'cni_verso', 'selfie', 'license_recto', 'license_verso'];
    const docType = req.body.type;

    if (!docType || !validTypes.includes(docType)) {
      return res.status(400).json({ error: await i18n.t('uploads_error_invalid_doc_type', L, 'Type invalide. Valeurs acceptées : {types}', { types: validTypes.join(', ') }) });
    }

    console.log(`[partner-doc] user=${req.user.id} type=${docType} url=${req.file.path}`);

    res.json({
      url:  req.file.path,
      type: docType,
      message: await i18n.t('uploads_document_uploaded', L, 'Document uploadé'),
    });
  })
);

// ─── V14.5 : POST /api/uploads/avatar — Photo de profil utilisateur ──────────
// Upload vers Cloudinary (folder /avatars, crop carré 400x400 face-detected)
// PAS d'écriture en DB — le frontend reçoit l'URL et appelle PATCH /users/me ensuite
router.post('/avatar', authenticate,
  uploadAvatar.single('avatar'),
  asyncHandler(async (req, res) => {
    const L = await _resolveLang(req);
    if (!req.file) return res.status(400).json({ error: await i18n.t('uploads_error_no_photo', L, 'Aucune photo envoyée') });

    console.log(`[avatar] user=${req.user.id} url=${req.file.path}`);

    res.json({
      url:     req.file.path,
      message: await i18n.t('uploads_avatar_uploaded', L, 'Photo de profil uploadée'),
    });
  })
);

module.exports = router;
