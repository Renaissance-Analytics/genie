import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdvisoryNotes, routeSiteEnvToDotEnv } from '../dev-site-tools';

/**
 * The create-time advisories (genie #125). A custom `image` is a legacy
 * per-site-container concept; in the sandbox-serve model a site runs its command
 * inside the shared workspace dev sandbox, so the ref is stored but never used.
 * Surfacing that on create turns a silent trap into a visible note.
 */
describe('createAdvisoryNotes', () => {
    it('warns that a custom `image` is recorded but NOT used at runtime', () => {
        const notes = createAdvisoryNotes({ image: 'ghcr.io/acme/app:1' });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatch(/`image` is recorded but NOT used/);
    });

    it('has nothing to say for a plain create with no custom image', () => {
        expect(createAdvisoryNotes({})).toEqual([]);
        expect(createAdvisoryNotes({ image: undefined })).toEqual([]);
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
