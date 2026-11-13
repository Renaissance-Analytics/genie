import type { CustomPublishOptions, GithubOptions, UpdateInfo } from 'builder-util-runtime';
import type { AppUpdater } from 'electron-updater';
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js';
import { parseUpdateInfo, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js';
import { compareGenieVersions } from '../core/update-notes.js';
import { selectPublishedUpdate, type PublishedUpdateRelease } from './published-update.js';

/** Published metadata chooses the tag; the inherited resolver and stock updater still own downloads/verification. */
export class PublishedGitHubProvider extends GitHubProvider {
    constructor(options: GithubOptions | CustomPublishOptions, private readonly releaseUpdater: AppUpdater, runtime: ProviderRuntimeOptions) {
        super({ ...options, provider: 'github' }, releaseUpdater, runtime);
    }

    override async getLatestVersion(): Promise<UpdateInfo & { tag: string }> {
        const releases = await this.publishedCandidates();
        releases.sort((a, b) => compareGenieVersions(b.tag_name.split('+')[0]!, a.tag_name.split('+')[0]!));
        const selected = await selectPublishedUpdate(releases, this.releaseUpdater.allowPrerelease, (release) => this.manifestFor(release));
        // The manifest cannot override the selected tag used by GitHubProvider.resolveFiles.
        return { ...selected.manifest, tag: selected.release.tag_name };
    }

    private async publishedCandidates(): Promise<PublishedUpdateRelease[]> {
        const { owner, repo } = this.options;
        if (!owner || !repo) throw new Error('The GitHub update source is incomplete.');
        const path = this.computeGithubBasePath(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`);
        const releases: PublishedUpdateRelease[] = [];
        // Publication order is not version order. Read bounded pages before selecting by version.
        for (let page = 1; page <= 10; page += 1) {
            const raw = await this.httpRequest(new URL(`${path}?per_page=100&page=${page}`, this.baseApiUrl), { Accept: 'application/vnd.github+json' });
            const entries: unknown = JSON.parse(raw ?? 'null');
            if (!Array.isArray(entries)) throw new Error('GitHub returned an invalid update release list.');
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object' || typeof entry.tag_name !== 'string' || typeof entry.draft !== 'boolean' || typeof entry.prerelease !== 'boolean') throw new Error('GitHub returned invalid update release metadata.');
                // Only version tags can be updater candidates; also excludes path separators in the download tag.
                if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.tag_name)) continue;
                releases.push({ tag_name: entry.tag_name, draft: entry.draft, prerelease: entry.prerelease || entry.tag_name.includes('-') });
            }
            if (entries.length < 100) return releases;
        }
        throw new Error('The update release list exceeded its limit. Try checking again later.');
    }

    private async manifestFor(release: PublishedUpdateRelease): Promise<UpdateInfo | null> {
        const version = release.tag_name.replace(/^v/, '');
        const prereleaseChannel = version.split('-', 2)[1]?.split('.')[0];
        const channel = this.releaseUpdater.channel || this.options.channel || (this.releaseUpdater.allowPrerelease ? prereleaseChannel : null);
        const names = new Set([...(channel ? [this.getCustomChannelName(String(channel))] : []), this.getDefaultChannelName()]);
        for (const name of names) {
            const file = `${name}.yml`;
            const url = new URL(`/${encodeURIComponent(this.options.owner!)}/${encodeURIComponent(this.options.repo!)}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(file)}`, this.baseUrl);
            let raw: string | null;
            try { raw = await this.httpRequest(url); }
            catch (error) {
                // Only a missing manifest permits another channel/release. All other failures stay visible.
                if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404) continue;
                throw error;
            }
            const info = parseUpdateInfo(raw, file, url);
            if (!info || typeof info.version !== 'string') throw new Error('The update manifest has no valid version.');
            return info;
        }
        return null;
    }
}
