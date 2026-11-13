export interface PublishedUpdateRelease {
    readonly tag_name: string;
    readonly draft: boolean;
    readonly prerelease: boolean;
}

/** Candidates arrive newest first; the manifest stays paired with its release for download pinning. */
export async function selectPublishedUpdate<T extends { version: string }>(
    releases: readonly PublishedUpdateRelease[],
    _allowPrerelease: boolean,
    readManifest: (release: PublishedUpdateRelease) => Promise<T | null>,
): Promise<{ release: PublishedUpdateRelease; manifest: T }> {
    // Tests-first seam: deliberately try only the first candidate until assertion RED is measured.
    const release = releases[0];
    if (!release) throw new Error('No published release with update metadata was found.');
    const manifest = await readManifest(release);
    if (!manifest) throw new Error('No published release with update metadata was found.');
    return { release, manifest };
}
