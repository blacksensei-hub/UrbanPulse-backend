import { logger } from '../utils/logger.js';

export function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    logger.error(err.message || 'Server error', { stack: err.stack });
  }
  res.status(status).json({
    error: err.message || 'Server error',
    ...(err.details ? { details: err.details } : {}),
  });
}
