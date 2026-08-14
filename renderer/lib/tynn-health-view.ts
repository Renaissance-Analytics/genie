import type { HealthTone, TynnHealth } from '../../main/mcp/tynn-health';

/**
 * How the Tynn MCP health probe READS — the tint on the sidebar logo, the
 * one-line summary, and the rows the hover popover lists.
 *
 * All of it is pure and lives here rather than in `master.tsx` because the
 * renderer has no jsdom harness: React components cannot be unit-tested in this
 * repo, so anything that DECIDES something has to be a plain function or it
 * ships untested. The component's only job is to render what these return.
 *
 * The one rule the summary encodes: **never say "error"**. The incident that
 * motivated this indicator (`http://` → 301 → the POST becomes a GET →
 * laravel/mcp answers 405 → every agent in the workspace is toolless) was
 * invisible precisely because the only thing anybody saw was a bare status
 * code. So the summary always carries the FAILING row's own label, which
 * `main/mcp/tynn-health.ts` writes to name the cause.
 */

export const TYNN_HEALTH_ROW_TITLES = {
    transport: 'Endpoint',
    auth: 'Token',
    permission: 'Permissions',
} as const;

export type TynnHealthRowKey = keyof typeof TYNN_HEALTH_ROW_TITLES;

export interface TynnHealthViewRow {
    key: TynnHealthRowKey;
    title: string;
    /** The glanceable status for this row. */
    label: string;
    /** The cause AND the fix. */
    detail: string;
    tone: HealthTone;
    /** Only ever populated on the permission row. */
    tools: string[];
}

/**
 * The tint for the logo. `checking` and "never probed" are BOTH idle: a probe
 * in flight must not be painted green, or a broken workspace looks healthy for
 * as long as the request takes.
 */
export function tynnHealthTone(health: TynnHealth | null, checking = false): HealthTone {
    // A re-check deliberately HOLDS the last known tint (`checking` is not a
    // tone of its own): going grey for the duration of the request reads as
    // "it fixed itself" on a workspace that is still broken. The summary below
    // is what says a probe is in flight.
    void checking;
    if (!health) return 'idle';
    switch (health.state) {
        case 'healthy':
            return 'ok';
        case 'degraded':
            return 'warn';
        case 'broken':
            return 'bad';
        default:
            // unconfigured / checking — nothing is known to be wrong, and
            // nothing is known to be right.
            return 'idle';
    }
}

/** The first row with something to report, in the order failures cascade. */
function firstProblem(health: TynnHealth): TynnHealthViewRow | null {
    return tynnHealthRows(health).find((row) => row.tone === 'bad' || row.tone === 'warn') ?? null;
}

/**
 * The title/aria line on the logo. On a healthy workspace it is the tool count;
 * on any unhealthy one it is the failing row's own cause-naming label, so the
 * tooltip ALONE is enough to diagnose the workspace without opening anything.
 */
export function tynnHealthSummary(health: TynnHealth | null, checking = false): string {
    if (checking) return 'Tynn — checking…';
    if (!health) return 'Tynn — not checked yet';
    if (health.state === 'checking') return 'Tynn — checking…';
    if (health.state === 'unconfigured') return `Tynn — ${health.transport.label}`;
    const problem = firstProblem(health);
    return `Tynn — ${problem ? problem.label : health.permission.label}`;
}

/** The three rows the popover lists, in the order a failure cascades through them. */
export function tynnHealthRows(health: TynnHealth | null): TynnHealthViewRow[] {
    if (!health) return [];
    return [
        {
            key: 'transport',
            title: TYNN_HEALTH_ROW_TITLES.transport,
            label: health.transport.label,
            detail: health.transport.detail,
            tone: health.transport.tone,
            tools: [],
        },
        {
            key: 'auth',
            title: TYNN_HEALTH_ROW_TITLES.auth,
            label: health.auth.label,
            detail: health.auth.detail,
            tone: health.auth.tone,
            tools: [],
        },
        {
            key: 'permission',
            title: TYNN_HEALTH_ROW_TITLES.permission,
            label: health.permission.label,
            detail: health.permission.detail,
            tone: health.permission.tone,
            tools: health.permission.tools,
        },
    ];
}

/**
 * Tone → the Fancy `Badge` colour that paints it. Here rather than inline in the
 * component so the component holds no judgement at all, and so "a problem never
 * comes out green" is a thing a test can assert.
 */
export function tynnToneBadgeColor(tone: HealthTone): 'emerald' | 'amber' | 'rose' | 'zinc' {
    switch (tone) {
        case 'ok':
            return 'emerald';
        case 'warn':
            return 'amber';
        case 'bad':
            return 'rose';
        default:
            return 'zinc';
    }
}

/** The tool list, capped — the full set is in the permission row's detail. */
export function tynnToolsPreview(tools: string[], max = 6): string {
    if (!tools.length) return 'none';
    if (tools.length <= max) return tools.join(', ');
    return `${tools.slice(0, max).join(', ')} +${tools.length - max} more`;
}
