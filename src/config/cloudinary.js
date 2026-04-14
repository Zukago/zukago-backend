const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Storage pour listings
const listingStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'zukago/listings',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1200, height: 800, crop: 'fill', quality: 85 }],
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
