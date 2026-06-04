/**
 * Executor registry barrel — importing this module guarantees all canonical
 * executors have self-registered.
 *
 * Add new executors here so the registry is populated on first import.
 *
 * @canonical-uri chittycanon://docs/architecture/chittycommand/ADR-001
 */

export * from './types';
export * from './registry';
export { dispatch } from './dispatch';

// Side-effect imports: each executor file calls registerExecutor() at top level.
import './update-obligation-status';
import './mercury-payment';
