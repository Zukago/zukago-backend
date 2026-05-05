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
// ║ V14.4.1 : WEBHOOK STRIPE — Préserver le RAW body pour la signature.        ║
// ║ Stripe a besoin du Buffer brut pour vérifier la signature HMAC.            ║
// ║ Solution : appliquer express.raw() UNIQUEMENT sur la route webhook,        ║
// ║ et express.json() sur toutes les AUTRES routes.                            ║
// ║ → C'est pour ça que les emails ne partaient pas après paiement Stripe !    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payments/stripe/webhook') {
    // Pour le webhook : raw body (Buffer)
    express.raw({ type: 'application/json', limit: '50mb' })(req, res, next);
  } else {
    // Pour toutes les autres routes : JSON parsé
    express.json({ limit: '50mb' })(req, res, next);
  }
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
