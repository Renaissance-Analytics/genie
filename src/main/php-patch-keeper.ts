import type { DeckItem } from '../core/deck.js';
import { phpAdvisoryText, phpVersionRisk } from '../core/php-advisories.js';
import { PHP_PATCH_DECK_PREFIX, catalogLine, lineOf, type PhpCatalog } from '../core/php-releases.js';
import { compareVersionsDesc, type ManagedPhp } from '../core/php-versions.js';
import type { PhpInstallOutcome } from './php-versions.js';

/**
 * EVERY INSTALLED PHP ON THE NEWEST PATCH OF ITS LINE (Tynn #1066, hotfix).
 *
 * The owner, 2026-11-26: "we don't want critical security updates being held behind genie upgrades … it's the 8.4.x and
 * other updates in that line that need to be updated". Against php.net's live catalog (core/php-releases.ts), for each
 * LINE Genie has a PHP of (8.4.27 → 8.4.x; never 8.5 unless the person chooses it):
 *
 * - a SECURITY release above the newest installed patch — that patch is under the floor (core/php-advisories.ts: the
 *   baked PHP2Shell table or php.net's newest security release) — installs BY ITSELF with Genie's own checksum-verified
 *   installer; `current/php` moves to it when it was on that line; every RUNNING site on that line (pinned to it, or
 *   unpinned while the default moved) is restarted onto it (a pin keeps its line: core/php-versions.ts pickPinned); and
 *   the person (a Deck item) and the agents of every workspace with a site on it (mail) are told. A site that would not
 *   restart is named with why, for the person to restart.
 * - a patch that is NOT a security release is OFFERED: the Toolchain lists it beside the installed one (its patch button),
 *   and nothing installs.
 *
 * The old patch is kept: Remove is the person's. Offline, the catalog is the baked list and there is nothing to do.
 */

export interface PhpPatchSite {
    readonly id: string;
    readonly name: string;
    readonly host: string;
    readonly workspaceId: string;
    /** The site's PHP pin; `null` = it runs the PHP on PATH (Genie's `current/php` when that is set). */
    readonly pin: string | null;
    /** Being served now (a stopped site is not started by an update). */
    readonly running: boolean;
}

export interface PhpPatchPorts {
    /** php.net's catalog, refreshed (main/php-release-feed.ts); never rejects. */
    refresh(): Promise<PhpCatalog>;
    managed(): readonly ManagedPhp[];
    install(version: string, progress: (step: string | null) => void): Promise<PhpInstallOutcome>;
    /** The version `current/php` points at, or `null`. */
    defaultVersion(): string | null;
    setDefault(version: string): { readonly kind: 'set' | 'cleared' } | { readonly kind: 'refused'; readonly reason: string };
    /** The php sites. */
    sites(): readonly PhpPatchSite[];
    /** Restart a site onto the new patch. Absent (host start: nothing is running yet) = no restarts. */
    restartSite?(siteId: string): Promise<void>;
    /** The person's Deck items. */
    readonly notices: PhpPatchNotices;
    /** Mail the agents of a workspace. */
    tellAgents(workspaceId: string, subject: string, text: string): Promise<void>;
    log?(line: string): void;
}

export interface PhpPatchResult {
    /** Security patches installed. */
    readonly updated: string[];
    readonly failed: Array<{ version: string; reason: string }>;
    /** Newer patches that are not security releases: offered, not installed. */
    readonly offered: string[];
}

const sentence = (text: string): string => text.replace(/[. ]+$/, '');

/** One pass. Never rejects: every failure is in `failed`, on the Deck, and in the log. */
export async function applyDuePhpUpdates(ports: PhpPatchPorts, progress: (step: string | null) => void): Promise<PhpPatchResult> {
    const result: PhpPatchResult = { updated: [], failed: [], offered: [] };
    let catalog: PhpCatalog;
    try {
        catalog = await ports.refresh();
    } catch {
        return result;
    }
    const managed = ports.managed();
    const lines = [...new Set(managed.map((m) => lineOf(m.version)))];
    for (const line of lines) {
        const target = catalogLine(catalog, line)?.newest ?? null;
        const have = managed.filter((m) => lineOf(m.version) === line).map((m) => m.version).sort(compareVersionsDesc)[0]!;
        if (target === null || compareVersionsDesc(target, have) >= 0) continue;
        if (phpVersionRisk(have, catalog).risk !== 'vulnerable') {
            result.offered.push(target);
            continue;
        }
        try {
            await securityPatch(ports, catalog, line, have, target, progress, result);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            result.failed.push({ version: target, reason });
            ports.log?.(`php updates: PHP ${target} failed: ${reason}`);
        } finally {
            progress(null);
        }
    }
    return result;
}

async function securityPatch(ports: PhpPatchPorts, catalog: PhpCatalog, line: string, have: string, target: string, progress: (step: string | null) => void, result: PhpPatchResult): Promise<void> {
    const why = phpAdvisoryText(have, catalog) ?? `PHP ${have} is below php.net's newest security release of ${line}`;
    progress(`PHP ${target}: installing the security release for ${have}`);
    ports.log?.(`php updates: ${why}; installing PHP ${target}`);
    const outcome = await ports.install(target, progress);
    if (outcome.kind === 'refused' || outcome.kind === 'not-installed') {
        result.failed.push({ version: target, reason: outcome.reason });
        ports.notices.put({ version: target, line, replaced: have, why, failed: outcome.reason, restarted: [], notRestarted: [], sitesOnLine: [] });
        ports.log?.(`php updates: PHP ${target} was not installed: ${outcome.reason}`);
        return;
    }
    result.updated.push(target);
    const before = ports.defaultVersion();
    let defaultMoved = false;
    if (before !== null && lineOf(before) === line && before !== target) {
        progress(`PHP ${target}: making it Genie's default PHP`);
        const set = ports.setDefault(target);
        defaultMoved = set.kind === 'set';
        if (set.kind === 'refused') ports.log?.(`php updates: PHP ${target} could not be made the default: ${set.reason}`);
    }
    // On this line: pinned to it or to a patch of it (`8.4`, `8.4.27`), or unpinned while `current/php` moved onto it.
    const onLine = ports.sites().filter((s) => (s.pin !== null && s.pin !== '' ? lineOf(s.pin) === line : defaultMoved));
    const restarted: string[] = [];
    const notRestarted: Array<{ host: string; reason: string }> = [];
    for (const s of onLine.filter((x) => x.running)) {
        if (!ports.restartSite) continue;
        progress(`PHP ${target}: restarting ${s.host}`);
        try {
            await ports.restartSite(s.id);
            restarted.push(s.host);
        } catch (error) {
            notRestarted.push({ host: s.host, reason: sentence(error instanceof Error ? error.message : String(error)) });
        }
    }
    const notice: PhpPatchNotice = { version: target, line, replaced: have, why, restarted, notRestarted, sitesOnLine: onLine.map((s) => s.host) };
    ports.notices.put(notice);
    ports.log?.(`php updates: PHP ${target} installed (security); restarted ${restarted.join(', ') || 'none'}${notRestarted.length ? `; not restarted ${notRestarted.map((n) => n.host).join(', ')}` : ''}`);
    for (const workspaceId of [...new Set(onLine.map((s) => s.workspaceId))]) {
        const hosts = onLine.filter((s) => s.workspaceId === workspaceId).map((s) => s.host);
        await ports.tellAgents(workspaceId, `PHP ${target} security update`, agentText(notice, hosts)).catch((error: unknown) => {
            ports.log?.(`php updates: the agents of ${workspaceId} could not be told: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
}

function agentText(n: PhpPatchNotice, hosts: readonly string[]): string {
    const restarted = hosts.filter((h) => n.restarted.includes(h));
    const failed = n.notRestarted.filter((r) => hosts.includes(r.host));
    return [
        `Genie installed PHP ${n.version}, a php.net security release, in place of PHP ${n.replaced} (${sentence(n.why)}).`,
        `Sites in this workspace on PHP ${n.line}: ${hosts.join(', ')}.`,
        restarted.length > 0 ? `Restarted onto ${n.version}: ${restarted.join(', ')}.` : 'None of them was running, so none was restarted; they start on it.',
        ...failed.map((f) => `${f.host} could not be restarted (${f.reason}); restart it with the sites tool.`),
    ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// The person's Deck items.

export { PHP_PATCH_DECK_PREFIX };

export interface PhpPatchNotice {
    readonly version: string;
    readonly line: string;
    readonly replaced: string;
    readonly why: string;
    /** Set when the install failed: why. */
    readonly failed?: string;
    readonly restarted: readonly string[];
    readonly notRestarted: ReadonlyArray<{ readonly host: string; readonly reason: string }>;
    readonly sitesOnLine: readonly string[];
}

/** One item per line, the latest pass's; Dismiss takes it away. */
export class PhpPatchNotices {
    readonly #now: () => number;
    readonly #items = new Map<string, PhpPatchNotice & { readonly at: number }>();
    readonly #listeners = new Set<() => void>();

    constructor(now: () => number) {
        this.#now = now;
    }

    put(notice: PhpPatchNotice): void {
        this.#items.set(notice.line, { ...notice, at: this.#now() });
        this.#changed();
    }

    items(): DeckItem[] {
        return [...this.#items.values()].map((n) => ({
            id: `${PHP_PATCH_DECK_PREFIX}${n.line}`,
            source: 'genie',
            agentId: null,
            agentName: null,
            workspaceId: null,
            title: n.failed !== undefined ? `Genie could not install PHP ${n.version}, a security release` : `PHP ${n.version} installed: a security release`,
            blocking: false,
            priority: n.failed !== undefined ? 'high' : 'normal',
            at: n.at,
            answer: { kind: 'inline', options: [{ id: 'dismiss', label: 'Dismiss', tone: 'neutral' }] },
            forwardedFrom: null,
            detail: noticeDetail(n),
        }));
    }

    dismiss(id: string): boolean {
        if (!id.startsWith(PHP_PATCH_DECK_PREFIX)) return false;
        const gone = this.#items.delete(id.slice(PHP_PATCH_DECK_PREFIX.length));
        if (gone) this.#changed();
        return gone;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        for (const listener of [...this.#listeners]) {
            try {
                listener();
            } catch {
                // a listener's failure is its own
            }
        }
    }
}

function noticeDetail(n: PhpPatchNotice): string {
    if (n.failed !== undefined) return `${sentence(n.why)}. Installing PHP ${n.version} failed: ${sentence(n.failed)}. Genie tries again on its next check; Toolchain → PHP installs it by hand.`;
    return [
        `${sentence(n.why.replace(/; update to [0-9.]+$/, ''))}. Genie installed PHP ${n.version} by itself; PHP ${n.replaced} is still installed until you remove it.`,
        n.restarted.length > 0 ? `Restarted onto it: ${n.restarted.join(', ')}.` : n.sitesOnLine.length > 0 ? `Sites on PHP ${n.line} (${n.sitesOnLine.join(', ')}) start on it next time.` : '',
        ...n.notRestarted.map((r) => `${r.host} could not be restarted: ${r.reason}. Restart it in Hosting.`),
    ].filter(Boolean).join(' ');
}
