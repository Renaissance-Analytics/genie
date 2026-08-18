/**
 * E2E fixture for the AgentPulse sparkline's paint order (genie#197).
 *
 * Seeds ONE workspace for the harness page to render a row for, and hands the
 * spec a way to push real `agent-pulse` events. The events go out on the SAME
 * channel `agentPulse.setEmitter` broadcasts on in production (terminal/ipc.ts),
 * so the ring the sparkline draws from fills through the real preload path
 * rather than through renderer state a test poked directly — a channel-name
 * drift between emit and listen fails this spec instead of dying silently.
 */
import { addWorkspace, getWorkspace, removeWorkspace } from '../db';
import { broadcastLocal } from '../remote';

const WORKSPACE_ID = 'e2e-agent-pulse';
const WORKSPACE_NAME = 'Pulse Fixture';

export interface PulseFixture {
    workspaceId: string;
    /** Push one activity sample, exactly as a terminal's bytes would.
     *  `active` drives the row's agent-active styling; the ring fills from
     *  `bytes` regardless, so a spec can get a sparkline WITHOUT it. */
    emit: (bytes: number, active: boolean) => void;
}

export function seedAgentPulseE2E(): PulseFixture {
    // The E2E profile is reused across runs — replace rather than accumulate.
    if (getWorkspace(WORKSPACE_ID)) removeWorkspace(WORKSPACE_ID);
    addWorkspace({
        id: WORKSPACE_ID,
        backend: 'aionima',
        project_id: WORKSPACE_ID,
        project_name: WORKSPACE_NAME,
        tynn_project_id: WORKSPACE_ID,
        tynn_project_name: WORKSPACE_NAME,
        shape: 'simple',
        path: process.cwd(),
        editor: null,
        editor_cmd: null,
        start_cmd: null,
        env_file: null,
        last_opened_at: null,
        created_by_genie: 0,
        sort_order: 0,
    });

    const fixture: PulseFixture = {
        workspaceId: WORKSPACE_ID,
        emit: (bytes: number, active: boolean) =>
            broadcastLocal('agent-pulse', {
                workspaceId: WORKSPACE_ID,
                active,
                bytes,
            }),
    };
    (globalThis as Record<string, unknown>).__GENIE_E2E_PULSE__ = fixture;
    return fixture;
}
