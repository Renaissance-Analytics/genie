import { Callout, ContentRenderer, JsonEditor } from '@particle-academy/react-fancy';
// From the renderer-safe module: `core/plugins.ts` pulls in node:crypto and must never reach this bundle.
import { VETTED_FANCY_EXPORTS, type VettedFancyExport } from '../../core/plugin-panels.js';

/**
 * A PLUGIN'S PANEL IN THE WORKSPACE GRID (§4.6 `+plugin`, §6.7). It mounts ONLY a vetted Genie-bundled
 * Fancy component — the manifest names the export and the props; there is no plugin code in the renderer
 * to run (v1's owner rule, kept). The map below IS the vetted list made real: an export the manifest named
 * that is not here renders a refusal, never a component, and the parser refuses it earlier still.
 */

export interface PluginPanelView {
    readonly pluginId: string;
    readonly pluginName: string;
    readonly id: string;
    readonly title: string;
    readonly fancyComponent: { readonly export: VettedFancyExport };
    readonly props: Readonly<Record<string, unknown>>;
}

export function PluginPane({ panel }: { panel: PluginPanelView }) {
    const key = `${panel.pluginId}/${panel.id}`;
    if (!(VETTED_FANCY_EXPORTS as readonly string[]).includes(panel.fancyComponent.export)) {
        return (
            <section data-plugin-pane-refused={key} className="flex h-full flex-col gap-2 p-3 text-[13px] text-[var(--fg-3)]">
                <p>{panel.pluginName} asked for {String(panel.fancyComponent.export)}, which is not a vetted Fancy component; this panel is not drawn.</p>
            </section>
        );
    }
    const props = panel.props;
    return (
        <section data-plugin-pane={key} className="flex h-full min-h-0 flex-col">
            <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-3 text-sm">
                <span className="font-medium">{panel.title}</span>
                <span className="font-mono text-[11px] text-[var(--fg-4)]">{panel.pluginName}</span>
            </header>
            <div data-fancy-export={panel.fancyComponent.export} className="min-h-0 flex-1 overflow-auto p-3">
                {panel.fancyComponent.export === 'ContentRenderer' ? (
                    <ContentRenderer value={typeof props.value === 'string' ? props.value : ''} format={props.format === 'html' || props.format === 'auto' ? props.format : 'markdown'} />
                ) : panel.fancyComponent.export === 'JsonEditor' ? (
                    <JsonEditor value={(props.value ?? {}) as never} />
                ) : (
                    <Callout>{typeof props.text === 'string' ? props.text : ''}</Callout>
                )}
            </div>
        </section>
    );
}
