import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { PtyOpened, PtyPort } from '../src/main/terminal-host.js';

/**
 * TYNN AGENT-TOKEN SETUP (add-workspace parity item 4; Genie 1 `main/tynn/provision.ts`). A workspace whose project.json
 * links a Tynn project gets a Tynn MCP agent token minted over the signed-in session (`POST /api/v1/projects/agent-token`,
 * Tynn's MeApiController::mintAgentToken) and the `tynn` server written into the SAME harness configs Genie's own `genie`
 * server goes into — one writer — with those files gitignored BEFORE the token exists. Without it an imported or linked
 * workspace's agents cannot reach Tynn.
 *
 * Every mint makes a NEW live token in Tynn (MintProjectAgentToken creates a ProjectApiKey and revokes nothing), so a
 * workspace that already carries one is never minted again — Genie 1's `hasTynnLiteralToken` rule.
 *
 * Measured with a fake Tynn session returning the shape Tynn's controller answers, the real filesystem, and the real git.
 */

const run = promisify(execFile);
/**
 * REAL GIT HAS ITS OWN BUDGET (genie#1113's Windows unit job, 2026-10-22: "a workspace not linked to Tynn" ran 5151 ms
 * against vitest's 5 s default). Each test builds its workspace with a real `git init`/`add`/`commit`, boots the services
 * and syncs every harness config, probing each written file with a real `git check-ignore` — and a process start costs
 * far more on Windows. The other real-git suites carry the same kind of budget (envelope-fork-build, envelope-build).
 */
const REAL_GIT_MS = 120_000;
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
/** `git check-ignore -q`: exit 0 = ignored, exit 1 = not ignored. Anything else is a broken probe, and throws. */
const ignored = async (cwd: string, path: string): Promise<boolean> => {
    try { await run('git', ['check-ignore', '-q', '--', path], { cwd }); return true; } catch (error) {
        if ((error as { code?: number }).code === 1) return false;
        throw error;
    }
};

const TOKEN = 'rpk_01JBTESTPUBLICID0000000000.' + 'a1'.repeat(32);
const PROJECT = '9d1c7f00-0000-4000-8000-000000000042';
const GENIE = { url: 'http://127.0.0.1:51717/mcp/abc', token: 'genie-endpoint-token-0123456789abcdef0123' };

/** Tynn's mintAgentToken answer, field for field — the per-agent config and CLI command carry the token too. */
function mintBody(mcpUrl = 'https://tynn.example/mcp/tynn', token = TOKEN) {
    return {
        token,
        agent: { id: '77', name: 'Genie' },
        scopes: ['issues:read', 'issues:write'],
        scope_target: 'mcp',
        expires_at: null,
        is_ops_project: false,
        is_envelope: true,
        envelope: null,
        envelope_status: 'none',
        mcp_url: mcpUrl,
        connection_slug: 'tynn-acme',
        mcp_config: JSON.stringify({ mcpServers: { 'tynn-acme': { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }),
        mcp_config_filename: '.mcp.genie.json',
        cli_command: `claude mcp add --transport http tynn-acme ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    };
}

type Answer = { status: number; body: unknown } | Error;

/** A signed-in (or not) Tynn session, as TynnAccount is to compose: `status()` and `request()`. */
function fakeTynn(opts: { signedIn?: boolean; answer?: Answer; gate?: Promise<void> } = {}) {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const port = {
        status: () => (opts.signedIn === false ? { signedIn: false as const } : { signedIn: true as const, host: 'https://tynn.example', user: { name: 'A Person', email: 'person@example.com' } }),
        request: async (path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }) => {
            calls.push({ path, method: init.method, body: init.body });
            if (opts.gate) await opts.gate;
            const a = opts.answer ?? { status: 200, body: mintBody() };
            if (a instanceof Error) throw a;
            return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
        },
    };
    return { port, calls };
}

function fakePty(): PtyPort {
    let n = 0;
    return {
        open() { const id = `term_${++n}`; return { id, pid: 500 + n, shell: 'sh', scrollback: '' } satisfies PtyOpened; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
}

let dir: string;
let ws: string;
let services: ComposedServices | null = null;
let tynn: ReturnType<typeof fakeTynn>;
let logged: string[];

async function boot(port: ReturnType<typeof fakeTynn>['port'] | null): Promise<ComposedServices> {
    if (services) await services.shutdown();
    services = await composeServices({
        userData: join(dir, 'genie'), pty: fakePty(), v1Settings: () => null, caddyBin: null, frontDoorPort: 0,
        mcpEndpoint: () => GENIE,
        tynn: () => port,
    } as never);
    return services;
}

/** A git workspace with a committed README and a project.json linking it to a Tynn project (the envelope schema's `tynn`). */
async function linkedWorkspace(link: unknown = { host: 'https://tynn.example', project: 'Acme', projectId: PROJECT }): Promise<void> {
    await mkdir(ws, { recursive: true });
    await git(ws, 'init', '--initial-branch=main');
    await writeFile(join(ws, 'README.md'), '# acme\n');
    await writeFile(join(ws, 'project.json'), `${JSON.stringify({ name: 'acme', ...(link ? { tynn: link } : {}) }, null, 2)}\n`);
    await git(ws, 'add', 'README.md', 'project.json');
    await git(ws, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init');
}

const readJson = async (p: string) => JSON.parse(await readFile(join(ws, p), 'utf8'));
type Row = { readonly id: string; readonly ok: boolean; readonly error?: string };
const tynnRow = (results: ReadonlyArray<Row>): Row | undefined => results.find((r) => r.id === 'tynn');

/** Every file under the workspace (git's own store aside) whose bytes carry the token. */
async function filesWithToken(token = TOKEN): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) { if (e.name !== '.git') await walk(p); continue; }
            if ((await readFile(p, 'utf8')).includes(token)) out.push(relative(ws, p).replace(/\\/g, '/'));
        }
    };
    await walk(ws);
    return out.sort();
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-tynn-token-'));
    ws = join(dir, 'acme.agi');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(dir, 'global.gitconfig'));
    await writeFile(join(dir, 'global.gitconfig'), '');
    tynn = fakeTynn();
    logged = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); });
    }
});

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (services) await services.shutdown();
    services = null;
    await rm(dir, { recursive: true, force: true });
});

describe('a linked workspace, signed in, with no token yet', () => {
    it('mints ONE token for its project and writes the tynn server beside genie in every harness config', async () => {
        await linkedWorkspace();
        const s = await boot(tynn.port);
        const results = await s.syncConfig(ws);

        expect(tynn.calls).toEqual([{ path: '/api/v1/projects/agent-token', method: 'POST', body: { project_id: PROJECT } }]);
        expect(tynnRow(results)).toMatchObject({ ok: true });
        const claude = await readJson('.mcp.json');
        expect(claude.mcpServers.tynn).toEqual({ type: 'http', url: 'https://tynn.example/mcp/tynn', headers: { Authorization: `Bearer ${TOKEN}` } });
        expect(claude.mcpServers.genie.url).toBe(GENIE.url);
        expect((await readJson('.cursor/mcp.json')).mcpServers.tynn.headers.Authorization).toBe(`Bearer ${TOKEN}`);
        const toml = await readFile(join(ws, '.codex', 'config.toml'), 'utf8');
        expect(toml.match(/^\[mcp_servers\.tynn\]$/gm)).toHaveLength(1);
        expect(toml).toContain('url = "https://tynn.example/mcp/tynn"');
        expect(toml).toContain(`Authorization = "Bearer ${TOKEN}"`);
        expect(toml.match(/^\[mcp_servers\.genie\]$/gm)).toHaveLength(1);
    }, REAL_GIT_MS);

    it('every file carrying the token is gitignored — and a tracked file is NOT (the probe can say no)', async () => {
        await linkedWorkspace();
        await (await boot(tynn.port)).syncConfig(ws);

        const carrying = await filesWithToken();
        expect(carrying).toEqual(['.codex/config.toml', '.cursor/mcp.json', '.mcp.json']);
        for (const f of carrying) expect(await ignored(ws, f)).toBe(true);
        // Positive control, same probe, same repo: the committed files are not ignored.
        expect(await ignored(ws, 'README.md')).toBe(false);
        expect(await ignored(ws, 'project.json')).toBe(false);
        expect(await git(ws, 'status', '--porcelain', '--untracked-files=all')).not.toMatch(/mcp\.json|config\.toml/);
    }, REAL_GIT_MS);

    it('the token is in no log, no sync result, no Settings report and not in project.json', async () => {
        await linkedWorkspace();
        const s = await boot(tynn.port);
        const results = await s.syncConfig(ws);

        expect(logged.join('\n')).not.toContain(TOKEN);
        expect(JSON.stringify(results)).not.toContain(TOKEN);
        expect(JSON.stringify(s.integrations())).not.toContain(TOKEN);
        expect(await readFile(join(ws, 'project.json'), 'utf8')).not.toContain(TOKEN);
        // Positive control: the same scan finds the token where it was written.
        expect(await readFile(join(ws, '.mcp.json'), 'utf8')).toContain(TOKEN);
    }, REAL_GIT_MS);

    it('a plaintext REMOTE mcp_url is written as https (genie#201: the bearer token never goes in the clear); loopback stays', async () => {
        await linkedWorkspace();
        await (await boot(fakeTynn({ answer: { status: 200, body: mintBody('http://tynn.example/mcp/tynn') } }).port)).syncConfig(ws);
        expect((await readJson('.mcp.json')).mcpServers.tynn.url).toBe('https://tynn.example/mcp/tynn');

        await rm(ws, { recursive: true, force: true });
        await linkedWorkspace();
        await (await boot(fakeTynn({ answer: { status: 200, body: mintBody('http://127.0.0.1:8000/mcp/tynn') } }).port)).syncConfig(ws);
        expect((await readJson('.mcp.json')).mcpServers.tynn.url).toBe('http://127.0.0.1:8000/mcp/tynn');
    }, REAL_GIT_MS);
});

describe('it does not mint again needlessly (each mint is a new live token in Tynn)', () => {
    it('a second sync, and a fresh Genie session, reuse the token on disk', async () => {
        await linkedWorkspace();
        await (await boot(tynn.port)).syncConfig(ws);
        await services!.syncConfig(ws);
        expect(tynn.calls).toHaveLength(1);

        const again = fakeTynn({ answer: { status: 200, body: mintBody(undefined, 'rpk_SECOND.' + 'b2'.repeat(32)) } });
        const results = await (await boot(again.port)).syncConfig(ws);
        expect(again.calls).toHaveLength(0);
        expect(tynnRow(results)).toMatchObject({ ok: true });
        expect((await readJson('.mcp.json')).mcpServers.tynn.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }, REAL_GIT_MS);

    it('two syncs at once mint once', async () => {
        await linkedWorkspace();
        let open!: () => void;
        const slow = fakeTynn({ gate: new Promise<void>((r) => { open = r; }) });
        const s = await boot(slow.port);
        const both = Promise.all([s.syncConfig(ws), s.syncConfig(ws)]);
        await new Promise((r) => setTimeout(r, 50));
        open();
        await both;
        expect(slow.calls).toHaveLength(1);
    }, REAL_GIT_MS);

    it('a workspace Genie 1 provisioned keeps its token: no mint, and Genie 1\'s Codex tynn block is replaced, not doubled', async () => {
        await linkedWorkspace();
        await writeFile(join(ws, '.gitignore'), '.mcp.json\n.cursor/\n.codex/config.toml\n.env\n');
        await writeFile(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { tynn: { type: 'http', url: 'https://tynn.example/mcp/tynn', headers: { Authorization: `Bearer ${TOKEN}` } } } }, null, 2));
        await mkdir(join(ws, '.codex'), { recursive: true });
        await writeFile(join(ws, '.codex', 'config.toml'), 'model = "o3"\n# BEGIN GENIE MCP: tynn\n[mcp_servers.tynn]\nurl = "https://tynn.example/mcp/tynn"\nbearer_token_env_var = "TYNN_AGENT_TOKEN"\n# END GENIE MCP: tynn\n');
        const results = await (await boot(tynn.port)).syncConfig(ws);

        expect(tynn.calls).toHaveLength(0);
        expect(tynnRow(results)).toMatchObject({ ok: true });
        const toml = await readFile(join(ws, '.codex', 'config.toml'), 'utf8');
        expect(toml.startsWith('model = "o3"\n')).toBe(true);
        expect(toml.match(/^\[mcp_servers\.tynn\]$/gm)).toHaveLength(1);
        expect(toml).not.toContain('# BEGIN GENIE MCP: tynn');
        expect(toml).toContain(`Authorization = "Bearer ${TOKEN}"`);
    }, REAL_GIT_MS);

    it('with Claude Code\'s sync off, a token already in Cursor\'s config is reused, not minted again', async () => {
        await linkedWorkspace();
        await mkdir(join(ws, '.cursor'), { recursive: true });
        await writeFile(join(ws, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { tynn: { type: 'http', url: 'https://tynn.example/mcp/tynn', headers: { Authorization: `Bearer ${TOKEN}` } } } }));
        const s = await boot(tynn.port);
        await s.settings.set('mcp_sync_claude', false);
        const results = await s.syncConfig(ws);
        expect(tynn.calls).toHaveLength(0);
        // Not vacuous: the reused token is carried to the harnesses that ARE on.
        expect(tynnRow(results)).toMatchObject({ ok: true });
        expect(await readFile(join(ws, '.codex', 'config.toml'), 'utf8')).toContain(`Authorization = "Bearer ${TOKEN}"`);
    }, REAL_GIT_MS);

    it('with every harness sync off there is nowhere to put a token: none is minted, and it says so', async () => {
        await linkedWorkspace();
        const s = await boot(tynn.port);
        for (const k of ['mcp_sync_claude', 'mcp_sync_cursor', 'mcp_sync_codex']) await s.settings.set(k, false);
        const results = await s.syncConfig(ws);
        expect(tynn.calls).toHaveLength(0);
        expect(tynnRow(results)).toMatchObject({ ok: false });
        expect((tynnRow(results) as { error: string }).error).toMatch(/sync/i);
    }, REAL_GIT_MS);
});

describe('when it cannot mint, it says so and writes nothing of Tynn\'s', () => {
    const noTynnWritten = async () => {
        expect((await readJson('.mcp.json')).mcpServers.tynn).toBeUndefined();
        expect((await readJson('.mcp.json')).mcpServers.genie.url).toBe(GENIE.url);
        expect(await readFile(join(ws, '.codex', 'config.toml'), 'utf8')).not.toContain('mcp_servers.tynn');
    };

    it('Tynn refuses (403): the reason is stated in the sync result and in Settings', async () => {
        await linkedWorkspace();
        const s = await boot(fakeTynn({ answer: { status: 403, body: { error: 'project-not-accessible' } } }).port);
        const row = tynnRow(await s.syncConfig(ws));
        expect(row).toMatchObject({ ok: false });
        expect((row as { error: string }).error).toMatch(/403/);
        expect((row as { error: string }).error).toMatch(/project-not-accessible/);
        await noTynnWritten();
        expect(JSON.stringify(s.integrations().agentFiles)).toMatch(/project-not-accessible/);
    }, REAL_GIT_MS);

    it('Tynn unreachable: stated', async () => {
        await linkedWorkspace();
        const row = tynnRow(await (await boot(fakeTynn({ answer: new Error('getaddrinfo ENOTFOUND tynn.example') }).port)).syncConfig(ws));
        expect(row).toMatchObject({ ok: false });
        expect((row as { error: string }).error).toMatch(/ENOTFOUND/);
        await noTynnWritten();
    }, REAL_GIT_MS);

    it('a 200 without a token (or url) writes nothing — never a broken entry', async () => {
        await linkedWorkspace();
        const row = tynnRow(await (await boot(fakeTynn({ answer: { status: 200, body: { ...mintBody(), token: '' } } }).port)).syncConfig(ws));
        expect(row).toMatchObject({ ok: false });
        await noTynnWritten();
    }, REAL_GIT_MS);

    it('the token files cannot be gitignored: no token is minted at all', async () => {
        await linkedWorkspace();
        await mkdir(join(ws, '.gitignore'));
        const row = tynnRow(await (await boot(tynn.port)).syncConfig(ws));
        expect(tynn.calls).toHaveLength(0);
        expect(row).toMatchObject({ ok: false });
        expect((row as { error: string }).error).toMatch(/gitignore/i);
    }, REAL_GIT_MS);

    it('signed out of Tynn: nothing is asked, and the workspace says why its agents have no Tynn', async () => {
        await linkedWorkspace();
        const out = fakeTynn({ signedIn: false });
        const row = tynnRow(await (await boot(out.port)).syncConfig(ws));
        expect(out.calls).toHaveLength(0);
        expect(row).toMatchObject({ ok: false });
        expect((row as { error: string }).error).toMatch(/sign in/i);
        await noTynnWritten();
    }, REAL_GIT_MS);
});

describe('a workspace not linked to Tynn', () => {
    it('is left alone: no request, no Tynn row, a tynn server a person wrote stays as it was', async () => {
        await linkedWorkspace(null);
        await writeFile(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { tynn: { url: 'https://mine.example/mcp' } } }));
        const results = await (await boot(tynn.port)).syncConfig(ws);
        expect(tynn.calls).toHaveLength(0);
        expect(tynnRow(results)).toBeUndefined();
        expect((await readJson('.mcp.json')).mcpServers.tynn).toEqual({ url: 'https://mine.example/mcp' });
    }, REAL_GIT_MS);
});
