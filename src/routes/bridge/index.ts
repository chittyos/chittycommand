import { Hono } from 'hono';
import type { Env } from '../../index';
import type { AuthVariables } from '../../middleware/auth';
import { ledgerBridgeRoutes } from './ledger';
import { credentialRoutes } from './credentials';
import { financeRoutes } from './finance';
import { plaidRoutes } from './plaid';
import { mercuryRoutes } from './mercury';
import { booksRoutes } from './books';
import { assetsBridgeRoutes } from './assets';
import { scrapeRoutes } from './scrape';
import { statusRoutes } from './status';

export const bridgeRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

bridgeRoutes.route('/ledger', ledgerBridgeRoutes);
bridgeRoutes.route('/credentials', credentialRoutes);
bridgeRoutes.route('/finance', financeRoutes);
bridgeRoutes.route('/plaid', plaidRoutes);
bridgeRoutes.route('/mercury', mercuryRoutes);
bridgeRoutes.route('/books', booksRoutes);
bridgeRoutes.route('/assets', assetsBridgeRoutes);
bridgeRoutes.route('/scrape', scrapeRoutes);
bridgeRoutes.route('/', statusRoutes);
