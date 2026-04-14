const logger = require('../config/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(`${err.message} — ${req.method} ${req.path}`);

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message, details: err.details });
  }
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Erreur interne du serveur',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { errorHandler, asyncHandler };
