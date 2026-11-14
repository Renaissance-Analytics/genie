export interface PublishedUpdateRelease {
    readonly tag_name: string;
    readonly draft: boolean;
    readonly prerelease: boolean;
}

/** Candidates arrive newest first; the manifest stays paired with its release for download pinning. */
export async function selectPublishedUpdate<T extends { version: string }>(
    releases: readonly PublishedUpdateRelease[],
    allowPrerelease: boolean,
    readManifest: (release: PublishedUpdateRelease) => Promise<T | null>,
): Promise<{ release: PublishedUpdateRelease; manifest: T }> {
    for (const release of releases) {
        if (release.draft || (!allowPrerelease && release.prerelease)) continue;
        // Only definite absence permits fallback. Authentication, network and parse failures propagate.
        const manifest = await readManifest(release);
        if (manifest === null) continue;
        if (manifest.version !== release.tag_name.replace(/^v/, '')) throw new Error('The manifest version does not match its release.');
        return { release, manifest };
    }
    throw new Error('No published release with update metadata was found.');
}
