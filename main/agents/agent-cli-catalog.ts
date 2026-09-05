/**
 * PURE. The ONE table of coding-agent CLIs Genie can detect, install and update.
 *
 * ## The fault this closes
 *
 * The Toolchain page's Agent CLIs tab took its membership from a literal in the
 * renderer:
 *
 *     export const AGENT_CLI_TOOLS = ['claude-code', 'codex'];
 *
 * The tab therefore read as "the agent CLIs on this machine" and meant "the two
 * names we wrote down". Genie already knew more providers than that, and the
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
 * only honest if the row says so; listing one it CAN install and offering
 * nothing is not honest at all.
 *
 * ## What this table does NOT carry
 *
 * No `label`, and no `bin`, for any CLI that has a provider. Those belong to
 * `TUI_REGISTRY` — a provider's display name and its `defaultCommand` — and
 * restating them here would put the toolchain page and the agent picker one
 * careless edit apart. They are resolved on the way out, so the two surfaces
 * cannot disagree rather than merely being asserted not to.
 *
 * ## `install: null` and `probe: false` are answers, not omissions
 *
 * Both are REQUIRED fields, for the reason `TuiDef.resume` is: adding a CLI must
 * be a DECISION about whether Genie can put it on the machine and whether it can
 * honestly look for it, and an absent field would read as "no" without anybody
 * having chosen. A null install carries an {@link AgentCliDef.installGap} saying
 * WHY in the user's words, because "not installed, no button" with no
 * explanation is the state the owner was already looking at.
 *
 * ## Where the package names come from
 *
 * Every npm package and every `bin` below was read from that package's own
 * manifest on the public registry (`registry.npmjs.org/<pkg>/latest`), or from
 * the vendor's install docs where it does not ship on npm — never from recall.
 * This ecosystem renames itself monthly and the traps are real:
 *
 *   - `aider` on npm is an unrelated package; the agent is `aider-chat` on PyPI
 *   - `cursor-agent` on npm is a different product ("task sequence creator")
 *   - `plandex` and `openhands` on npm are `0.0.1-security` holding packages
 *   - `kimi-cli` is a front-end generator; Moonshot's agent is
 *     `@moonshot-ai/kimi-code`
 *   - `mistral-code` is published at 0.0.0 and is not the product; Mistral's
 *     terminal agent is Mistral Vibe, bin `vibe`, distributed through PyPI
 *   - `@kilocode/cli` ships TWO bins and `codebuff` ships two, so
 *     one-bin-per-package would have been right only by luck
 *
 * A wrong package name here is an install that fails in front of the user.
 */

import { TUI_REGISTRY, type AgentTuiId, type ProviderInstallSpec } from './registry';

/**
 * Every one of these answers `--version` on stdout with exit 0 — the one uniform
 * thing across an otherwise unrelated set, so it is stated once rather than
 * repeated twenty-one times.
 *
 * A CLI that did NOT answer it would probe as absent rather than crash, which is
 * the safe direction to be wrong; it is still not a thing to discover by
 * accident, so give this a per-entry override the day one of them needs it
 * rather than assuming harder.
 */
const VERSION_ARGV: readonly string[] = ['--version'];

/** The table's rows, before label/bin are resolved off the registry. */
interface RawAgentCli {
    /**
     * The TOOLCHAIN id — this row's identity on the Toolchain page, and a
     * `HostToolName`. Deliberately not the same thing as the binary: the id
     * names the PRODUCT (`claude-code`) and the bin is what lands on PATH
     * (`claude`). Conflating them is how `defaultCommand` came to say
     * `genie-tui`, a binary that has never existed.
     */
    id: string;
    /**
     * The provider Genie launches this as, or `null` when Genie lists the CLI
     * without offering to run it. Non-null is the overwhelming default: the
     * owner's instruction was that every agent CLI Genie knows about should be
     * launchable, not merely installable.
     */
    provider: AgentTuiId | null;
    /** Required iff `provider` is null — otherwise the registry owns the name. */
    label?: string;
    /** Required iff `provider` is null — otherwise the registry owns the bin. */
    bin?: string;
    /**
     * Look for this CLI on the machine?
     *
     * FALSE for a CLI whose binary name is too generic to probe without risking
     * a FALSE POSITIVE — reporting some unrelated program as an installed coding
     * agent. A `false` row is still LISTED, and still says what is missing and
     * why; it simply makes no claim about whether you have it, which is the
     * honest thing to say when the check cannot be trusted.
     */
    probe: boolean;
    /** How Genie installs it, or `null` when Genie has no working mechanism. */
    install: ProviderInstallSpec | null;
    /** Required iff {@link install} is null: WHY, in words a user can act on. */
    installGap?: string;
    /** Where a person goes to install it themselves. */
    docsUrl?: string;
}

/** One agent CLI, with its label, binary and version probe resolved. */
export interface AgentCliDef extends RawAgentCli {
    label: string;
    bin: string;
    versionArgv: readonly string[];
}

/**
 * Every agent CLI Genie knows about.
 *
 * Order is the order the Toolchain tab renders, and it is stable on purpose (a
 * settings list that reshuffles between reads reads as broken): the two that
 * have always shipped, Genie's own, then the rest alphabetically. Alphabetical
 * because any other ordering past the first three is an editorial claim about
 * which vendor matters, and nothing here is qualified to make one.
 */
const CATALOG = [
    {
        id: 'claude-code',
        provider: 'claude',
        probe: true,
        install: { manager: 'npm', package: '@anthropic-ai/claude-code' },
        docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    },
    {
        id: 'codex',
        provider: 'codex',
        probe: true,
        install: { manager: 'npm', package: '@openai/codex' },
        docsUrl: 'https://developers.openai.com/codex/cli/',
    },
    {
        id: 'genie',
        provider: 'genie',
        probe: true,
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

    // --- the rest of the field, alphabetically ------------------------------
    {
        id: 'aider',
        provider: 'aider',
        probe: true,
        // The npm package called `aider` is somebody else's. Aider is PyPI's
        // `aider-chat`, which needs a Python toolchain Genie does not install
        // agent CLIs through.
        install: null,
        installGap:
            'Aider installs from PyPI (`aider-chat`) and needs Python, which Genie does not yet install agent CLIs through.',
        docsUrl: 'https://aider.chat/docs/install.html',
    },
    {
        id: 'amp',
        provider: 'amp',
        probe: true,
        install: { manager: 'npm', package: '@sourcegraph/amp' },
        docsUrl: 'https://ampcode.com',
    },
    {
        id: 'auggie',
        provider: 'auggie',
        probe: true,
        install: { manager: 'npm', package: '@augmentcode/auggie' },
        docsUrl: 'https://docs.augmentcode.com/cli/overview',
    },
    {
        id: 'cline',
        provider: 'cline',
        probe: true,
        install: { manager: 'npm', package: 'cline' },
        docsUrl: 'https://github.com/cline/cline',
    },
    {
        id: 'continue-cli',
        provider: 'continue',
        probe: true,
        install: { manager: 'npm', package: '@continuedev/cli' },
        docsUrl: 'https://github.com/continuedev/continue',
    },
    {
        id: 'copilot-cli',
        provider: 'copilot',
        probe: true,
        install: { manager: 'npm', package: '@github/copilot' },
        docsUrl: 'https://github.com/github/copilot-cli',
    },
    {
        id: 'crush',
        provider: 'crush',
        probe: true,
        install: { manager: 'npm', package: '@charmland/crush' },
        docsUrl: 'https://github.com/charmbracelet/crush',
    },
    {
        id: 'cursor-cli',
        provider: 'cursor',
        probe: true,
        install: null,
        installGap:
            'Cursor installs through its own vendor script (a different one per platform), which Genie does not run on your behalf.',
        docsUrl: 'https://cursor.com/docs/cli/installation',
    },
    {
        id: 'droid',
        provider: 'droid',
        probe: true,
        // The unscoped `droid` package IS Factory's — verified against its
        // manifest. Their docs lead with a shell installer; the npm route is the
        // one Genie can drive without a second consent mechanism.
        install: { manager: 'npm', package: 'droid' },
        docsUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
    },
    {
        id: 'gemini-cli',
        provider: 'gemini',
        probe: true,
        install: { manager: 'npm', package: '@google/gemini-cli' },
        docsUrl: 'https://github.com/google-gemini/gemini-cli',
    },
    {
        id: 'goose',
        provider: 'goose',
        probe: true,
        install: null,
        installGap:
            'Goose ships as a GitHub release binary rather than an npm package, and Genie can only install agent CLIs through npm today.',
        docsUrl: 'https://github.com/block/goose',
    },
    {
        id: 'iflow-cli',
        provider: 'iflow',
        probe: true,
        install: { manager: 'npm', package: '@iflow-ai/iflow-cli' },
        docsUrl: 'https://github.com/iflow-ai/iflow-cli',
    },
    {
        id: 'kilo-cli',
        provider: 'kilo',
        probe: true,
        // This entry is what the `kiwi` provider was reaching for. See the
        // `PROVIDER_IDS` comment in `registry.ts`: no product called "Kiwi Code"
        // exists, and the owner confirmed Kilo Code was meant.
        install: { manager: 'npm', package: '@kilocode/cli' },
        docsUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
    },
    {
        id: 'kimi-code',
        provider: 'kimi',
        probe: true,
        // NOT the `kimi-cli` package on npm, which is an unrelated front-end
        // generator that happens to own the shorter name.
        install: { manager: 'npm', package: '@moonshot-ai/kimi-code' },
        docsUrl: 'https://github.com/MoonshotAI/kimi-code',
    },
    {
        id: 'mistral-vibe',
        provider: 'vibe',
        probe: true,
        // PyPI `mistral-vibe`, or a vendor install script — the same two
        // mechanisms Genie does not have. NOT the `mistral-code` npm package,
        // which is published at 0.0.0 and is not the product.
        install: null,
        installGap:
            'Mistral Vibe installs from PyPI (`mistral-vibe`) or Mistral’s own script, neither of which Genie installs agent CLIs through.',
        docsUrl: 'https://github.com/mistralai/mistral-vibe',
    },
    {
        id: 'opencode',
        provider: 'opencode',
        probe: true,
        install: { manager: 'npm', package: 'opencode-ai' },
        docsUrl: 'https://opencode.ai',
    },
    {
        id: 'qwen-code',
        provider: 'qwen',
        probe: true,
        install: { manager: 'npm', package: '@qwen-code/qwen-code' },
        docsUrl: 'https://github.com/QwenLM/qwen-code',
    },

    // --- listed, but never looked for ---------------------------------------
    {
        id: 'amazon-q',
        label: 'Amazon Q Developer CLI',
        // Carried so the row can NAME the binary, never so it can be spawned or
        // probed — `probe: false` is what stops both.
        bin: 'q',
        // Not launchable, and that is the same judgement as `probe: false` taken
        // one step further: if Genie cannot trust that `q` on PATH is AWS's
        // agent, it certainly must not spawn whatever it finds. A false
        // "installed" is a bad row; launching an unrelated program is worse.
        provider: null,
        // The binary is `q` — a name generic enough that probing for it would
        // report some unrelated program as an installed coding agent. Omitting
        // the CLI entirely was the previous answer and it was wrong in the other
        // direction: it disappeared a real product with a real reason. Listed
        // WITHOUT a detection claim is the answer that is true on both counts.
        probe: false,
        install: null,
        installGap:
            'AWS ships no native Windows install for the Amazon Q CLI (WSL only), and its binary `q` is too generic for Genie to detect safely — so this row says what it is and makes no claim about whether you have it.',
        docsUrl: 'https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line.html',
    },
] as const satisfies readonly RawAgentCli[];

/**
 * Every agent CLI's toolchain id, as a UNION — the agent half of
 * `HostToolName`.
 *
 * This is why the table above is `as const`: adding an entry widens this type,
 * and every exhaustive `Record<HostToolName, …>` downstream (the probe specs,
 * the row labels) stops compiling until it covers the new tool. A plain
 * `RawAgentCli[]` would have given `string` here and bought nothing.
 */
export type AgentCliToolId = (typeof CATALOG)[number]['id'];

/** Resolve one row's display name — the registry's, when it has a provider. */
function resolveLabel(raw: RawAgentCli): string {
    return raw.provider ? TUI_REGISTRY[raw.provider].label : raw.label!;
}

/** Resolve one row's binary — the registry's `defaultCommand`, when it has a
 *  provider. This is the join that makes "the toolchain page and the agent
 *  picker disagree about the binary" unrepresentable rather than merely tested. */
function resolveBin(raw: RawAgentCli): string {
    return raw.provider ? TUI_REGISTRY[raw.provider].defaultCommand : raw.bin!;
}

/**
 * The catalog as consumers read it, label and bin resolved.
 *
 * Widened to `AgentCliDef` on purpose: the `as const` literal above is a UNION
 * of twenty-one distinct object types, so an entry without `docsUrl` makes
 * `entry.docsUrl` a type error on the union even though the field is optional.
 * The literal types are still available where they matter — {@link
 * AgentCliToolId} reads them off `CATALOG` directly.
 */
export const AGENT_CLI_CATALOG: readonly AgentCliDef[] = CATALOG.map((raw) => ({
    ...raw,
    label: resolveLabel(raw),
    bin: resolveBin(raw),
    versionArgv: VERSION_ARGV,
}));

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
 *
 * `probe: false` travels with the spec so the DETECTOR can decline to spawn,
 * rather than every caller having to remember to ask the catalog first.
 */
export function agentCliSpecs(): Record<
    AgentCliToolId,
    { name: AgentCliToolId; bin: string; versionArgv: string[]; probe: boolean }
> {
    const out = {} as Record<
        AgentCliToolId,
        { name: AgentCliToolId; bin: string; versionArgv: string[]; probe: boolean }
    >;
    for (const raw of CATALOG) {
        out[raw.id] = {
            name: raw.id,
            bin: resolveBin(raw),
            versionArgv: [...VERSION_ARGV],
            probe: raw.probe,
        };
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
    for (const raw of CATALOG) {
        if (raw.install?.manager === 'npm') out[raw.id] = raw.install.package;
    }
    return out;
}

/** Tool id → display name, for the Toolchain page's row labels. */
export function agentCliLabels(): Record<AgentCliToolId, string> {
    const out = {} as Record<AgentCliToolId, string>;
    for (const raw of CATALOG) out[raw.id] = resolveLabel(raw);
    return out;
}

/**
 * The provider→tool map the onboarding wizard uses to tick "Claude Code is
 * already here". Derived, because a provider missing from a hand-written copy of
 * this map silently offered to install a driver the machine already had.
 */
export function agentCliToolByProvider(): Partial<Record<AgentTuiId, AgentCliToolId>> {
    const out: Partial<Record<AgentTuiId, AgentCliToolId>> = {};
    for (const raw of CATALOG) {
        if (raw.provider) out[raw.provider] = raw.id;
    }
    return out;
}
