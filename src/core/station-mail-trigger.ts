/**
 * A FLOW STARTS ON OUTSIDE COMMUNICATION (P9; the owner, 2026-11-25: "outside communications get their own event for sounds
 * and flows"). Pure. Each message that crossed to or from another of the owner's workstations (main/cross-station-host.ts
 * `crossed`) starts the ARMED flows of the local agent's workspace whose `genie/station_mail` trigger it matches: by
 * direction (`in`, `out`, or `any`, the default) and, when the trigger names one, by the other station (its name or its
 * Tynn id). The steps after it get the crossing (`{{in.direction}}`, `{{in.address}}`, `{{in.stationName}}`, ...).
 */

export const STATION_MAIL_KIND = 'genie/station_mail';

/** What a `genie/station_mail` trigger hands the steps after it. */
export interface StationMailProps {
    readonly direction: 'in' | 'out';
    /** The other workstation's Tynn id. */
    readonly station: string;
    readonly stationName: string;
    /** The local agent that sent or received it. */
    readonly agentId: string;
    /** That agent's workspace: only that workspace's flows hear it. */
    readonly workspaceId: string;
    /** The remote agent's full address, `name@workspace@station`. */
    readonly address: string;
    readonly messageId: string;
}

export function matchesStationMailTrigger(config: Record<string, unknown>, event: StationMailProps): boolean {
    const workspace = typeof config.workspace === 'string' ? config.workspace.trim() : '';
    if (workspace !== '' && workspace !== event.workspaceId) return false;
    const direction = config.direction === 'in' || config.direction === 'out' ? config.direction : 'any';
    if (direction !== 'any' && direction !== event.direction) return false;
    const station = typeof config.station === 'string' ? config.station.trim().toLowerCase() : '';
    if (station !== '' && station !== event.station.toLowerCase() && station !== event.stationName.trim().toLowerCase()) return false;
    return true;
}
