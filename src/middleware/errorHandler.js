import { logger } from '../utils/logger.js';
import { HttpError } from '../utils/helpers.js';

export const GENERIC_ERROR = 'Something went wrong on our side. Please try again.';

// An error raised on purpose carries a message meant for whoever sees it: an
// HttpError, one given a status (featureDisabled's 503, body-parser's 400s),
// or an upload rejected by multer ("File too large"). Anything else is a crash
// whose message (a database error, a TypeError) is logged, not sent.
function isDeliberate(err) {
  return err instanceof HttpError
    || err.name === 'MulterError'
    || (Number.isInteger(err.status) && err.expose !== false);
}

// Validation details say which field to fix and why, never what was typed.
// express-validator puts the submitted value on each entry, so a short
// password would otherwise come back in the reply, where proxies, error
// trackers and logs may keep it.
function publicDetails(details) {
  if (!Array.isArray(details)) return details;
  return details.map((d) => ({ path: d?.path, msg: d?.msg }));
}

export function errorHandler(err, _req, res, _next) {
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  if (status >= 500) {
    logger.error(err.message || 'Server error', { stack: err.stack });
  }
  if (!isDeliberate(err)) return res.status(status).json({ error: GENERIC_ERROR });
  res.status(status).json({
    error: err.message || 'Server error',
    ...(err.details ? { details: publicDetails(err.details) } : {}),
  });
}
