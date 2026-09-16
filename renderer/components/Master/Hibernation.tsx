/**
 * A HIBERNATING workspace, drawn (genie#672).
 *
 * The owner: "A Hibernated workspace is styled grey with a set of 3 zzz in front
 * of the agent avatar with each z a little bigger in size."
 */

/** Three z's, each a little bigger. `busy` while it is still going to sleep. */
export function HibernationZzz({ busy = false }: { busy?: boolean }) {
    return (
        <span
            className={`ws-zzz${busy ? ' is-busy' : ''}`}
            role="img"
            aria-label={busy ? 'Going to sleep' : 'Hibernating'}
        >
            <span aria-hidden>z</span>
            <span aria-hidden>z</span>
            <span aria-hidden>z</span>
        </span>
    );
}

/**
 * The floor of a hibernating workspace: what it is, and the way to wake it.
 * Stands where the empty workspace's Add tiles would, so the panels of every
 * other workspace stay mounted behind it.
 */
export function HibernatedFloor({
    name,
    waking,
    onWake,
}: {
    name: string;
    waking: boolean;
    onWake: () => void;
}) {
    return (
        <div className="addtile-overlay">
            <div className="hibernated-floor" role="status">
                <HibernationZzz busy={waking} />
                <span className="hibernated-floor-title">{name} is hibernating</span>
                <span className="hibernated-floor-body">
                    Every terminal, agent, process, site and service in it is stopped, and it
                    stays asleep through restarts and upgrades until you wake it.
                </span>
                <button type="button" className="gbtn accent" onClick={onWake} disabled={waking}>
                    {waking ? 'Waking…' : 'Wake workspace'}
                </button>
            </div>
        </div>
    );
}
