/**
 * WHEN Genie re-reads a marketplace index.
 *
 * A marketplace's plugin list is a CACHE: `addMarketplace` clones the repo once
 * and stores the parsed index in `plugin_marketplaces.manifest_json`. Everything
 * that lists members afterwards reads that cache, so a plugin PUBLISHED to the
 * marketplace after you added it stays invisible until something re-clones —
 * which, before this module, only ever happened if you found the per-marketplace
 * Refresh button.
 *
 * The policy here is event-driven, never a timer: the Marketplaces tab asks for
 * a refresh when it is OPENED, and this decides which indexes are old enough to
 * be worth a network round-trip. PURE (no db / git / Electron) so the staleness
 * rule is unit-testable on its own.
 */

/**
 * How long a cached index is considered current. Opening the Marketplaces tab
 * twice in a row should not re-clone every repo; leaving it and coming back
 * later should.
 */
export const MARKETPLACE_STALE_MS = 5 * 60_000;

/** The freshness fields this decision needs off a `plugin_marketplaces` row. */
export interface MarketplaceFreshness {
    id: string;
    /** ISO timestamp of the last successful index read. */
    updated_at: string;
    /** The cached index, or null when one was never stored. */
    manifest_json: string | null;
}

/**
 * Which marketplaces should be re-fetched now. A marketplace with no cached
 * index at all, or an unreadable timestamp, is ALWAYS refetched — the failure
 * mode to avoid is a row that can never look stale and so never updates again.
 * Pass `maxAgeMs: 0` for an explicit "Refresh all" (everything is stale).
 */
export function marketplacesNeedingRefresh(
    rows: readonly MarketplaceFreshness[],
    nowMs: number,
    maxAgeMs: number = MARKETPLACE_STALE_MS,
): string[] {
    return rows
        .filter((row) => {
            if (!row.manifest_json) return true;
            const checkedAt = Date.parse(row.updated_at);
            if (!Number.isFinite(checkedAt)) return true;
            return nowMs - checkedAt >= maxAgeMs;
        })
        .map((row) => row.id);
}
