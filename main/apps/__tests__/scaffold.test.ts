import { describe, expect, it } from 'vitest';
import { scaffoldApp } from '../scaffold';
import { validateAppManifest, APP_MANIFEST_FILENAME } from '../manifest';
import { validateAppFolder } from '../validate';
import { checkApp } from '../checkup';

/**
 * Creating a Genie App from nothing (Tynn #250, P2).
 *
 * The owner's requirement is that the SDK teach an agent to "fill a gap". Docs are
 * half of that; the other half is a starting point that is already correct, because
 * the first thing anyone does — human or agent — is copy what is in front of them.
 * A scaffold that asked for `terminals` would teach every app built from it to ask
 * for `terminals`.
 *
 * Pure: it returns the files to write, so what it produces can be checked against
 * the REAL validator rather than eyeballed. That check is the point of the whole
 * file — a scaffold that does not pass Genie's own gate is worse than none.
 */

const files = (name = 'My Thing') => scaffoldApp({ name, id: 'com.example.mything' });

const find = (name: string, path: string) =>
    files(name).find((f) => f.path === path)?.contents ?? '';

describe('what it writes', () => {
    it('produces a manifest the real validator accepts', () => {
        const manifest = JSON.parse(find('My Thing', APP_MANIFEST_FILENAME));
        expect(validateAppManifest(manifest).ok).toBe(true);
    });

    it('pins the shared schema revision Genie used to create the manifest', () => {
        const manifest = JSON.parse(find('My Thing', APP_MANIFEST_FILENAME));
        expect(manifest.$schema).toBe(
            'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.1.0/schemas/workspace/genie-app.schema.json',
        );
    });

    it('produces a folder the real folder-check passes', () => {
        // The end-to-end guarantee: scaffold, then install, with nothing in between.
        // A small virtual filesystem: the files the scaffold wrote, plus the
        // directories holding them — because the real probe is `fs.existsSync`,
        // which answers for directories too, and the front-end root IS one.
        const written = files().map((f) => `C:/src/mything/${f.path}`);
        const report = validateAppFolder('C:/src/mything', {
            readManifest: () => find('My Thing', APP_MANIFEST_FILENAME),
            exists: (p) => {
                const target = p.replace(/\\/g, '/').replace(/\/\.$/, '');
                return written.some((w) => w === target || w.startsWith(`${target}/`));
            },
            slugTaken: () => false,
        });

        expect(report.errors).toEqual([]);
        expect(report.ok).toBe(true);
    });

    it('produces a folder the whole CHECK SUITE passes, not just the install gate', () => {
        // The gate above answers "can Genie install this". The suite answers the
        // question a developer actually has — "will it WORK" — and it is stricter,
        // so a scaffold that passed only the gate could still hand somebody an app
        // that opens on an empty window. The first thing anyone does is copy what
        // is in front of them, so what is in front of them has to be clean.
        const written = files().map((f) => `C:/src/mything/${f.path}`);
        const contents = new Map(files().map((f) => [`C:/src/mything/${f.path}`, f.contents]));
        const at = (p: string) => p.replace(/\\/g, '/').replace(/\/\.$/, '');

        const report = checkApp('C:/src/mything', {
            readManifest: () => find('My Thing', APP_MANIFEST_FILENAME),
            exists: (p) => written.some((w) => w === at(p) || w.startsWith(`${at(p)}/`)),
            slugTaken: () => false,
            listFiles: (dir) => written.filter((w) => w.startsWith(`${at(dir)}/`)),
            readText: (p) => contents.get(at(p)) ?? null,
        });

        expect(report.findings, JSON.stringify(report.findings, null, 2)).toEqual([]);
    });

    it('gives the app a front end and something to read', () => {
        const paths = files().map((f) => f.path);
        expect(paths).toContain(APP_MANIFEST_FILENAME);
        expect(paths.some((p) => p.endsWith('index.html'))).toBe(true);
        expect(paths).toContain('README.md');
    });
});

describe('the slug it derives', () => {
    it('turns a human name into a DNS label', () => {
        const manifest = JSON.parse(find('My Thing', APP_MANIFEST_FILENAME));
        expect(manifest.slug).toBe('my-thing');
    });

    it('survives punctuation, case and spacing', () => {
        for (const [name, slug] of [
            ['  Trader  Pro!  ', 'trader-pro'],
            ['ORR Jdun', 'orr-jdun'],
            ['a__b', 'a-b'],
        ] as const) {
            const written = scaffoldApp({ name, id: 'com.example.x' });
            const manifest = JSON.parse(
                written.find((f) => f.path === APP_MANIFEST_FILENAME)?.contents ?? '{}',
            );
            expect(manifest.slug, name).toBe(slug);
        }
    });

    it('falls back rather than producing an unservable empty slug', () => {
        // A name of pure punctuation would slugify to nothing, and an empty slug
        // is a site that cannot be served.
        const written = scaffoldApp({ name: '!!!', id: 'com.example.x' });
        const manifest = JSON.parse(
            written.find((f) => f.path === APP_MANIFEST_FILENAME)?.contents ?? '{}',
        );
        expect(validateAppManifest(manifest).ok).toBe(true);
    });

    it('refuses a name Genie reserves, rather than scaffolding an app that cannot install', () => {
        expect(() => scaffoldApp({ name: 'Genie', id: 'com.example.x' })).toThrow(/reserved/i);
    });
});

describe('what it teaches by example', () => {
    it('asks for the NARROWEST scope', () => {
        const manifest = JSON.parse(find('My Thing', APP_MANIFEST_FILENAME));
        expect(manifest.permissions.scope).toBe('self');
    });

    it('asks for NO capabilities at all', () => {
        // The starting point should be an app that can do nothing, so every
        // permission in a finished app is one somebody deliberately added.
        const manifest = JSON.parse(find('My Thing', APP_MANIFEST_FILENAME));
        expect(manifest.permissions.capabilities).toEqual([]);
    });

    it('shows the ask-before-you-offer pattern in its front end', () => {
        const html = files().find((f) => f.path.endsWith('index.html'))?.contents ?? '';
        expect(html).toContain('genieApp');
        // The pattern that matters: check what you were granted, then render.
        expect(html).toMatch(/capabilities/);
    });

    it('never reaches for window.genie', () => {
        for (const file of files()) {
            const code = file.contents
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/<!--[\s\S]*?-->/g, '');
            expect(code, file.path).not.toMatch(/\bwindow\.genie\b(?!App)/);
        }
    });
});
