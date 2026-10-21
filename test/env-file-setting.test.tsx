import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ENV_FILE, envFileName, parseDotEnv } from '../src/core/dotenv.js';
import { sectionOf } from '../src/core/settings-nav.js';
import { carryOverV1, searchSettings, SETTINGS } from '../src/core/settings.js';
import { DotEnvSync } from '../src/main/dotenv-sync.js';
import { nodeEnvelopeFs } from '../src/main/envelope-sites-host.js';
import { addWorkspace, addWorkspaceFromGit, addWorkspaceFromTynn, createWorkspace, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * THE ENV FILE NAME AT GENIE 1 PARITY (Add workspace parity item 2b). Genie 1 had Settings → General "Env file name": text,
 * default `.env`, a workstation default (genie renderer/pages/settings.tsx:510-520, main/db.ts:3700), and every way it
 * registered a workspace stamped it as that workspace's `env_file` (main/workspace/add-workspace.ts:185,
 * InteractiveUpgradeWizard.tsx:596, 747). Genie 2 had neither the setting nor the field, and its `.env` writer named the
 * file itself. Now: the setting, carried over from Genie 1; each workspace keeps the name it was registered with; the
 * writer writes THAT file — and `.env` stays what it writes when nothing says otherwise.
 */

describe('the setting', () => {
    it('is Genie 1’s: a workstation (host) text setting in General, "Env file name", default `.env`; search finds it', () => {
        const def = SETTINGS.find((s) => s.key === 'default_env_file');
        expect(def).toMatchObject({ group: 'general', scope: 'host', type: 'string', default: '.env', label: 'Env file name' });
        expect(def?.description).toMatch(/new workspaces/);
        expect(sectionOf('default_env_file')).toBe('general');
        expect(searchSettings('env file').map((d) => d.key)).toContain('default_env_file');
    });

    it('Genie 1’s value carries over at the upgrade (and is not reported as dropped)', () => {
        const out = carryOverV1({ default_env_file: '.env.local' });
        expect(out.applied['default_env_file']).toBe('.env.local');
        expect(out.dropped).toEqual([]);
    });

    it('is drawn in General’s "Defaults for new projects", beside Primary workspace — not under Startup and focus', () => {
        const values = { ...Object.fromEntries(SETTINGS.map((s) => [s.key, s.default])), default_env_file: '.env.local' };
        const html = renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values } }} onAction={() => {}} onNavigate={() => {}} section="general" />);
        const defaults = html.slice(html.indexOf('Defaults for new projects'), html.indexOf('Startup and focus'));
        // Positive control: the block is found, and Primary workspace is in it.
        expect(defaults).toContain('data-primary-workspace');
        expect(defaults).toContain('data-setting="default_env_file"');
        expect(defaults).toContain('Env file name');
        expect(defaults).toContain('value=".env.local"');
        // Drawn once (COUNTED), so not again under Startup and focus.
        expect(html.match(/data-setting="default_env_file"/g) ?? []).toHaveLength(1);
    });
});

describe('the name the writer may use', () => {
    it('a file name in the folder: `.env` when nothing is set; a path, `..` or a separator is not a name', () => {
        expect(DEFAULT_ENV_FILE).toBe('.env');
        expect(envFileName(undefined)).toBe('.env');
        expect(envFileName('')).toBe('.env');
        expect(envFileName('  .env.local  ')).toBe('.env.local');
        expect(envFileName('.env.development')).toBe('.env.development');
        for (const bad of ['../.env', 'config/.env', 'config\\.env', '..', '.', 'C:.env', '/etc/x']) expect(envFileName(bad), bad).toBeNull();
    });
});

/** Every add path through the ports, in memory: which record reached the registry. */
function fakes(defaultEnvFile?: () => string) {
    const entries: Record<string, string[]> = { '/w': [], '/w/existing': ['notes.txt'] };
    const files: Record<string, unknown> = {};
    const registered: Array<{ id: string; path: string; envFile?: string }> = [];
    const key = (p: string) => p.replace(/\\/g, '/');
    const ports: WorkspaceOpsPorts = {
        fs: {
            exists: async (p) => key(p) in entries,
            entries: async (p) => entries[key(p)] ?? [],
            readJson: async (p) => files[key(p)] ?? null,
            writeJson: async (p, v) => { files[key(p)] = v; },
            mkdir: async (p) => { if (!(key(p) in entries)) entries[key(p)] = []; },
            writeText: async (p, t) => { files[key(p)] = t; },
            gitInit: async () => {},
            gitFirstCommit: async () => {},
            gitCommit: async () => {},
            gitClone: async (_url, into) => { entries[key(into)] = ['.git', 'src']; },
            gitAddSubmodule: async () => null,
        },
        registry: {
            workspace: (id) => (registered.some((r) => r.id === id) ? { id, path: '', asleep: false } : null),
            list: () => registered,
            addWorkspace: async (r) => { registered.push({ ...r, path: key(r.path) }); },
            agentsOf: () => [],
            setAsleep: async () => true,
            forgetWorkspace: async () => null,
        },
        host: { probe: () => null, prompt: () => true, stop: () => true },
        attention: { finished: () => [] },
        terminals: { list: () => [], close: () => true },
        supervisor: { list: () => [], stop: () => true },
        now: () => 1,
        sleep: async () => {},
        tynn: { host: 'https://tynn.example', projects: async () => [{ id: 42, name: 'Example', slug: 'example' }] },
        ...(defaultEnvFile ? { defaultEnvFile } : {}),
    };
    return { ports, registered };
}

describe('a workspace keeps the env file name it was registered with — every add path', () => {
    it('New, Open existing, Import from Git and Import from Tynn each register the setting’s name (COUNTED: four)', async () => {
        const f = fakes(() => '.env.local');
        expect(await createWorkspace(f.ports, 'Made New', '/w')).toMatchObject({ ok: true });
        expect(await addWorkspace(f.ports, '/w/existing')).toMatchObject({ ok: true });
        expect(await addWorkspaceFromGit(f.ports, 'https://github.example/acme/app.git', '/w')).toMatchObject({ ok: true });
        expect(await addWorkspaceFromTynn(f.ports, '/w', '42')).toMatchObject({ ok: true });
        expect(f.registered.map((r) => [r.id, r.envFile])).toEqual([
            ['made-new', '.env.local'],
            ['existing', '.env.local'],
            ['app', '.env.local'],
            ['example', '.env.local'],
        ]);
    });

    it('the setting read at the moment of the add, not once: changed between two adds, each keeps its own', async () => {
        let setting = '.env.one';
        const f = fakes(() => setting);
        await addWorkspace(f.ports, '/w/existing');
        setting = '.env.two';
        await createWorkspace(f.ports, 'Second', '/w');
        expect(f.registered.map((r) => r.envFile)).toEqual(['.env.one', '.env.two']);
    });

    it('a blank, unusable or absent setting registers `.env` — Genie 1’s default', async () => {
        const blank = fakes(() => '   ');
        await addWorkspace(blank.ports, '/w/existing');
        const path = fakes(() => '../outside/.env');
        await addWorkspace(path.ports, '/w/existing');
        const none = fakes();
        await addWorkspace(none.ports, '/w/existing');
        expect([blank, path, none].map((f) => f.registered[0]?.envFile)).toEqual(['.env', '.env', '.env']);
    });
});

const ENV = { DATABASE_URL: 'postgresql://ws_example:genpw-0001@127.0.0.1:4101/ws_example', DB_HOST: '127.0.0.1', DB_PORT: '4101', DB_PASSWORD: 'genpw-0001' };

describe('the writer writes the workspace’s own env file', () => {
    let root: string;
    let repo: string;
    let askedAbout: string[];

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'genie2-envfile-'));
        repo = join(root, 'repos', 'web');
        await mkdir(repo, { recursive: true });
        askedAbout = [];
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const syncWith = (envFileOf: ((workspaceId: string) => string | undefined) | undefined) => new DotEnvSync({
        envFor: () => ENV,
        sites: () => [{ workspaceId: 'example', repoPath: repo }],
        fs: nodeEnvelopeFs(),
        gitIgnored: async (_dir, file) => { askedAbout.push(file); return 'ignored'; },
        ...(envFileOf ? { envFileOf } : {}),
    });

    it('`.env.local` registered: THAT file is written, git is asked about it, and `.env` is left alone', async () => {
        await writeFile(join(repo, '.env'), 'APP_NAME=Mine\n', 'utf8');
        const out = await syncWith(() => '.env.local').syncAll();
        expect(out).toEqual([expect.objectContaining({ workspaceId: 'example', file: join(repo, '.env.local'), outcome: 'written' })]);
        expect(parseDotEnv(await readFile(join(repo, '.env.local'), 'utf8')).get('DB_PORT')).toBe('4101');
        expect(askedAbout).toEqual(['.env.local']);
        expect(await readFile(join(repo, '.env'), 'utf8')).toBe('APP_NAME=Mine\n');
    });

    it('no name recorded (a workspace from before the setting, or no lookup): `.env`, as it always was', async () => {
        // The first writes it; the second, with no lookup at all, finds the SAME file current.
        expect((await syncWith(() => undefined).syncAll())[0]).toMatchObject({ file: join(repo, '.env'), outcome: 'written' });
        expect((await syncWith(undefined).syncAll())[0]).toMatchObject({ file: join(repo, '.env'), outcome: 'current' });
        expect(askedAbout).toEqual(['.env']);
        expect(parseDotEnv(await readFile(join(repo, '.env'), 'utf8')).get('DB_PORT')).toBe('4101');
    });

    it('a recorded name that is not a file name in the folder is REFUSED and nothing is written (control: a good name is written)', async () => {
        const out = await syncWith(() => '../escape.env').syncAll();
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ outcome: 'refused' });
        expect((out[0] as { reason: string }).reason).toMatch(/not a file name/);
        expect(askedAbout).toEqual([]);
        await expect(readFile(join(root, 'repos', 'escape.env'), 'utf8')).rejects.toThrow();
        await expect(readFile(join(repo, '.env'), 'utf8')).rejects.toThrow();

        expect((await syncWith(() => '.env.good').syncAll())[0]).toMatchObject({ outcome: 'written' });
    });
});
