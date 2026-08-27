import { panelAdapterKind } from '../../lib/plugin-panel-adapters';
import RepoChangesPanel from './RepoChangesPanel';
import ArtBoardPanel from './ArtBoardPanel';
import type { TerminalSpec, WorkspaceRow } from '../../lib/genie';

/**
 * The chrome-free BODY of a plugin PANEL. Resolves the spec's declared
 * `fancy_export` to a KNOWN first-party adapter through the compile-time registry
 * (`panelAdapterKind`) and STATICALLY renders it — the renderer cannot import an
 * arbitrary declared package, and an unknown / unvetted export renders an inert
 * placeholder rather than running anything (fail-closed, design §12). Each adapter
 * is Genie-authored and built only from vetted Fancy components.
 */

interface Props {
    spec: TerminalSpec;
    workspace?: WorkspaceRow;
}

export default function PluginPanelBody({ spec, workspace }: Props) {
    const fancyExport = String(spec.meta?.fancy_export ?? '');
    const kind = panelAdapterKind(fancyExport);

    if (kind === 'repo-changes') {
        return <RepoChangesPanel workspace={workspace} fallbackRoot={workspace?.path ?? spec.cwd} />;
    }

    if (kind === 'artboard') {
        return <ArtBoardPanel workspace={workspace} fallbackRoot={workspace?.path ?? spec.cwd} />;
    }

    return (
        <div className="code-empty">
            <span>
                This plugin panel isn’t available in this version of Genie. Update Genie to use it.
            </span>
        </div>
    );
}
