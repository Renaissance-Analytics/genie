import type { ReactNode } from 'react';
import { Badge, Popover, Text } from '@particle-academy/react-fancy';
import type { TynnHealth } from '../../lib/genie';
import {
    tynnHealthRows,
    tynnHealthSummary,
    tynnHealthTone,
    tynnToneBadgeColor,
    tynnToolsPreview,
} from '../../lib/tynn-health-view';

/**
 * The Tynn MCP health light, worn by the Genie logo at the top of the workspace
 * sidebar.
 *
 * ## Why it exists
 *
 * A workspace's `.mcp.json` once carried `http://tynn.ai/mcp/tynn` rather than
 * `https://`. Plain http answers 301; an MCP client follows the redirect, which
 * turns the POST into a GET, which `laravel/mcp` answers with a hardcoded 405.
 * Every agent in that workspace was silently toolless, and the ONLY thing the
 * user ever saw was "error 405" inside a terminal they weren't looking at.
 * Genie showed nothing.
 *
 * So this is not a status light that says "error". Hovering it names the cause
 * and the fix, for each of the three separate things that can be wrong:
 * the endpoint, the token, and the permission surface (`tools/list` — literally
 * what this token may call).
 *
 * ## Contract
 *
 * Every decision — the tint, the summary line, the rows, the badge colour — is
 * a pure function in `lib/tynn-health-view.ts`. This file only renders them.
 * That split is not stylistic: the renderer has no jsdom harness, so a decision
 * left in here is a decision that ships untested.
 *
 * Hover and placement are Fancy's `Popover` (`hover`, with its own open/close
 * grace), not a hand-rolled timer or a hand-rolled anchor. CLICKING re-probes —
 * with `hover` the trigger's own onClick is unbound, so the click belongs to us.
 * Nothing here polls; a fresh result also arrives pushed, via
 * `on.tynnHealthUpdate`.
 */
export default function TynnHealthIndicator({
    health,
    checking,
    onRecheck,
    children,
}: {
    /** The last probe, or null when this workspace has never been probed. */
    health: TynnHealth | null;
    /** A probe is in flight — the tint HOLDS, only the wording changes. */
    checking: boolean;
    /** Re-probe this workspace (read-only: initialize + tools/list). */
    onRecheck: () => void;
    /** The logo this indicator dresses. */
    children: ReactNode;
}) {
    const tone = tynnHealthTone(health, checking);
    const summary = tynnHealthSummary(health, checking);
    const rows = tynnHealthRows(health);

    return (
        <Popover placement="bottom-start" offset={10} hover hoverDelay={120} hoverCloseDelay={220}>
            <Popover.Trigger
                className={`tynn-health tynn-health-${tone}${checking ? ' is-checking' : ''}`}
                aria-label={summary}
                title={summary}
            >
                <span
                    role="button"
                    tabIndex={0}
                    className="tynn-health-hit"
                    onClick={onRecheck}
                    onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        onRecheck();
                    }}
                >
                    {children}
                    <span className="tynn-health-dot" aria-hidden="true" />
                </span>
            </Popover.Trigger>
            <Popover.Content
                className="tynn-health-pop"
                role="status"
                aria-label="Tynn MCP health"
            >
                <div className="thp-head">
                    <Text size="sm" weight="semibold">
                        Tynn MCP
                    </Text>
                    <Badge size="sm" variant="soft" dot color={tynnToneBadgeColor(tone)}>
                        {checking ? 'checking' : (health?.state ?? 'unknown')}
                    </Badge>
                </div>
                <Text as="div" size="xs" color="muted" className="thp-where">
                    {health?.workspaceName ?? 'This workspace'}
                    {health?.url ? ` · ${health.url}` : ''}
                </Text>

                {rows.length === 0 ? (
                    <Text as="p" size="xs" color="muted" className="thp-empty">
                        Not probed yet. Click the logo to check this workspace&rsquo;s Tynn MCP.
                    </Text>
                ) : (
                    <ul className="thp-rows">
                        {rows.map((row) => (
                            <li key={row.key} className={`thp-row thp-${row.tone}`}>
                                <div className="thp-row-head">
                                    <span className="thp-row-dot" aria-hidden="true" />
                                    <Text size="xs" weight="medium" className="thp-row-title">
                                        {row.title}
                                    </Text>
                                    <Text size="xs" color="muted" className="thp-row-label">
                                        {row.label}
                                    </Text>
                                </div>
                                {/* The cause AND the fix — the reason this popover
                                    exists at all. Never trimmed to a status code. */}
                                <Text as="p" size="xs" color="muted" className="thp-row-detail">
                                    {row.detail}
                                </Text>
                                {row.key === 'permission' && row.tools.length > 0 && (
                                    <Text as="p" size="xs" color="muted" className="thp-tools">
                                        {tynnToolsPreview(row.tools)}
                                    </Text>
                                )}
                            </li>
                        ))}
                    </ul>
                )}

                <Text as="div" size="xs" color="muted" className="thp-foot">
                    {checking ? 'Checking…' : 'Click the logo to re-check.'}
                </Text>
            </Popover.Content>
        </Popover>
    );
}
