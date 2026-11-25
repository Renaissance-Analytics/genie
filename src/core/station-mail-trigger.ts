/** RED STUB (P9 outside communication, the flow trigger): the shapes the tests name; nothing is built yet. */
export const STATION_MAIL_KIND = 'genie/station_mail';
export interface StationMailProps {
    readonly direction: 'in' | 'out';
    readonly station: string;
    readonly stationName: string;
    readonly agentId: string;
    readonly workspaceId: string;
    readonly address: string;
    readonly messageId: string;
}
export function matchesStationMailTrigger(_config: Record<string, unknown>, _event: StationMailProps): boolean {
    throw new Error('not built');
}
