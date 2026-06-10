import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, net } from 'electron';
import { EventEmitter } from 'node:events';

const execFileAsync = promisify(execFile);

/**
 * Phase 1 dev updater. The whole flow:
 *
 *   1. Read the current version from package.json (the one bundled into
 *      `app/` — that's what's running, not necessarily what's in source).
 *   2. Poll GitHub /releases/latest (or /tags as fallback) on the
 *      configured `<owner>/<repo>`.
 *   3. semver-compare. If a newer tag exists, surface `available`.
 *   4. On user confirm: `git fetch origin --tags && git checkout <tag>
 *      && npm install && npm run build`. Stream stdout/stderr as
 *      log lines back to the renderer.
 *   5. On success, prompt user to restart Electron.
 *   6. On failure, attempt a rollback: `git checkout <previous HEAD>`.
 *      Don't try to roll back npm install — at worst node_modules is
 *      in a slightly inconsistent state but the user is back on the
 *      old source.
 *
 * Public-repo assumption: we don't pass auth to GitHub or to git.
 * If the repo is private, the user's local git config has to handle
 * credentials (same as their normal pull workflow).
 *
 * Not all installs are git checkouts (someone could unzip a release
 * tarball). The updater detects this via `.git/` presence at the
 * install root and reports `state: 'not-a-git-checkout'` so the
 * Settings UI can degrade gracefully.
 */

export type UpdaterState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'up-to-date'
    | 'applying'
    | 'ready-to-restart'
    | 'error'
    | 'disabled';

export interface UpdaterStatus {
    state: UpdaterState;
    currentVersion: string;
    latestVersion: string | null;
    publishedAt: string | null;
    releaseUrl: string | null;
    log: string[];
    error: string | null;
    repo: string | null;
}

export interface UpdaterConfig {
    /** "owner/repo" — e.g. "wishborn/genie". Empty disables polling. */
    repo: string;
    /** Hours between automatic checks. 0 disables auto-poll. */
    pollHours: number;
}

const LOG_MAX = 2000; // lines

class GitUpdater extends EventEmitter {
    private status: UpdaterStatus;
    private timer: NodeJS.Timeout | null = null;
    private config: UpdaterConfig = { repo: '', pollHours: 6 };

    constructor() {
        super();
        this.status = {
            state: 'idle',
            currentVersion: readVersion(),
            latestVersion: null,
            publishedAt: null,
            releaseUrl: null,
            log: [],
            error: null,
            repo: null,
        };
    }

    setConfig(c: Partial<UpdaterConfig>): void {
        this.config = { ...this.config, ...c };
        this.status.repo = this.config.repo || null;
        if (!this.config.repo) {
            this.setStatus({ state: 'disabled' });
        }
        this.restartTimer();
        this.emit('status', this.status);
    }

    getConfig(): UpdaterConfig {
        return { ...this.config };
    }

    getStatus(): UpdaterStatus {
        return { ...this.status, log: [...this.status.log] };
    }

    startPolling(): void {
        this.restartTimer();
        // Fire a check on next tick so callers get the initial status
        // sync, then the network result asynchronously.
        if (this.config.repo && isGitCheckout(installRoot())) {
            queueMicrotask(() => void this.checkForUpdate().catch(() => {}));
        }
    }

    stopPolling(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * Poll GitHub and update internal status. Idempotent; safe to call
     * concurrently (later calls overwrite earlier ones).
     */
    async checkForUpdate(): Promise<void> {
        if (this.status.state === 'applying') return;
        if (!this.config.repo) {
            this.setStatus({ state: 'disabled', error: 'No repo configured.' });
            return;
        }
        if (!isGitCheckout(installRoot())) {
            this.setStatus({
                state: 'disabled',
                error:
                    'Install is not a git checkout — updater requires `git clone`-style install.',
            });
            return;
        }

        this.setStatus({ state: 'checking', error: null });

        try {
            const release = await fetchLatestRelease(this.config.repo);
            if (!release) {
                this.setStatus({ state: 'up-to-date' });
                return;
            }
            const current = this.status.currentVersion;
            const latest = stripV(release.tag_name);
            if (isNewer(latest, current)) {
                this.setStatus({
                    state: 'available',
                    latestVersion: latest,
                    publishedAt: release.published_at ?? null,
                    releaseUrl: release.html_url ?? null,
                });
            } else {
                this.setStatus({
                    state: 'up-to-date',
                    latestVersion: latest,
                    publishedAt: release.published_at ?? null,
                });
            }
        } catch (e) {
            this.setStatus({
                state: 'error',
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /**
     * Apply the latest available update. Streams log lines via the
     * 'log' event for the renderer to display.
     */
    async applyUpdate(): Promise<void> {
        if (this.status.state !== 'available') {
            throw new Error('No update available to apply.');
        }
        const tag = this.status.latestVersion;
        if (!tag) throw new Error('Internal: no latest tag in status.');
        const root = installRoot();
        if (!isGitCheckout(root)) {
            throw new Error('Install is not a git checkout.');
        }

        this.setStatus({ state: 'applying', error: null, log: [] });
        const previousHead = await captureHead(root);

        try {
            await this.runStep(root, 'git', ['fetch', 'origin', '--tags']);
            await this.runStep(root, 'git', ['checkout', `v${tag}`]).catch(
                async () => {
                    // Fallback: tag may be stored without the "v" prefix.
                    await this.runStep(root, 'git', ['checkout', tag]);
                },
            );
            await this.runStep(root, npmCommand(), ['install']);
            await this.runStep(root, npmCommand(), ['run', 'build']);
            this.setStatus({ state: 'ready-to-restart' });
            this.appendLog('— Update applied. Restart Genie to load it.');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.appendLog(`!! Failed: ${msg}`);
            // Best-effort rollback. Don't override the user-facing error
            // with rollback noise.
            try {
                await this.runStep(root, 'git', ['checkout', previousHead]);
                this.appendLog(`— Rolled back to ${previousHead.slice(0, 8)}`);
            } catch (rollbackErr) {
                this.appendLog(
                    `!! Rollback also failed: ${(rollbackErr as Error).message}. ` +
                        'Run `git status` in the install dir to clean up manually.',
                );
            }
            this.setStatus({ state: 'error', error: msg });
        }
    }

    private async runStep(cwd: string, cmd: string, args: string[]): Promise<void> {
        const display = `${cmd} ${args.join(' ')}`;
        this.appendLog(`$ ${display}`);
        return new Promise<void>((resolve, reject) => {
            const child = spawn(cmd, args, {
                cwd,
                env: process.env,
                shell: process.platform === 'win32', // npm/git on Windows need cmd.exe
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => this.appendLog(chunk));
            child.stderr.on('data', (chunk: string) => this.appendLog(chunk));
            child.on('error', (err) => reject(err));
            child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`${display} exited ${code}`));
            });
        });
    }

    private appendLog(chunk: string): void {
        const lines = String(chunk).replace(/\r\n/g, '\n').split('\n');
        for (const line of lines) {
            if (!line) continue;
            this.status.log.push(line);
            this.emit('log', line);
        }
        if (this.status.log.length > LOG_MAX) {
            this.status.log = this.status.log.slice(-LOG_MAX);
        }
        this.emit('status', this.status);
    }

    private setStatus(patch: Partial<UpdaterStatus>): void {
        this.status = { ...this.status, ...patch };
        this.emit('status', this.status);
    }

    private restartTimer(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.config.pollHours <= 0) return;
        if (!this.config.repo) return;
        const ms = this.config.pollHours * 60 * 60 * 1000;
        this.timer = setInterval(() => {
            void this.checkForUpdate().catch(() => {});
        }, ms);
        // Don't keep the event loop alive just for this; allow Genie to
        // quit cleanly without us holding it open.
        this.timer.unref?.();
    }
}

let instance: GitUpdater | null = null;
export function updater(): GitUpdater {
    if (!instance) instance = new GitUpdater();
    return instance;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installRoot(): string {
    // In dev: app.getAppPath() points at <project>/app — one level into the
    // bundled output. The git checkout root is one level up.
    const ap = app.getAppPath();
    // If `app/` has the bundled background.js, climb one level. Otherwise
    // app.getAppPath() already IS the root (production).
    const parent = path.dirname(ap);
    if (
        fs.existsSync(path.join(parent, 'package.json')) &&
        fs.existsSync(path.join(parent, '.git'))
    ) {
        return parent;
    }
    return ap;
}

function isGitCheckout(root: string): boolean {
    try {
        return fs.existsSync(path.join(root, '.git'));
    } catch {
        return false;
    }
}

function readVersion(): string {
    try {
        const pkgPath = path.join(app.getAppPath(), '..', 'package.json');
        const txt = fs.readFileSync(pkgPath, 'utf8');
        const j = JSON.parse(txt) as { version?: string };
        return j.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function stripV(tag: string): string {
    return tag.replace(/^v/i, '');
}

/**
 * Strict-enough semver comparison for our case (x.y.z[-prerelease]).
 * Returns true when `latest` is strictly newer than `current`. Follows
 * semver §11:
 *   - Major, minor, patch compared numerically.
 *   - A version with no pre-release is greater than one with the same
 *     x.y.z and a pre-release.
 *   - Pre-release identifiers are dot-separated; each is compared
 *     numerically if both are numeric, otherwise lexicographically.
 *     Numeric < alphanumeric. Fewer identifiers < more (when prefixes
 *     equal).
 *
 * For unparseable input we conservatively report a mismatch as "newer"
 * — better to surface a maybe-update than swallow it silently.
 */
export function isNewer(latest: string, current: string): boolean {
    const lp = parseSemver(latest);
    const cp = parseSemver(current);
    if (!lp || !cp) return latest !== current;
    for (let i = 0; i < 3; i++) {
        if (lp.parts[i] > cp.parts[i]) return true;
        if (lp.parts[i] < cp.parts[i]) return false;
    }
    // Same x.y.z. Pre-release rules.
    if (lp.pre === null && cp.pre === null) return false;
    if (lp.pre === null && cp.pre !== null) return true; // release > prerelease
    if (lp.pre !== null && cp.pre === null) return false;
    return comparePreRelease(lp.pre as string, cp.pre as string) > 0;
}

function parseSemver(v: string): { parts: [number, number, number]; pre: string | null } | null {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
    if (!m) return null;
    return {
        parts: [Number(m[1]), Number(m[2]), Number(m[3])],
        pre: m[4] ?? null,
    };
}

/**
 * Pre-release identifier comparison per semver §11. Returns 1 if `a` is
 * greater, -1 if smaller, 0 if equal. Dot-split, then per-segment:
 * both numeric → numeric compare; both alphanumeric → string compare;
 * mixed → numeric < alphanumeric. Fewer fields lose ties.
 */
function comparePreRelease(a: string, b: string): number {
    const as = a.split('.');
    const bs = b.split('.');
    const n = Math.max(as.length, bs.length);
    for (let i = 0; i < n; i++) {
        const av = as[i];
        const bv = bs[i];
        if (av === undefined) return -1;
        if (bv === undefined) return 1;
        const aNum = /^\d+$/.test(av);
        const bNum = /^\d+$/.test(bv);
        if (aNum && bNum) {
            const na = Number(av);
            const nb = Number(bv);
            if (na !== nb) return na > nb ? 1 : -1;
            continue;
        }
        if (aNum !== bNum) return aNum ? -1 : 1; // numeric < alphanumeric
        if (av !== bv) return av > bv ? 1 : -1;
    }
    return 0;
}

interface GitHubRelease {
    tag_name: string;
    name?: string;
    body?: string;
    published_at?: string;
    html_url?: string;
    prerelease?: boolean;
    draft?: boolean;
}

async function fetchLatestRelease(repo: string): Promise<GitHubRelease | null> {
    // Try /releases/latest first (excludes drafts and pre-releases). If
    // 404, fall back to /tags which covers projects that haven't created
    // a GitHub Release for their tag yet.
    const releaseRes = await net.fetch(
        `https://api.github.com/repos/${repo}/releases/latest`,
        {
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Genie/0.7 (updater)',
            },
        },
    );
    if (releaseRes.ok) {
        const j = (await releaseRes.json()) as GitHubRelease;
        return j;
    }
    if (releaseRes.status !== 404) {
        const text = await releaseRes.text().catch(() => '');
        throw new Error(
            `GitHub /releases/latest → ${releaseRes.status}: ${text || releaseRes.statusText}`,
        );
    }
    // Fallback to tags
    const tagsRes = await net.fetch(
        `https://api.github.com/repos/${repo}/tags?per_page=1`,
        {
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'Genie/0.7 (updater)',
            },
        },
    );
    if (!tagsRes.ok) {
        const text = await tagsRes.text().catch(() => '');
        throw new Error(
            `GitHub /tags → ${tagsRes.status}: ${text || tagsRes.statusText}`,
        );
    }
    const tags = (await tagsRes.json()) as Array<{ name: string }>;
    if (tags.length === 0) return null;
    return { tag_name: tags[0].name };
}

async function captureHead(cwd: string): Promise<string> {
    const r = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    return r.stdout.trim();
}

function npmCommand(): string {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}
