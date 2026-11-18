/**
 * PRESSING A TAB OF THE WORKSPACE STRIP without a DOM: the strip is react-fancy Tabs inside the one bar (TopBar.tsx), and
 * pressing a tab is that Tabs' onTabChange with the tab's value. Found by walking the element tree the strip returns, so a
 * change of wrapper (the bar, a fragment) does not break the tests that press tabs.
 */
export function stripPick(node: unknown): (value: string) => void {
    const found = findTabs(node);
    if (!found) throw new Error('no react-fancy Tabs (onTabChange) in the strip');
    return found.props['onTabChange'] as (value: string) => void;
}

function findTabs(node: unknown): { props: Record<string, unknown> } | null {
    if (!node || typeof node !== 'object') return null;
    const el = node as { props?: Record<string, unknown> };
    if (typeof el.props?.['onTabChange'] === 'function') return el as { props: Record<string, unknown> };
    const kids = el.props?.['children'];
    for (const k of Array.isArray(kids) ? kids.flat(8) : [kids]) {
        const hit = findTabs(k);
        if (hit) return hit;
    }
    return null;
}
