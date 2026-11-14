import type { AllPublishOptions } from 'builder-util-runtime';
import type { AppUpdater } from 'electron-updater';
import { PublishedGitHubProvider } from './published-github-provider.js';

/** Replace only the public GitHub feed; generic and authenticated provider configuration stays with the library. */
export function configurePublishedFeed(updater: Pick<AppUpdater, 'setFeedURL'>, config: AllPublishOptions | null): boolean {
    if (!config || typeof config === 'string' || config.provider !== 'github' || config.private || config.token) return false;
    updater.setFeedURL({ ...config, provider: 'custom', updateProvider: PublishedGitHubProvider });
    return true;
}
