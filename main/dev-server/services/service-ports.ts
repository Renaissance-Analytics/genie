import { createHash } from 'node:crypto';

/**
 * PURE. WHICH HOST PORT A WORKSPACE'S SERVICE ANSWERS ON — and why it does not
 * move.
 *
 * ## The defect this closes
 *
 * Engine containers were published with no host port (`{ container, hostIp }`),
 * which asks the runtime for "anything free". Docker obliges, and picks a NEW
 * number every time the container is created — which a Genie restart, an app
 * update and the adoption-repair path all do. So a workspace's Postgres wandered:
 * 51157 one day, 58377 the next.
 *
 * genie#242 responded by rewriting the repo's `.env` whenever the number moved.
 * That is necessary but it is not the fix, because it is a RACE — between the
 * moment the port moves and the moment every consumer has been rewritten and
 * re-read, everything still points at a dead socket. Five agents hit exactly that
 * window in one week. The address has to stop moving.
 *
 * ## How the number is chosen
 *
 * **Derived first, then remembered.**
 *
 * The derivation ({@link preferredServicePort}) is a hash of the engine record and
 * the surface name, so a fresh machine, a reinstall, or a database Genie has
 * forgotten still asks for the same port — nothing has to be stored for the common
 * case to be stable. This is the same reasoning `exposure.ts` gives for a site's
 * raw-protocol forwards, and the same reasoning behind every derived container
 * name in this module.
 *
 * Derivation alone is not enough, though, and the gap matters: if the preferred
 * port is occupied by something unrelated we must use another one, and a purely
 * derived scheme would then hop BACK the day that squatter goes away — a move, and
 * exactly what this exists to prevent. So the port actually used is persisted, and
 * {@link planServicePorts} re-requests the remembered one ahead of the derived one.
 *
 * **A fallback is deterministic and audible.** When the wanted port is taken, the
 * search walks forward from the derived seed rather than grabbing an ephemeral
 * port, so the same blockage produces the same answer twice; and the move is
 * reported as a note rather than absorbed, because a silent fallback is how a
 * stable port quietly stops being stable.
 *
 * **Last resort still starts the engine.** If nothing in the range can be bound,
 * the assignment carries no host port at all and the runtime picks — the old
 * behaviour, which is worse but is not an outage. The note says so.
 */

/**
 * Where a service's published port is drawn from.
 *
 * Deliberately NOT the ephemeral range (49152+), which the OS hands out to
 * OUTBOUND connections — a fixed port in there gets stolen by an unrelated socket
 * and the failure looks like Genie's. Deliberately ABOVE `exposure.ts`'s
 * 20000–29999 site forwards, so a site surface and an engine can never be handed
 * the same number by two schemes that do not know about each other.
 */
export const SERVICE_PORT_RANGE = { min: 30000, max: 39999 } as const;

/** How far the deterministic search walks before giving up. Bounded so a machine
 *  with a pathological port map cannot make an engine acquire hang. */
const MAX_PROBES = 64;

/** A published surface of an engine: its name in the catalog spec, and the port it
 *  listens on INSIDE the container. */
export interface ServicePortRequest {
    name: string;
    container: number;
}

export interface ServicePortAssignment {
    name: string;
    container: number;
    /** The host port to publish on. ABSENT ⇒ let the runtime choose (last resort;
     *  a note always accompanies it). */
    host?: number;
}

export interface ServicePortPlanInput {
    /** The engine record — `engineKeyFor(engine, version)`, plus `@workspaceId`
     *  for a dedicated one. The unit a container, a volume and an admin
     *  credential are already keyed by. */
    recordKey: string;
    ports: readonly ServicePortRequest[];
    /** What this engine was published on last time, by surface name. */
    reserved: Readonly<Record<string, number>>;
    /** Can this host port be bound right now? */
    isFree: (port: number) => Promise<boolean>;
}

export interface ServicePortPlan {
    assignments: ServicePortAssignment[];
    /** Every departure from the port that was wanted, in words. Empty is the
     *  normal case and means nothing moved. */
    notes: string[];
}

/**
 * The port this engine surface WANTS, absent any history.
 *
 * Derived rather than allocated so it is the same number after a restart, an app
 * update, a reboot and a reinstall, with nothing stored.
 */
export function preferredServicePort(recordKey: string, surfaceName: string): number {
    const digest = createHash('sha256').update(`${recordKey}\0${surfaceName}`).digest();
    const span = SERVICE_PORT_RANGE.max - SERVICE_PORT_RANGE.min + 1;
    return SERVICE_PORT_RANGE.min + (digest.readUInt32BE(0) % span);
}

/** Step `n` ports forward from `seed`, wrapping inside the range. */
function walk(seed: number, n: number): number {
    const span = SERVICE_PORT_RANGE.max - SERVICE_PORT_RANGE.min + 1;
    return SERVICE_PORT_RANGE.min + ((seed - SERVICE_PORT_RANGE.min + n) % span);
}

/**
 * Decide what each of an engine's surfaces publishes on.
 *
 * Preference order per surface: the port it was given last time, then the derived
 * one, then a deterministic walk forward from the derived seed, then nothing (the
 * runtime chooses). See the file header for why that order.
 */
export async function planServicePorts(input: ServicePortPlanInput): Promise<ServicePortPlan> {
    const assignments: ServicePortAssignment[] = [];
    const notes: string[] = [];
    // Two surfaces of one engine must not be handed the same number — which a
    // stale reservation can otherwise do.
    const claimed = new Set<number>();

    for (const port of input.ports) {
        const derived = preferredServicePort(input.recordKey, port.name);
        const remembered = input.reserved[port.name];
        const wanted = Number.isInteger(remembered) ? (remembered as number) : derived;

        let chosen: number | undefined;
        if (!claimed.has(wanted) && (await input.isFree(wanted))) {
            chosen = wanted;
        } else {
            // Deterministic search from the DERIVED seed (not from `wanted`), so
            // the same blockage always produces the same answer.
            for (let step = 0; step < MAX_PROBES; step++) {
                const candidate = walk(derived, step);
                if (candidate === wanted || claimed.has(candidate)) continue;
                if (await input.isFree(candidate)) {
                    chosen = candidate;
                    break;
                }
            }
            if (chosen === undefined) {
                notes.push(
                    `${port.name}: port ${wanted} is in use and no port in ${SERVICE_PORT_RANGE.min}–${SERVICE_PORT_RANGE.max} could be bound, so this surface got an EPHEMERAL port that will move again on the next restart.`,
                );
            } else {
                notes.push(
                    `${port.name}: port ${wanted} is in use by something else, so this engine moved to ${chosen}. It will stay there.`,
                );
            }
        }

        if (chosen !== undefined) claimed.add(chosen);
        assignments.push({
            name: port.name,
            container: port.container,
            ...(chosen === undefined ? {} : { host: chosen }),
        });
    }

    return { assignments, notes };
}
