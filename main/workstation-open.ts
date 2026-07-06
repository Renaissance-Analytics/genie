/**
 * Open a Virtual Workstation by id — the shared CONNECT pipeline behind both
 * the `workstation:open` IPC handler (Hosts picker) and the
 * `genie://workstation/open` deep link (see main/auth.ts).
 *
 * The flow (identical to what the IPC handler used to inline):
 *   1. Mint an ephemeral PoP keypair in MAIN. Its public JWK binds the grant
 *      (`cnf.jkt`); its private key answers the host's post-welcome challenge
 *      and never leaves main (wiped on teardown via RelayMemberClient.close).
 *   2. `getTynnBackend().connectGrant(id, publicJwk)` — session-cookied; throws
 *      TynnAuthError on a dead Tynn session, a plain Error on 403 (not entitled)
 *      / not-active.
 *   3. `connectWorkstation(...)` dials the relay member session.
 *   4. On success, open the workstation's own native Floor window.
 *
 * The grant + relay endpoint never reach the renderer — main holds them and
 * runs the heartbeat for the connection's lifetime.
 */
import { PopKeypair } from './remote/relay-pop';
import { connectWorkstation, type RemoteHost } from './remote';
import { showHostWindow } from './background';
import { getTynnBackend } from './backend/registry';
import { TynnAuthError, type WorkstationConnectGrant } from './backend/tynn';

export interface OpenWorkstationResult {
    ok: boolean;
    connKey?: string;
    error?: string;
}

export async function openWorkstationById(
    workstationId: string,
    name?: string,
): Promise<OpenWorkstationResult> {
    // The display name drives the host window title + the REMOTE indicator.
    // The IPC path always passes it; the deep-link path may fall back to the id.
    const displayName = name && name.length > 0 ? name : workstationId;

    // PoP (P4.5): generate the ephemeral keypair in MAIN; its public JWK binds
    // the grant (cnf.jkt) and its private key answers the host's post-welcome
    // challenge. The private key never leaves main and is wiped when the
    // connection tears down (RelayMemberClient.close → discard).
    const popKeypair = PopKeypair.generate();
    let grant: WorkstationConnectGrant;
    try {
        grant = await getTynnBackend().connectGrant(workstationId, popKeypair.publicJwk);
    } catch (e) {
        if (e instanceof TynnAuthError) {
            return { ok: false, error: 'Sign in to Tynn to connect to this workstation.' };
        }
        return {
            ok: false,
            error: e instanceof Error ? e.message : 'Could not get a connection grant.',
        };
    }
    const res = await connectWorkstation({
        workstationId,
        name: displayName,
        relayUrl: grant.relay_endpoint,
        grant: grant.token,
        popKeypair,
        heartbeatIntervalMs:
            grant.heartbeat_interval > 0 ? grant.heartbeat_interval * 1000 : undefined,
        onHeartbeat: () => getTynnBackend().introspectGrant(grant.token),
    });
    if (res.ok && res.connKey) {
        const host: RemoteHost = { ip: 'relay', port: 0, hostname: displayName };
        showHostWindow(host, res.connKey);
    }
    return res;
}
