/**
 * `@genie/app-sdk` — build a Genie App.
 *
 * Start here:
 *
 *   import { useGenie } from '@genie/app-sdk';
 *
 *   const genie = useGenie();
 *   if (await genie.can('hosting')) {
 *       const sites = await genie.call('manageSite', { action: 'list' });
 *   }
 *
 * See README.md for the whole shape of an app — the manifest, the capabilities,
 * and how to build one that a user will actually say yes to.
 */

export { createGenieClient, useGenie, isInsideGenie, GenieCallError, NotInsideGenieError } from './client';
export type { GenieClient, GenieClientOptions } from './client';
export type {
    GenieAppManifest,
    GenieAppCapability,
    GenieAppScope,
    GenieAppServe,
    GenieAppIdentity,
    GenieAppHost,
    GenieAppCallResult,
} from './types';
