/**
 * PURE, and DEPENDENCY-FREE but for `./registry`. The ONE table of coding-agent
 * CLIs Genie can detect, install and update.
 *
 * ## The fault this closes
 *
 * The Toolchain page's Agent CLIs tab took its membership from a literal in the
 * renderer:
 *
 *     export const AGENT_CLI_TOOLS = ['claude-code', 'codex'];
 *
 * The tab therefore read as "the agent CLIs on this machine" and meant "the two
 * names we wrote down". Genie already knew more providers than that —
 * `TUI_REGISTRY` has carried Genie TUI and Kiwi Code for two releases — and the
 * page simply never asked. The owner found out when a terminal died with
 * `bash: genie: command not found`, which is the worst possible place to learn
 * that a settings page was answering a weaker question than it appeared to.
 *
 * That is the same shape `registry.ts` exists to end: one fact, restated in a
 * second place, with nothing able to notice when the two drift. So the toolchain
 * derives its agent-CLI set from HERE, and this table is required to cover every
 * provider that names a fixed binary — enforced by the compiler, in
 * {@link _EveryProviderIsCatalogued}, not by anybody remembering.
 *
 * ## The second fault, which was quieter
 *
 * Even with the right list, nothing missing could be installed: the update scan
 * (`toolchain-updates.ts`) skipped every tool that was not already present, so a
 * missing CLI produced no row, and the Install button `toolRowAction` had grown
 * for exactly that case was unreachable. Listing a CLI Genie cannot install is
 * only honest if the row says so; listing one it CAN install and offering nothing
 * is not honest at all.
 *
 * ## `install: null` is an answer, not an omission
 *
 * Required rather than optional, for the reason `TuiDef.resume` is: adding a CLI
 * must be a DECISION about whether Genie can put it on the machine, and an
 * absent field would read as "no" without anybody having chosen. A null install
 * carries an {@link AgentCliDef.installGap} saying WHY in the user's words,
 * because "not installed, no button" with no explanation is the state the owner
 * was already looking at.
 *
 * ## Where the package names come from
 *
 * Every npm package and every `bin` below was read from that package's own
 * manifest on the public registry (`registry.npmjs.org/<pkg>/latest`), not from
 * recall. This ecosystem renames itself monthly and the traps are real: `aider`
 * on npm is an unrelated package (the agent is `aider-chat` on PyPI),
 * `cursor-agent` on npm is a different product entirely, and `plandex` and
 * `openhands` are security holding packages. A wrong package name here is an
 * install that fails in front of the user.
 */

import type { AgentTuiId } from './registry';

/**
 * How Genie puts an agent CLI on the machine.
 *
 * Only `npm` today, and deliberately: `npm i -g` into Genie's OWN prefix
 * (genie#214) is the one mechanism that needs no elevation, lands somewhere
 * Genie can add to PATH, and works identically on all three platforms. A vendor
 * `curl … | bash` script would need a fourth trust decision, a Windows
 * equivalent, and a consent surface — see the `installGap` entries below, which
 * name the CLIs waiting on exactly that.
 */
export interface AgentCliInstall {
    manager: 'npm';
    /** The npm package that provides {@link AgentCliDef.bin}. */
    package: string;
}

export interface AgentCliDef {
    /**
     * The TOOLCHAIN id — this row's identity on the Toolchain page, and a
     * `HostToolName`. Deliberately not the same thing as {@link bin}: the id
     * names the PRODUCT (`claude-code`) and the bin is what lands on PATH
     * (`claude`). Conflating them is how `defaultCommand` came to say
     * `genie-tui`, a binary that has never existed.
     */
    id: string;
    /** Human-facing name. Must match the provider's label where there is one. */
    label: string;
    /** The executable this puts on PATH — what a probe actually spawns. */
    bin: string;
    /** argv that prints a version and exits 0 when the tool is usable. */
    versionArgv: readonly string[];
    /**
     * The provider Genie can LAUNCH this as, or `null` when Genie only detects
     * and installs it. A null provider is not a lesser entry: an installed CLI
     * with no provider is still launchable as a Custom agent, and promoting one
     * later is a change to this field alone.
     */
    provider: AgentTuiId | null;
    /** How Genie installs it, or `null` when Genie has no working mechanism. */
    install: AgentCliInstall | null;
    /** Required iff {@link install} is null: WHY, in words a user can act on. */
    installGap?: string;
    /** Where a person goes to install it themselves. */
    docsUrl?: string;
}

/**
 * Every agent CLI Genie knows about.
 *
 * Order is the order the Toolchain tab renders, and it is stable on purpose (a
 * settings list that reshuffles between reads reads as broken): the providers
 * Genie can launch first, then the CLIs it can install, then the ones it can
 * only point at.
 */
const CATALOG = [
    // --- the providers Genie launches ---------------------------------------
    {
        id: 'claude-code',
        label: 'Claude Code',
        bin: 'claude',
        versionArgv: ['--version'],
        provider: 'claude',
        install: { manager: 'npm', package: '@anthropic-ai/claude-code' },
        docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    },
    {
        id: 'codex',
        label: 'Codex',
        bin: 'codex',
        versionArgv: ['--version'],
        provider: 'codex',
        install: { manager: 'npm', package: '@openai/codex' },
        docsUrl: 'https://developers.openai.com/codex/cli/',
    },
    {
        id: 'genie',
        label: 'Genie TUI',
        bin: 'genie',
        versionArgv: ['--version'],
        provider: 'genie',
        // Genie's own TUI, and still the gap that started this. `@genie/tui` is
        // `private: true` and has never been published, and its shipped `bin` is
        // named `genie-tui` — so an `npm install -g` today would put the WRONG
        // name on PATH and reproduce, one layer later, the naming bug the
        // registry's `defaultCommand` comment already documents. Wire an
        // installer here once the package is public AND its bin is `genie`.
        install: null,
        installGap:
            'Genie’s own TUI is not published yet, so Genie cannot install it for you. It ships with a future release.',
        docsUrl: 'https://github.com/Renaissance-Analytics/genie-tui',
    },
    {
        id: 'kiwi',
        label: 'Kiwi Code',
        bin: 'kiwi',
        versionArgv: ['--version'],
        provider: 'kiwi',
        // There is no installer because there appears to be no product. A search
        // of the npm registry and the open web turns up no coding agent called
        // "Kiwi Code" and no `kiwi` binary (the `kiwi-cli` package on npm is an
        // unrelated general-purpose tool). The near neighbours are all real and
        // all different — Kilo Code (`@kilocode/cli`, bin `kilo`) and Kimi Code
        // (`@moonshot-ai/kimi-code`, bin `kimi`), BOTH catalogued below — which
        // makes this look like a corruption of one of their names rather than a
        // provider waiting on an installer. Renaming it is a product decision
        // (which vendor?), so it stays listed with the gap stated until someone
        // makes that call. See genie#432.
        install: null,
        installGap:
            'Genie has no installer for Kiwi Code, and no public source for a `kiwi` binary could be found. If you meant Kilo Code or Kimi Code, both are listed below.',
    },

    // --- CLIs Genie can install, but does not launch as a provider ----------
    //
    // Installed, each of these runs as a Custom agent. Promoting one to a full
    // provider is a change to its `provider` field and a registry entry — a
    // decision about which vendors Genie integrates with, not a toolchain one.
    {
        id: 'gemini-cli',
        label: 'Gemini CLI',
        bin: 'gemini',
        versionArgv: ['--version'],
        provider: null,
        install: { manager: 'npm', package: '@google/gemini-cli' },
        docsUrl: 'https://github.com/google-gemini/gemini-cli',
    },
    {
        id: 'opencode',
        label: 'opencode',
        bin: 'opencode',
        versionArgv: ['--version'],
        provider: null,
        install: { manager: 'npm', package: 'opencode-ai' },
        docsUrl: 'https://opencode.ai',
    },
    {
        id: 'copilot-cli',
        label: 'GitHub Copilot CLI',
        bin: 'copilot',
        versionArgv: ['--version'],
        provider: null,
        install: { manager: 'npm', package: '@github/copilot' },
        docsUrl: 'https://github.com/github/copilot-cli',
    },
    {
        id: 'amp',
        label: 'Amp',
        bin: 'amp',
        versionArgv: ['--version'],
        provider: null,
        install: { manager: 'npm', package: '@sourcegraph/amp' },
        docsUrl: 'https://ampcode.com',
    },
    {
        id: 'crush',
        label: 'Crush',
        bin: 'crush',
        versionArgv: ['--version'],
        provider: null,
        install: { manager: 'npm', package: '@charmland/crush' },
        docsUrl: 'https://github.com/charmbracelet/crush',
    },
    {
        id: 'qwen-code',
        label: 'Qwen Code',
        bin: 'qwen',
        versionArgv: ['--version'],
        provider: null,
        install: { manager: 'npm', package: '@qwen-code/qwen-code' },
        docsUrl: 'https://github.com/QwenLM/qwen-code',
    },
    {
        id: 'kimi-code',
        label: 'Kimi Code',
        bin: 'kimi',
        versionArgv: ['--version'],
        provider: null,
        // NOT the `kimi-cli` package on npm, which is an unrelated front-end
        // generator that happens to own the shorter name.
        install: { manager: 'npm', package: '@moonshot-ai/kimi-code' },
        docsUrl: 'https://github.com/MoonshotAI/kimi-code',
    },
    {
        id: 'kilo-cli',
        label: 'Kilo CLI',
        bin: 'kilo',
        versionArgv: ['--version'],
        provider: null,
        // The package publishes TWO bins, `kilo` and `kilocode`. `kilo` is the
        // documented one and the one probed; a machine with only the alias on
        // PATH reads as not-installed, which is the safe direction to be wrong.
        install: { manager: 'npm', package: '@kilocode/cli' },
        docsUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
    },
    {
        id: 'cline',
        label: 'Cline',
        bin: 'cline',
        versionArgv: ['--version'],
        provider: null,
        install: { manager: 'npm', package: 'cline' },
        docsUrl: 'https://github.com/cline/cline',
    },
    {
        id: 'continue-cli',
        label: 'Continue',
        // `cn`, not `continue` — short, and the package's own manifest says so.
        bin: 'cn',
        versionArgv: ['--version'],
        provider: null,
        install: { manager: 'npm', package: '@continuedev/cli' },
        docsUrl: 'https://github.com/continuedev/continue',
    },
    {
        id: 'auggie',
        label: 'Auggie',
        bin: 'auggie',
        versionArgv: ['--version'],
        provider: null,
        install: { manager: 'npm', package: '@augmentcode/auggie' },
        docsUrl: 'https://docs.augmentcode.com/cli/overview',
    },
    {
        id: 'droid',
        label: 'Factory Droid',
        bin: 'droid',
        versionArgv: ['--version'],
        provider: null,
        // The unscoped `droid` package IS Factory's — verified against its
        // manifest. Their docs lead with a shell installer; the npm route is the
        // one Genie can drive without a second consent mechanism.
        install: { manager: 'npm', package: 'droid' },
        docsUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
    },
    {
        id: 'iflow-cli',
        label: 'iFlow CLI',
        bin: 'iflow',
        versionArgv: ['--version'],
        provider: null,
        install: { manager: 'npm', package: '@iflow-ai/iflow-cli' },
        docsUrl: 'https://github.com/iflow-ai/iflow-cli',
    },

    // --- CLIs Genie can only point at ---------------------------------------
    //
    // Real, widely used, and outside every mechanism Genie has. Each says which
    // mechanism it would need, so "no button" is a stated limit rather than an
    // apparent oversight. Amazon Q / Kiro CLI is deliberately NOT here: its
    // binary is `q`, which is too generic to probe without reporting some
    // unrelated `q` as an installed coding agent, and AWS ships no native
    // Windows install at all.
    {
        id: 'goose',
        label: 'Goose',
        bin: 'goose',
        versionArgv: ['--version'],
        provider: null,
        install: null,
        installGap:
            'Goose ships as a GitHub release binary rather than an npm package, and Genie can only install agent CLIs through npm today.',
        docsUrl: 'https://github.com/block/goose',
    },
    {
        id: 'aider',
        label: 'Aider',
        bin: 'aider',
        versionArgv: ['--version'],
        provider: null,
        // The npm package called `aider` is somebody else's. Aider is PyPI's
        // `aider-chat`, which needs a Python toolchain Genie does not install
        // agent CLIs through.
        install: null,
        installGap:
            'Aider installs from PyPI (`aider-chat`) and needs Python, which Genie does not yet install agent CLIs through.',
        docsUrl: 'https://aider.chat/docs/install.html',
    },
    {
        id: 'cursor-cli',
        label: 'Cursor CLI',
        // Cursor's own installer writes `cursor-agent`; on posix it also exposes
        // the alias `agent`, which is far too generic a name to probe for.
        bin: 'cursor-agent',
        versionArgv: ['--version'],
        provider: null,
        install: null,
        installGap:
            'Cursor installs through its own vendor script (a different one per platform), which Genie does not run on your behalf.',
        docsUrl: 'https://cursor.com/docs/cli/installation',
    },
] as const satisfies readonly AgentCliDef[];

/**
 * Every agent CLI's toolchain id, as a UNION — the agent half of
 * `HostToolName`.
 *
 * This is why the table above is `as const`: adding an entry widens this type,
 * and every exhaustive `Record<HostToolName, …>` downstream (the probe specs,
 * the row labels) stops compiling until it covers the new tool. A plain
 * `AgentCliDef[]` would have given `string` here and bought nothing.
 */
export type AgentCliToolId = (typeof CATALOG)[number]['id'];

/**
 * The catalog as consumers read it.
 *
 * Widened to `AgentCliDef` on purpose: the `as const` literal above is a UNION
 * of twenty distinct object types, so an entry without `docsUrl` makes
 * `entry.docsUrl` a type error on the union even though the field is optional.
 * The literal types are still available where they matter — {@link
 * AgentCliToolId} reads them off `CATALOG` directly.
 */
export const AGENT_CLI_CATALOG: readonly AgentCliDef[] = CATALOG;

/** The ids, in catalog order. */
export const AGENT_CLI_IDS: readonly AgentCliToolId[] = CATALOG.map((e) => e.id);

// --- the compile-time coverage guarantee ------------------------------------

/**
 * Providers that name no fixed binary, so there is nothing here to detect or
 * install. Only `custom` — a custom agent IS its command, and the owner is its
 * installer.
 */
const PROVIDERS_WITHOUT_A_BINARY = ['custom'] as const;

type CataloguedProvider = NonNullable<(typeof CATALOG)[number]['provider']>;

type UncoveredProvider = Exclude<
    AgentTuiId,
    (typeof PROVIDERS_WITHOUT_A_BINARY)[number] | CataloguedProvider
>;

/**
 * A COMPILE ERROR when a provider has neither a catalog entry nor a documented
 * reason to have none.
 *
 * This is the property the old `['claude-code', 'codex']` literal could never
 * have had: adding a provider to `PROVIDER_IDS` and forgetting this table used
 * to produce a silence — a provider that launched, failed with `command not
 * found`, and was absent from the one page that would have explained why. Now it
 * does not build. `[T] extends [never]` rather than `T extends never`, because a
 * bare conditional distributes over a union and `never` is the empty one.
 *
 * The `extends true` CONSTRAINT is what turns the check into an error: a bare
 * conditional type alias always resolves to something and never fails, so it
 * has to be fed to something that refuses the failing shape.
 */
type AssertCovered<T extends true> = T;

export type _EveryProviderIsCatalogued = AssertCovered<
    [UncoveredProvider] extends [never]
        ? true
        : ['MISSING FROM AGENT_CLI_CATALOG:', UncoveredProvider]
>;

// --- lookups ----------------------------------------------------------------

/** The definition for a tool id, or undefined when it names no agent CLI. */
export function agentCliDef(id: string): AgentCliDef | undefined {
    return AGENT_CLI_CATALOG.find((e) => e.id === id);
}

/** The CLI a provider launches, or undefined for a provider with no fixed
 *  binary. */
export function agentCliForProvider(provider: AgentTuiId): AgentCliDef | undefined {
    return AGENT_CLI_CATALOG.find((e) => e.provider === provider);
}

/** The ones Genie can actually put on the machine. The rest are LISTED, with
 *  their gap stated — never hidden, and never given a button that fails. */
export function installableAgentClis(): AgentCliDef[] {
    return AGENT_CLI_CATALOG.filter((e) => e.install !== null);
}

/**
 * The probe recipe per tool, in the shape `toolchain-detect`'s `TOOL_SPECS`
 * wants. Structural rather than imported, so this module stays free of anything
 * node-side and the renderer can keep reading it directly.
 */
export function agentCliSpecs(): Record<
    AgentCliToolId,
    { name: AgentCliToolId; bin: string; versionArgv: string[] }
> {
    const out = {} as Record<
        AgentCliToolId,
        { name: AgentCliToolId; bin: string; versionArgv: string[] }
    >;
    for (const entry of CATALOG) {
        out[entry.id] = { name: entry.id, bin: entry.bin, versionArgv: [...entry.versionArgv] };
    }
    return out;
}

/**
 * Tool id → npm package, for the two surfaces that must never disagree: the
 * INSTALLER (`npm i -g <pkg>`) and the UPDATE CHECK (`npm outdated -g`, which
 * reads the answer back out by package name). They were already derived from one
 * map; that map now derives from here.
 */
export function npmPackagesByTool(): Partial<Record<AgentCliToolId, string>> {
    const out: Partial<Record<AgentCliToolId, string>> = {};
    for (const entry of CATALOG) {
        if (entry.install?.manager === 'npm') out[entry.id] = entry.install.package;
    }
    return out;
}

/** Tool id → display name, for the Toolchain page's row labels. */
export function agentCliLabels(): Record<AgentCliToolId, string> {
    const out = {} as Record<AgentCliToolId, string>;
    for (const entry of CATALOG) out[entry.id] = entry.label;
    return out;
}

/**
 * The provider→tool map the onboarding wizard uses to tick "Claude Code is
 * already here". Derived, because a provider missing from a hand-written copy of
 * this map silently offered to install a driver the machine already had.
 */
export function agentCliToolByProvider(): Partial<Record<AgentTuiId, AgentCliToolId>> {
    const out: Partial<Record<AgentTuiId, AgentCliToolId>> = {};
    for (const entry of CATALOG) {
        if (entry.provider) out[entry.provider] = entry.id;
    }
    return out;
}
