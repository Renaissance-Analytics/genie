import type { ProviderExtensions } from '../../core/provider-commands.js';

/** RED stand-in (Tynn #628): the list as AgentView drew it. */
export function SkillsAndCommands({ extensions }: { extensions: ProviderExtensions; provider: string; initialQuery?: string | undefined; initiallyOpen?: readonly string[] | undefined }) {
    return (
        <section data-rail="extensions">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Skills and commands</h3>
            {extensions.commands.length === 0 ? (
                <p className="text-[11px] text-[var(--fg-3)]">Its CLI offers none.</p>
            ) : (
                <ul data-rail-commands={extensions.commands.length} className="grid grid-cols-1 gap-x-6 font-mono text-[11px] text-[var(--fg-2)] md:grid-cols-2">
                    {extensions.commands.map((c) => (
                        <li key={c.name} data-command={c.name} className="flex justify-between gap-2 py-px">
                            <span className="truncate">/{c.name}</span>
                            <span className="shrink-0 truncate font-sans text-[var(--fg-4)]">{c.source ?? c.description}</span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
