/**
 * What THIS machine can provide for a GApp's requirements (Tynn #250).
 *
 * `resolveAppRequirements` is pure and takes these facts as input, because
 * "satisfied / Genie installs it / you install it" is not a property of a runtime
 * — it is a property of the machine. Genie installs Python on Windows x64 today
 * and cannot on macOS; it installs Go everywhere and Rust nowhere. This is where
 * that gets answered, once, with the real toolchain stores.
 *
 * Only the tools the manifest actually names are probed. A GApp may require
 * something Genie has never heard of (`ffmpeg`, `terraform`) and the honest answer
 * for those is still a PATH probe — "is it there?" — rather than assuming absence
 * because Genie does not manage it.
 */

import { TOOLCHAIN_RECIPES, isLanguageTool } from '../dev-server/toolchain-versions';
import { TOOL_SPECS, probeHostTool, type HostToolName } from '../dev-server/toolchain-detect';
import { hostToolCommandRunner } from '../dev-server/seams';
import type { RequirementMachine } from './requirements';

/**
 * Can Genie install this tool on THIS platform?
 *
 * A recipe is the whole answer: it is the record of "Genie knows where to get this
 * version, for this platform, and how to put it on PATH". Deliberately
 * conservative — claiming an install Genie cannot actually perform would turn a
 * clear "you will need to install this" into a failure halfway through.
 */
function canInstall(tool: string, platform: string): boolean {
    if (!isLanguageTool(tool)) return false;
    return TOOLCHAIN_RECIPES.some(
        (recipe) => recipe.tool === tool && recipe.platforms.includes(platform as NodeJS.Platform),
    );
}

async function isInstalled(tool: string): Promise<boolean> {
    const spec = TOOL_SPECS[tool as HostToolName];
    if (spec && !spec.files) {
        return (await probeHostTool(spec, hostToolCommandRunner)).installed;
    }
    // Not a tool Genie manages. Ask PATH the same question anyway — a machine that
    // already has it should not be told to install it.
    const probe = await probeHostTool(
        { name: tool as HostToolName, bin: tool, versionArgv: ['--version'] },
        hostToolCommandRunner,
    );
    return probe.installed;
}

export async function toolchainMachineFacts(
    required: readonly string[],
    platform: string = process.platform,
): Promise<RequirementMachine> {
    const installed = new Set<string>();
    // Serial: the set is at most a handful, the probes are cheap, and the order
    // keeps the log readable when one of them misbehaves.
    for (const tool of new Set(required)) {
        try {
            if (await isInstalled(tool)) installed.add(tool);
        } catch {
            // A probe that cannot run is not a tool that is present. Fail toward
            // telling the user about it rather than toward silence.
        }
    }

    return {
        installed,
        canInstall: (tool) => canInstall(tool, platform),
    };
}
