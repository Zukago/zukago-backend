const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Storage pour listings
// ✅ V10 : crop:'limit' (pas de rognage) + quality:'auto:good' + fetch_format:'auto' (WebP auto)
// - limit  : redimensionne SEULEMENT si l'image dépasse 1600x1200, sinon garde original. Jamais de rognage.
// - quality:'auto:good' : compression intelligente (~75-85% selon contenu), perte visuelle nulle
// - fetch_format:'auto' : Cloudinary sert WebP/AVIF au navigateur compatible = 30% plus léger
const listingStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'zukago/listings',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{
      width:        1600,
      height:       1200,
      crop:         'limit',          // ← ne rogne JAMAIS
      quality:      'auto:good',      // ← compression auto intelligente
      fetch_format: 'auto',           // ← WebP/AVIF auto selon device
    }],
  },
});

// Storage pour documents partenaires
const documentStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'zukago/documents',
    allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
    resource_type: 'auto',
  },
});

const uploadListing  = multer({ storage: listingStorage,  limits: { fileSize: 10 * 1024 * 1024 } });
const uploadDocument = multer({ storage: documentStorage, limits: { fileSize: 5  * 1024 * 1024 } });

const deleteImage = async (publicId) => {
  return await cloudinary.uploader.destroy(publicId);
};

module.exports = { cloudinary, uploadListing, uploadDocument, deleteImage };
