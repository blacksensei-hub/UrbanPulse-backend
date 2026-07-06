import cron from 'node-cron';
import { runAbandonedCartJob } from './abandonedCart.js';
import { runLoyaltyExpireJob } from './loyaltyExpire.js';
import { logger } from '../utils/logger.js';

if (process.env.ENABLE_CART_RECOVERY === 'true') {
  cron.schedule('0 * * * *', async () => {
    try {
      await runAbandonedCartJob();
    } catch (err) {
      logger.error(err, 'abandonedCartJob failed');
    }
  });
  logger.info('Abandoned-cart recovery job scheduled (hourly)');
}

if (process.env.ENABLE_LOYALTY_EXPIRY === 'true') {
  cron.schedule('0 3 * * *', async () => {
    try {
      await runLoyaltyExpireJob();
    } catch (err) {
      logger.error(err, 'loyaltyExpireJob failed');
    }
  });
  logger.info('Loyalty points expiry job scheduled (daily @ 03:00)');
}
