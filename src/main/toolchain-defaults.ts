import { mkdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_LANGS, LANG_LABEL, currentLinkDir, langManagedOn, langManagedWhere, langPathEntries, versionDir, type DefaultLang, type DefaultsPlatform } from '../core/toolchain-defaults.js';
import { pathWithFirst } from '../core/toolchain-repair.js';
import type { EnvPort } from './toolchain-ops.js';

/**
 * EACH LANGUAGE'S DEFAULT — choose, read, apply (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC3a; the pure half is
 * core/toolchain-defaults.ts). The truth is the LINK on disk: `listDefaults` reads where each `current/<lang>` points,
 * so what Settings shows cannot disagree with what a terminal runs.
 */

/** The filesystem the links need — every effect injected, so the tests drive it with fakes that count. */
export interface LinkFs {
    exists(path: string): boolean;
    /** Where a link points, or `null` when `path` is not a link. */
    readLink(path: string): string | null;
    /** Make `path` a link to the directory `target` (a junction on Windows: no admin needed, and CreateProcess follows it). */
    link(target: string, path: string): void;
    /** Remove the link itself — never what it points at. */
    unlink(path: string): void;
    mkdirp(dir: string): void;
}

export interface DefaultsPorts {
    readonly platform: DefaultsPlatform;
    /** Genie 2's toolchain directory (`genie2-toolchain`). */
    readonly toolchainDir: string;
    readonly fs: LinkFs;
    /** The versions Genie manages of a language (from its manager), newest first. */
    readonly managed: (lang: DefaultLang) => readonly string[];
}

export type DefaultOutcome =
    | { readonly kind: 'set'; readonly lang: DefaultLang; readonly version: string }
    | { readonly kind: 'cleared'; readonly lang: DefaultLang }
    | { readonly kind: 'refused'; readonly reason: string };

/** The version each language's link points at, or `null` (no default: the system's own). */
export function listDefaults(ports: Pick<DefaultsPorts, 'platform' | 'toolchainDir' | 'fs'>): Record<DefaultLang, string | null> {
    const out = { node: null, go: null, php: null, python: null, dotnet: null, rust: null, ruby: null, java: null } as Record<DefaultLang, string | null>;
    for (const lang of DEFAULT_LANGS) {
        const target = ports.fs.readLink(currentLinkDir(ports.toolchainDir, lang));
        if (target === null) continue;
        const parent = dirname(target).replace(/[\\/]+$/, '');
        const expected = dirname(versionDir(ports.toolchainDir, lang, 'x'));
        // Only a link into that language's own versions directory is a default Genie made.
        out[lang] = parent.toLowerCase() === expected.toLowerCase() ? target.slice(parent.length + 1) : null;
    }
    return out;
}

/**
 * CHOOSE a default: a managed version (the link repoints), or `null` for the system's own (the link goes). A version
 * Genie does not manage is refused by name and nothing changes.
 */
export function setDefault(lang: DefaultLang, version: string | null, ports: DefaultsPorts): DefaultOutcome {
    const label = LANG_LABEL[lang];
    if (!langManagedOn(lang, ports.platform)) return { kind: 'refused', reason: `Genie manages ${label} versions on ${langManagedWhere(lang)}; here ${label} is the one on your PATH` };
    const link = currentLinkDir(ports.toolchainDir, lang);
    if (version === null) {
        try {
            if (ports.fs.readLink(link) !== null) ports.fs.unlink(link);
        } catch (error) {
            return { kind: 'refused', reason: `the ${label} default could not be cleared: ${error instanceof Error ? error.message : String(error)}` };
        }
        return { kind: 'cleared', lang };
    }
    if (!ports.managed(lang).includes(version)) return { kind: 'refused', reason: `${label} ${version} is not a version Genie manages here; install it in Toolchain first` };
    const target = versionDir(ports.toolchainDir, lang, version);
    try {
        ports.fs.mkdirp(dirname(link));
        if (ports.fs.readLink(link) !== null) ports.fs.unlink(link);
        ports.fs.link(target, link);
    } catch (error) {
        return { kind: 'refused', reason: `the ${label} default could not be set to ${version}: ${error instanceof Error ? error.message : String(error)}` };
    }
    // Measured, not assumed: the link now points where it was asked to.
    if (listDefaults(ports)[lang] !== version) return { kind: 'refused', reason: `the ${label} default was set to ${version}, but current/${lang} does not point there` };
    return { kind: 'set', lang, version };
}

/**
 * AT LAUNCH (and after a change): each language that has a default goes FIRST on the PATH Genie gives its terminals,
 * processes, sites and agents — the fixed `current` entry, only while its link resolves. Returns the entries applied.
 */
export function restoreDefaultsEnv(ports: Pick<DefaultsPorts, 'platform' | 'toolchainDir' | 'fs'> & { readonly env: EnvPort }): string[] {
    const defaults = listDefaults(ports);
    const entries = DEFAULT_LANGS.filter((lang) => defaults[lang] !== null && ports.fs.exists(currentLinkDir(ports.toolchainDir, lang)))
        .flatMap((lang) => langPathEntries(ports.toolchainDir, lang, ports.platform));
    // Last first, so the first language ends up first.
    for (const entry of [...entries].reverse()) ports.env.set('PATH', pathWithFirst(ports.env.get('PATH') ?? '', entry, ports.platform));
    // .NET: a published app finds its runtime through DOTNET_ROOT (else the machine-wide install, which Genie's is not).
    // Set while .NET has a default; cleared only when it is the one Genie set — a person's own DOTNET_ROOT is theirs.
    const dotnetLink = currentLinkDir(ports.toolchainDir, 'dotnet');
    if (defaults.dotnet !== null && ports.fs.exists(dotnetLink)) ports.env.set('DOTNET_ROOT', dotnetLink);
    else if (ports.env.get('DOTNET_ROOT') === dotnetLink) ports.env.set('DOTNET_ROOT', '');
    // Java: Gradle, Maven and the IDEs find the JDK through JAVA_HOME — the same rule: set while Java has a default,
    // cleared only when it is the one Genie set.
    const javaLink = currentLinkDir(ports.toolchainDir, 'java');
    if (defaults.java !== null && ports.fs.exists(javaLink)) ports.env.set('JAVA_HOME', javaLink);
    else if (ports.env.get('JAVA_HOME') === javaLink) ports.env.set('JAVA_HOME', '');
    return entries;
}

/** The real filesystem: a directory junction on Windows (removed with rmdir, which never touches its target), a symlink elsewhere. */
export function nodeLinkFs(platform: DefaultsPlatform): LinkFs {
    return {
        exists: (p) => { try { return existsSync(p); } catch { return false; } },
        readLink: (p) => { try { return resolve(dirname(p), readlinkSync(p).replace(/^\\\\\?\\/, '')); } catch { return null; } },
        link: (target, path) => symlinkSync(target, path, platform === 'win32' ? 'junction' : 'dir'),
        unlink: (path) => { if (platform === 'win32') rmdirSync(path); else unlinkSync(path); },
        mkdirp: (d) => { mkdirSync(d, { recursive: true }); },
    };
}
