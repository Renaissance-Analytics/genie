/**
 * A BROKEN AGENT CLI, REPAIRED (Tynn #698 story 2) — the pure half: which steps, from what the health check found.
 *
 * The vendor's installer, always (`VENDOR_INSTALLERS`). When the copy that is broken is an npm copy, its npm package is
 * removed AFTER the installer succeeded, as Anthropic documents for an npm 12 install ("switch to the native installer, then
 * uninstall the npm package": code.claude.com/docs/en/troubleshoot-install): with it gone, nothing on PATH runs the
 * placeholder ahead of the native program. A CLI that runs is not repaired, and signed out is a login, not a repair.
 * `main/cli-repair.ts` runs the steps.
 */

import type { ProviderHealth } from './provider-health.js';
import { providerName } from './provider-health.js';
import { HOST_TOOLS, vendorInstaller, type Platform } from './toolchain.js';

export interface RepairStep {
    /** What the person reads while it runs. */
    readonly label: string;
    readonly binary: string;
    readonly args: readonly string[];
    /** Its limit: a step past it is ended, with what it started, and the repair stops there. */
    readonly timeoutMs: number;
}

/** The Toolchain row each provider's CLI is. */
export const PROVIDER_TOOL: Readonly<Record<string, string>> = { claude: 'claude-code', codex: 'codex' };

/** An installer downloads the CLI (Claude Code's is ~200 MB): ten minutes. Removing an npm package: three. */
const INSTALLER_TIMEOUT_MS = 10 * 60_000;
const NPM_TIMEOUT_MS = 3 * 60_000;

export function planCliRepair(input: { provider: string; platform: Platform; health: ProviderHealth }): RepairStep[] | { readonly refused: string } {
    const name = providerName(input.provider);
    const tool = PROVIDER_TOOL[input.provider];
    if (!tool) return { refused: `Genie does not know how to repair ${input.provider}` };
    if (input.health.installed && input.health.fault === 'signed-out') return { refused: `${name} runs; it is not signed in. Log in to ${name}, which is not a repair` };
    if (input.health.installed) return { refused: `${name} runs; there is nothing to repair` };
    const installer = vendorInstaller(tool, input.platform);
    if (installer === null) return { refused: `Genie has no installer for ${name}` };
    if ('refused' in installer) return installer;
    const steps: RepairStep[] = [{ label: `Running ${name}’s installer`, binary: installer.argv[0]!, args: installer.argv.slice(1), timeoutMs: INSTALLER_TIMEOUT_MS }];
    const pkg = HOST_TOOLS.find((t) => t.name === tool)?.npmPackage;
    const program = input.health.program ?? '';
    if (pkg && program.replace(/\\/g, '/').includes(`/node_modules/${pkg}/`)) {
        steps.push({ label: `Removing the broken npm copy of ${name} (npm uninstall -g ${pkg})`, binary: 'npm', args: ['uninstall', '-g', pkg], timeoutMs: NPM_TIMEOUT_MS });
    }
    return steps;
}
