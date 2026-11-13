import type { CustomPublishOptions, GithubOptions } from 'builder-util-runtime';
import type { AppUpdater } from 'electron-updater';
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js';

/** Tests-first: inherit the installed provider's selection until the new executor assertions are measured RED. */
export class PublishedGitHubProvider extends GitHubProvider {
    constructor(options: GithubOptions | CustomPublishOptions, updater: AppUpdater, runtime: ProviderRuntimeOptions) {
        super({ ...options, provider: 'github' }, updater, runtime);
    }
}
