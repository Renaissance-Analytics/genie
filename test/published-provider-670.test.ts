import type { RequestOptions } from 'node:http';
import { HttpError, type GithubOptions } from 'builder-util-runtime';
import type { AppUpdater } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js';
import { describe, expect, it, vi } from 'vitest';
import { PublishedGitHubProvider } from '../src/main/published-github-provider.js';
import { configurePublishedFeed } from '../src/main/published-feed.js';

// The real installed provider and resolveFiles run against an injected executor: no network, Electron app or installer.
const OWNER = 'synthetic-owner'; const REPO = 'synthetic-app';
const OPTIONS: GithubOptions = { provider: 'github', owner: OWNER, repo: REPO };
const NEW = '2.0.0-beta.62.1'; const OLD = '2.0.0-beta.62';
const CHECKSUM = Buffer.alloc(64, 1).toString('base64');
const downloadPath = (version: string) => `/${OWNER}/${REPO}/releases/download/v${version}/synthetic-installer.exe`;
const candidate = (version: string, draft = false) => ({ tag_name: `v${version}`, draft, prerelease: version.includes('-') });
type Candidate = ReturnType<typeof candidate>;
function rig(entries: Candidate[], manifests: Record<string, string>, allowPrerelease = true, manifestError?: Error) {
    const requests: URL[] = [];
    const apiEntries = entries.map((entry) => ({ ...entry, assets: manifests[entry.tag_name.slice(1)] ? [{
        name: 'latest.yml', url: `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/1`,
        browser_download_url: `https://github.com/${OWNER}/${REPO}/releases/download/${entry.tag_name}/latest.yml`,
    }] : [] }));
    const executor = {
        request: async (options: RequestOptions) => {
            const url = new URL(`${options.protocol ?? 'https:'}//${options.hostname}${options.path}`); requests.push(url);
            if (url.hostname === 'api.github.com' && url.pathname === `/repos/${OWNER}/${REPO}/releases`) return JSON.stringify(apiEntries);
            if (url.pathname.endsWith('/releases.atom')) return `<feed xmlns="http://www.w3.org/2005/Atom">${entries.map((entry) => `<entry><title>${entry.tag_name}</title><link href="https://github.com/${OWNER}/${REPO}/releases/tag/${entry.tag_name}"/><content>synthetic notes</content></entry>`).join('')}</feed>`;
            if (url.pathname.endsWith('/releases/latest')) return JSON.stringify(entries.find((entry) => !entry.draft && !entry.prerelease));
            const match = /\/releases\/download\/v([^/]+)\/(?:beta|latest)\.yml$/.exec(url.pathname);
            if (match) {
                if (manifestError) throw manifestError;
                const version = manifests[match[1]!];
                if (!version) throw new HttpError(404, 'Synthetic manifest absent.');
                return `version: ${version}\nfiles:\n  - url: synthetic-installer.exe\n    sha512: ${CHECKSUM}\npath: synthetic-installer.exe\nsha512: ${CHECKSUM}\n`;
            }
            throw new Error(`Unexpected synthetic provider request: ${url.pathname}`);
        },
    };
    // Only stock GitHubProvider's read-only updater fields are needed; semver.prerelease accepts this version string.
    const updater = { currentVersion: '2.0.0-beta.61.2', allowPrerelease, channel: null, fullChangelog: false } as unknown as AppUpdater;
    const provider = new PublishedGitHubProvider(OPTIONS, updater, { executor, platform: 'win32', isUseMultipleRangeRequest: false } as unknown as ProviderRuntimeOptions);
    return { provider, requests };
}
const hasReleaseList = (requests: URL[]) => requests.some((url) => url.hostname === 'api.github.com' && url.pathname === `/repos/${OWNER}/${REPO}/releases`);

describe('published GitHub provider selection and download resolution (#670)', () => {
    it('orders candidates by version instead of publication order and still offers beta releases', async () => {
        const w = rig([candidate(OLD), candidate(NEW)], { [OLD]: OLD, [NEW]: NEW });
        const info = await w.provider.getLatestVersion();
        expect(info).toMatchObject({ version: NEW, tag: `v${NEW}` });
        expect(hasReleaseList(w.requests)).toBe(true);
    });

    it('uses publication state to skip a newer draft without probing its uploaded manifest', async () => {
        const w = rig([candidate(NEW, true), candidate(OLD)], { [NEW]: NEW, [OLD]: OLD });
        expect(await w.provider.getLatestVersion()).toMatchObject({ version: OLD, tag: `v${OLD}` });
        expect(w.requests.some((url) => url.pathname.includes(`/download/v${NEW}/`))).toBe(false);
        expect(hasReleaseList(w.requests)).toBe(true);
    });

    it('a missing newest manifest selects the previous published release and pins its resolved download URL', async () => {
        const w = rig([candidate(NEW), candidate(OLD)], { [OLD]: OLD });
        const check = w.provider.getLatestVersion();
        await expect(check).resolves.toMatchObject({ version: OLD, tag: `v${OLD}` });
        const info = await check;
        const files = w.provider.resolveFiles(info);
        expect(files).toHaveLength(1);
        expect(files[0]!.url.href).toBe(`https://github.com${downloadPath(OLD)}`);
        expect(files[0]!.info.sha512).toBe(CHECKSUM);
    });

    it('CONTROL: a normal published beta uses the library resolver with its original checksum and tag', async () => {
        const w = rig([candidate(OLD)], { [OLD]: OLD }); const info = await w.provider.getLatestVersion();
        expect(info).toMatchObject({ version: OLD, tag: `v${OLD}` });
        const files = w.provider.resolveFiles(info);
        expect(files[0]!.url.href).toBe(`https://github.com${downloadPath(OLD)}`);
        expect(files[0]!.info.sha512).toBe(CHECKSUM);
    });

    it('CONTROL: stable never requests a prerelease manifest', async () => {
        const w = rig([candidate(NEW), candidate('1.9.0')], { [NEW]: NEW, '1.9.0': '1.9.0' }, false);
        expect(await w.provider.getLatestVersion()).toMatchObject({ version: '1.9.0', tag: 'v1.9.0' });
        expect(w.requests.some((url) => url.pathname.includes(`/download/v${NEW}/`))).toBe(false);
    });

    it('CONTROL: authorization failure stays an error and never probes an older release', async () => {
        const denied = new HttpError(403, 'Synthetic access denied.');
        const w = rig([candidate(NEW), candidate(OLD)], { [NEW]: NEW, [OLD]: OLD }, true, denied);
        await expect(w.provider.getLatestVersion()).rejects.toBe(denied);
        expect(w.requests.some((url) => url.pathname.includes(`/download/v${OLD}/`))).toBe(false);
    });
});

describe('published feed configuration adapter (#670)', () => {
    it('installs our provider through the public custom-provider API, retaining the configured release source', () => {
        const setFeedURL = vi.fn();
        const config: GithubOptions = { ...OPTIONS, updaterCacheDirName: 'synthetic-cache', publisherName: ['Synthetic publisher'] };
        expect(configurePublishedFeed({ setFeedURL }, config)).toBe(true);
        expect(setFeedURL).toHaveBeenCalledExactlyOnceWith({ ...config, provider: 'custom', updateProvider: PublishedGitHubProvider });
    });

    it('CONTROL: a generic VM feed is kept exactly, with no custom-provider override', () => {
        const setFeedURL = vi.fn(); const config = { provider: 'generic' as const, url: 'http://127.0.0.1:12345/synthetic/' };
        expect(configurePublishedFeed({ setFeedURL }, config)).toBe(false);
        expect(setFeedURL).not.toHaveBeenCalled();
        expect(config.url).toBe('http://127.0.0.1:12345/synthetic/');
    });

    it('CONTROL: a string-form generic feed is not replaced', () => {
        const setFeedURL = vi.fn();
        expect(configurePublishedFeed({ setFeedURL }, 'http://127.0.0.1:12345/synthetic/')).toBe(false);
        expect(setFeedURL).not.toHaveBeenCalled();
    });

    it('CONTROL: absent configuration performs no feed rewrite', () => {
        const setFeedURL = vi.fn(); expect(configurePublishedFeed({ setFeedURL }, null)).toBe(false);
        expect(setFeedURL).not.toHaveBeenCalled();
    });
});
