import cron from 'node-cron';
import { runAbandonedCartJob } from './abandonedCart.js';
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
