import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { siteAdvisoryNotes, routeSiteEnvToDotEnv } from '../dev-site-tools';

/**
 * The create-time advisories (genie #125). A custom `image` is a legacy
 * per-site-container concept; in the sandbox-serve model a site runs its command
 * inside the shared workspace dev sandbox, so the ref is stored but never used.
 * Surfacing that on create turns a silent trap into a visible note.
 */
describe('siteAdvisoryNotes', () => {
    it('warns that a custom `image` is recorded but NOT used at runtime', () => {
        const notes = siteAdvisoryNotes({ image: 'ghcr.io/acme/app:1' });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatch(/`image` is recorded but NOT used/);
    });

    it('warns that `build` steps are recorded but never RUN (genie#191)', () => {
        // The other half of the inert-recipe report: a caller passes a production
        // build, Genie stores it, starts the site, and reports success — having run
        // none of it. Stored-and-silent is what made `recipe` look implemented.
        const notes = siteAdvisoryNotes({
            build: [{ label: 'composer', command: ['composer', 'install', '--no-dev'] }],
        });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatch(/`build`.*NOT run|never run/i);
        expect(notes[0]).toMatch(/hostServe/);
    });

    it('warns when TWO server definitions are stored, and says which one runs (genie#626)', () => {
        // The owner's site carried `hostServe: {mode:"php"}` AND a `command`
        // running artisan serve. One of them silently won, so the stored config
        // described a server the site was not running — and the docs say each of
        // these "names a SERVER". Genie serves `hostServe` and ignores the
        // `command`, which is a fact, so it can be said rather than left to be
        // discovered by reading a process list.
        const notes = siteAdvisoryNotes({
            hostServe: { mode: 'php', root: 'public' },
            command: ['php', 'artisan', 'serve'],
        });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatch(/hostServe/);
        expect(notes[0]).toMatch(/command/);
        // It must say which one WINS — a warning that both exist and stops there
        // leaves the reader exactly where they started.
        expect(notes[0]).toMatch(/hostServe.*(runs|serves|wins)|ignored/i);
        // And how to end it.
        expect(notes[0]).toMatch(/null/);
    });

    it('says nothing when only ONE server definition is stored', () => {
        // POSITIVE CONTROL for the note above: the ordinary shapes must stay quiet,
        // or the advisory becomes noise on every single call.
        expect(siteAdvisoryNotes({ hostServe: { mode: 'php', root: 'public' } })).toEqual([]);
        expect(siteAdvisoryNotes({ command: ['npm', 'run', 'dev'] })).toEqual([]);
    });

    it('has nothing to say for a plain create with no custom image', () => {
        expect(siteAdvisoryNotes({})).toEqual([]);
        expect(siteAdvisoryNotes({ image: undefined })).toEqual([]);
        expect(siteAdvisoryNotes({ build: [] })).toEqual([]);
    });
});

/**
 * genie #168 — a site's `env` (secrets included) must never land in the tracked
 * `project.json`. The create/update path routes it to the repo's gitignored
 * `.env` instead, which the app reads.
 */
describe('routeSiteEnvToDotEnv', () => {
    it('writes env to the repo .env (gitignored) and reports it — never project.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-envroute-'));
        fs.mkdirSync(path.join(root, 'repos', 'imp-wallet'), { recursive: true });

        const notes = routeSiteEnvToDotEnv(root, 'imp-wallet', { APP_KEY: 'base64:secret' });

        const envPath = path.join(root, 'repos', 'imp-wallet', '.env');
        expect(fs.readFileSync(envPath, 'utf8')).toContain('APP_KEY=base64:secret');
        // …and .env is gitignored so it can never be committed.
        expect(fs.readFileSync(path.join(root, 'repos', 'imp-wallet', '.gitignore'), 'utf8')).toContain('.env');
        // The write is surfaced, and it names .env — not project.json.
        expect(notes[0]).toMatch(/repos\/imp-wallet\/\.env/);
        expect(notes[0]).toMatch(/NOT project\.json/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('targets the workspace .env when the site has no repo, and is silent for no env', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-envroute-'));
        expect(routeSiteEnvToDotEnv(root, undefined, undefined)).toEqual([]);
        expect(routeSiteEnvToDotEnv(root, undefined, {})).toEqual([]);

        routeSiteEnvToDotEnv(root, undefined, { NODE_ENV: 'production' });
        expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain('NODE_ENV=production');
        fs.rmSync(root, { recursive: true, force: true });
    });
});
