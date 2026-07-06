import { expirePoints } from '../utils/loyalty.js';
import { logger } from '../utils/logger.js';

export async function runLoyaltyExpireJob() {
  const result = await expirePoints();
  logger.info(result, 'loyaltyExpireJob: complete');
  return result;
}
