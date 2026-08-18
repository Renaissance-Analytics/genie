import type { HostToolName, ToolchainReport } from './toolchain-detect';
import { toolInstallOrigin, type OriginContext, type ToolInstallOrigin } from './tool-install-origin';

/**
 * PURE (+ one injected seam). "Is there a newer version of what's installed?"
 *
 * The Workstation Toolchain & Engine Manager (story #242) shows an
 * update-available badge next to each installed tool/engine. The DECISION —
 * whether a candidate version is actually newer, and folding that across
 * everything present — is pure and lives here; WHERE the candidate comes from (a
 * package manager's outdated list, a language version index, a container
 * registry) is the injected {@link LatestFor} seam, so a machine with no way to
 * reach any of those still produces a sane report.
 *
 * Contract mirrors detection ({@link import('./toolchain-detect')}): a source
 * that fails is "no update known", NEVER a throw — a version check must not be
 * able to crash the panel that renders it.
 */

/** Where a candidate "latest" version was learned. */
export type UpdateSource = 'version-index' | 'package-manager' | 'npm-global' | 'registry' | 'unknown';

export interface ToolUpdate {
    name: HostToolName;
    /** The installed version, when detection could read one. */
    installed?: string;
    /** The newest available version, when a source knew one. */
    latest?: string;
    /** True only when {@link latest} is strictly newer than {@link installed}. */
    updateAvailable: boolean;
    source: UpdateSource;
    /** WHO installed it and WHERE, when the binary's path could be resolved
     *  (genie#213). Distinct from {@link source}, which says where the LATEST
     *  version number was learned — the two answer different questions and the
     *  names are close enough to be worth stating. Absent when nothing resolved:
     *  the row then says less rather than guessing. */
    origin?: ToolInstallOrigin;
}

/** The seam: given a tool (and its installed version, so a source can
 *  short-circuit), what is the newest available version and where from — or null
 *  when nothing could be learned. */
export type LatestFor = (
    tool: HostToolName,
    installed?: string,
) => Promise<{ version?: string; source?: UpdateSource } | null>;

/** The numeric segments of a version, ignoring a leading `v` and any prose
 *  around the first dotted-number run (`PHP 8.3.2` → `[8,3,2]`). */
function segments(v: string): number[] {
    const match = v.match(/\d+(?:\.\d+)*/);
    return match ? match[0].split('.').map((n) => Number(n)) : [];
}

/**
 * Order two versions: -1 a<b, 0 equal, 1 a>b. Numeric per segment (so `20.11`
 * beats `20.9`), a missing trailing segment counts as zero (`8.3` == `8.3.0`),
 * and an unparseable version sorts BELOW a real one (its empty segment list
 * reads as all-zeros, and `0.0.0 < 1.0.0`).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
    const A = segments(a);
    const B = segments(b);
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) {
        const x = A[i] ?? 0;
        const y = B[i] ?? 0;
        if (x < y) return -1;
        if (x > y) return 1;
    }
    return 0;
}

/** True only when `latest` is strictly newer than `installed`. Unknown on either
 *  side ⇒ false — a version check never GUESSES an update. */
export function isUpdateAvailable(installed: string | undefined, latest: string | undefined): boolean {
    if (!installed || !latest) return false;
    return compareVersions(latest, installed) > 0;
}

/**
 * Fold the detection report + a latest-source into a per-tool update report.
 *
 * Only INSTALLED tools appear — a missing tool is the install wizard's job (#240),
 * not this manager's. Each present tool is asked of the source (which may fail or
 * answer null); the outcome is a clean `{ installed, latest?, updateAvailable,
 * source }`. Serial, because the set is tiny and the source is often a process.
 */
export async function detectToolUpdates(
    report: ToolchainReport,
    latestFor: LatestFor,
    origin?: OriginContext,
): Promise<ToolUpdate[]> {
    const updates: ToolUpdate[] = [];
    for (const probe of report.probes) {
        if (!probe.installed) continue;

        let latest: string | undefined;
        let source: UpdateSource = 'unknown';
        try {
            const answer = await latestFor(probe.name, probe.version);
            if (answer) {
                latest = answer.version;
                source = answer.source ?? 'unknown';
            }
        } catch {
            // A failed lookup is "no update known", never a crash.
        }

        // Pure, and only when there is a path to read: no probing, no
        // filesystem, nothing that can fail here.
        const installOrigin = origin && probe.path ? toolInstallOrigin(probe.path, origin) : undefined;

        updates.push({
            name: probe.name,
            ...(probe.version ? { installed: probe.version } : {}),
            ...(latest ? { latest } : {}),
            updateAvailable: isUpdateAvailable(probe.version, latest),
            source,
            ...(installOrigin ? { origin: installOrigin } : {}),
        });
    }
    return updates;
}

// --- when to re-scan (#242 P4) ----------------------------------------------

/** How long an update scan's answer stays good enough to reuse. */
export const TOOLCHAIN_UPDATE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface ToolchainCheckState {
    /** Epoch ms of the last completed scan, or null if never. */
    lastCheckedAt: number | null;
    /** Now (epoch ms). */
    now: number;
    /** How old an answer may be before it is re-scanned. */
    maxAgeMs?: number;
    /** The user asked explicitly (a Refresh button) — always scan. */
    force?: boolean;
}

/**
 * PURE. Is it time to run an update scan?
 *
 * A scan shells out to `winget upgrade` / `brew outdated` / `npm outdated -g`:
 * slow, and it touches the network. Running one on every settings-page open
 * would make the page feel broken and hammer three package managers for an
 * answer that changes maybe daily. Sitting on a week-old answer is the opposite
 * failure — a badge that never appears.
 *
 * This is NOT a poll ([[feedback_no_polling_prefer_push]]): nothing runs on a
 * timer. The question is asked when something ALREADY happened — a panel opened,
 * an install finished — and this decides whether that moment does the work.
 *
 * A `lastCheckedAt` in the FUTURE (a resumed laptop, a corrected clock) counts
 * as stale rather than fresh, so a bad timestamp can never freeze the badge
 * permanently.
 */
export function shouldCheckToolchainUpdates(s: ToolchainCheckState): boolean {
    if (s.force) return true;
    if (s.lastCheckedAt == null) return true;
    const age = s.now - s.lastCheckedAt;
    if (age < 0) return true;
    return age >= (s.maxAgeMs ?? TOOLCHAIN_UPDATE_MAX_AGE_MS);
}
