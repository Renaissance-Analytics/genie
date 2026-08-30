import fs from 'node:fs';
import path from 'node:path';

const ORIENTED_MARKER = '.genie-osa-oriented';
export type OsAgentBootMode = 'first-boot' | 'recovery';

export function osAgentBootMode(userDataDir: string): OsAgentBootMode {
    return fs.existsSync(path.join(userDataDir, ORIENTED_MARKER)) ? 'recovery' : 'first-boot';
}

export function markOsAgentOriented(userDataDir: string): void {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, ORIENTED_MARKER), new Date().toISOString(), {
        encoding: 'utf8', mode: 0o600,
    });
}

export function osAgentBootInstructions(mode: OsAgentBootMode): string {
    return mode === 'first-boot'
        ? 'This is the workstation first boot. Orient yourself, verify your native AgentInbox transport and Genie system services, then guide the owner through model provider, toolchain, Tynn, optional GitHub, Genie OS backup, and workspace setup. Only after those checks call thumbsUp with reason boot; that is the sole setup-complete signal.'
        : 'This is a workstation recovery boot. Reattach to and verify the Genie host services, native AgentInbox transport, managed toolchain, and prior Genie OS workspace and memory. Preserve existing configuration. Call thumbsUp with reason boot after recovery and orientation complete.';
}
