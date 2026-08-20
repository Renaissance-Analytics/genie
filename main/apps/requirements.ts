/**
 * PURE. What a GApp needs, and who provides it (Tynn #250, owner-directed).
 *
 * The owner's rule: the app INSTALLS either way, the GApp tells Genie what it
 * needs, Genie provides whatever it can, and anything Genie does not manage gets
 * a distinctive spot in the installer instead of being buried. That is better
 * than the refuse-or-warn question it replaced, because whether a runtime can be
 * provided is not a property of the runtime at all — it is a property of the
 * MACHINE.
 *
 * Genie installs Python on Windows x64 today and cannot on macOS; it installs Go
 * everywhere and Rust nowhere. So the manifest only ever DECLARES a need, and the
 * same manifest resolves differently per machine:
 *
 *   satisfied      — already here, nothing to do
 *   genie-installs — Genie has a recipe for this platform and will fetch it
 *   user-provides  — Genie cannot; the installer has to SAY SO, prominently
 *
 * The machine's facts are injected rather than read, so every branch is testable
 * without depending on what happens to be installed on the box.
 */

/** One runtime or tool a GApp declares it needs. */
export interface AppRequirement {
    /** A toolchain tool (`python`, `node`, `go`) or anything else it needs. */
    tool: string;
    /** A specific version, when the app depends on one. */
    version?: string;
    /** WHY the app needs it — shown to the user when they have to provide it. */
    reason?: string;
}

export type RequirementStatus = 'satisfied' | 'genie-installs' | 'user-provides';

export interface ResolvedRequirement extends AppRequirement {
    status: RequirementStatus;
}

export interface RequirementMachine {
    /** Tools already present on this machine. */
    installed: ReadonlySet<string>;
    /** Can Genie install this tool ON THIS PLATFORM? */
    canInstall(tool: string): boolean;
}

export interface AppRequirementPlan {
    /** Every requirement, in the order the manifest declared them. */
    items: ResolvedRequirement[];
    /** The ones Genie will fetch as part of installing. */
    genieInstalls: ResolvedRequirement[];
    /** The ones the USER must provide — the installer's distinctive section. */
    userProvides: ResolvedRequirement[];
    /** Is anything asked of the user? Drives whether that section appears at all. */
    needsUser: boolean;
    /**
     * Always true. Kept explicit rather than implied: the owner ruled that a
     * missing runtime does NOT block the install — the app lands, and the service
     * it needs is reported unstartable with the reason attached. A field that
     * says so is harder to quietly reverse than an absence.
     */
    installable: true;
}

export function resolveAppRequirements(
    requires: readonly AppRequirement[],
    machine: RequirementMachine,
): AppRequirementPlan {
    const items: ResolvedRequirement[] = requires.map((requirement) => ({
        ...requirement,
        status: machine.installed.has(requirement.tool)
            ? 'satisfied'
            : machine.canInstall(requirement.tool)
              ? 'genie-installs'
              : 'user-provides',
    }));

    return {
        items,
        genieInstalls: items.filter((i) => i.status === 'genie-installs'),
        userProvides: items.filter((i) => i.status === 'user-provides'),
        needsUser: items.some((i) => i.status === 'user-provides'),
        installable: true,
    };
}
