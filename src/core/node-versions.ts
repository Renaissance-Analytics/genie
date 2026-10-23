import { join } from 'node:path';
import { compareVersionsDesc } from './php-versions.js';

/**
 * GENIE'S OWN NODE — the pure half (the owner, 2026-10-23: "we better not be using herds node. genie has its own install
 * path"; "build both, Node 24 LTS default").
 *
 * Genie 1 kept its Node in its own toolchain folder (`%APPDATA%\genie\toolchain\node\<version>`, with `npm-global`
 * beside it), so the Node its agents ran was not one another app could swap underneath them. Genie 2 had only the
 * machine-wide winget install — on the owner's machine that resolved to `C:\Program Files\nodejs`, Herd's link to a
 * folder holding a v24 node.exe next to v22's npm, which crashed on load. Genie 2 now manages Node the way it manages PHP
 * (core/php-versions.ts): the official nodejs.org zip, checked against the `SHASUMS256.txt` nodejs.org publishes in the
 * same directory, one directory per version, and a static pick-list (Genie 1's reason: a box that accepts any string
 * mostly produces failed downloads). Windows only for now, as the PHP manager is: elsewhere the system Node is listed.
 */

export interface NodeRecipe {
    /** The exact version this release of Genie installs. */
    readonly version: string;
}

/**
 * The default: the current Node 24 LTS ("Krypton"), v24.22.1 with npm 11.19.1, released 2026-10-20 — read off
 * nodejs.org/dist/index.json on 2026-10-23.
 */
export const NODE_LTS_DEFAULT = '24.22.1';

/** What this release installs, newest first. */
export const NODE_RECIPES: readonly NodeRecipe[] = [{ version: NODE_LTS_DEFAULT }];

const FULL_VERSION = /^\d+\.\d+\.\d+$/;

export function nodeZipName(version: string): string {
    return `node-v${version}-win-x64.zip`;
}

/** The zip and the checksums nodejs.org publishes beside it — the hash is read from the same directory the zip came from. */
export function nodeDownloadSources(version: string): { zipUrl: string; sumsUrl: string } {
    const base = `https://nodejs.org/dist/v${version}/`;
    return { zipUrl: `${base}${nodeZipName(version)}`, sumsUrl: `${base}SHASUMS256.txt` };
}

/**
 * Where `npm install -g` puts things for Genie's Node: one folder beside the versions, shared by them all (Genie 1's
 * `toolchain\npm-global`), so a global installed under one version survives moving to the next.
 */
export function nodeNpmGlobalDir(root: string): string {
    return join(root, 'npm-global');
}

export interface ManagedNode {
    readonly version: string;
    /** `<root>/<version>` — the directory Genie owns and Remove deletes. */
    readonly dir: string;
}

/**
 * The versions Genie manages, from its directory's entries: a full version name whose node.exe is THERE. Anything else —
 * the staging directory of an install in flight, `npm-global`, a person's note — is not an install. Newest first.
 */
export function managedNodeVersions(entries: readonly string[], nodeExists: (version: string) => boolean, dirOf: (version: string) => string): ManagedNode[] {
    return entries
        .filter((e) => FULL_VERSION.test(e) && nodeExists(e))
        .sort(compareVersionsDesc)
        .map((version) => ({ version, dir: dirOf(version) }));
}

/** What `node -v` says (`v24.22.1`) as a bare version, or `null` when it is not that. */
export function parseNodeVersion(output: string): string | null {
    const m = /^v(\d+\.\d+\.\d+)\s*$/.exec(output.trim());
    return m ? m[1]! : null;
}
