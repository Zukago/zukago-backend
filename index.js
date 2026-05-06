require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { errorHandler } = require('./middleware/errorHandler');
const logger     = require('./config/logger');

const app = express();

// ✅ V12 : Railway met un proxy (Cloudflare) devant l'app — nécessaire pour rate-limit + uploads
app.set('trust proxy', 1);

// ─── MIDDLEWARE GLOBAL ────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ V14.4.3 ULTIME : WEBHOOK STRIPE — Body parsing CONDITIONNEL                ║
// ║                                                                            ║
// ║ Stripe signe le RAW body (Buffer brut) avec HMAC.                          ║
// ║ Si express.json() le modifie (réorganise clés, espaces), signature KO.     ║
// ║                                                                            ║
// ║ Solution : router le body parser selon l'URL                               ║
// ║   • /api/payments/stripe/webhook → express.raw (Buffer pur)                ║
// ║   • Toutes autres routes         → express.json (objet JS)                 ║
// ║                                                                            ║
// ║ + verify pour stocker rawBody en backup                                    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
app.use((req, res, next) => {
  // CRITIQUE : Stripe envoie POST /api/payments/stripe/webhook
  // On doit utiliser raw() qui garde le Buffer intact
  if (req.originalUrl === '/api/payments/stripe/webhook') {
    console.log('[BodyParser] → Webhook Stripe détecté, utilisation de express.raw()');
    return express.raw({ type: '*/*', limit: '50mb' })(req, res, next);
  }
  // Toutes les autres routes : JSON normal
  return express.json({ limit: '50mb' })(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting — V12 : augmenté pour usage normal app mobile (beaucoup de GET)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,                         // ✅ V12 : 1000 req / 15min (au lieu de 100)
  message: 'Trop de requêtes',
  standardHeaders: true,
  legacyHeaders: false,
  // ✅ V12 : skip les routes lourdes/fréquentes pour ne pas les compter
  skip: (req) => {
    return req.path === '/api/config/app' || req.path === '/api/auth/me';
  },
});
app.use('/api/', limiter);

// Logger requêtes
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/config',        require('./routes/config'));
app.use('/api/listings',      require('./routes/listings'));
app.use('/api/bookings',      require('./routes/bookings'));
app.use('/api/payments',      require('./routes/payments'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/partners',      require('./routes/partners'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/reviews',       require('./routes/reviews'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/uploads',       require('./routes/uploads'));
app.use('/api/places',        require('./routes/places'));
app.use('/api/carpool',       require('./routes/carpool'));   // ✅ V9 : covoiturage
app.use('/api/messages',      require('./routes/messages'));  // ✅ V14.3 : chat in-app

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', env: process.env.NODE_ENV });
});

// 404
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// Error handler
app.use(errorHandler);

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 ZUKAGO Backend démarré sur le port ${PORT}`);
  logger.info(`📦 Environnement : ${process.env.NODE_ENV}`);
});

module.exports = app;
