import { useMemo, useState } from 'react';
import { TreeNav } from '@particle-academy/react-fancy';
import type { TreeNodeData } from '../../lib/genie';

interface Props {
    nodes: TreeNodeData[];
    /** Workspace-relative path of the open file (the TreeNav selectedId). */
    selectedId?: string;
    /** Fires only for file (leaf) selections — folders just expand/collapse. */
    onSelectFile: (relPath: string) => void;
}

/**
 * Thin wrapper around react-fancy's `<TreeNav>`. The main-side
 * `files:list-tree` walk already returns nodes in TreeNodeData shape
 * (id = workspace-relative path, type = file|folder), so this just wires
 * selection + controlled expansion and filters folder clicks out of the
 * file-open callback.
 *
 * Expansion is controlled here (not in the parent) because expand/collapse
 * is pure tree-view state — the parent only cares which FILE is open.
 */
export default function FileTree({ nodes, selectedId, onSelectFile }: Props) {
    const [expanded, setExpanded] = useState<string[]>([]);

    // Set of folder ids so onSelect can distinguish a folder toggle from a
    // file open in O(1).
    const folderIds = useMemo(() => {
        const ids = new Set<string>();
        const walk = (ns: TreeNodeData[]) => {
            for (const n of ns) {
                if (n.type === 'folder') {
                    ids.add(n.id);
                    if (n.children) walk(n.children);
                }
            }
        };
        walk(nodes);
        return ids;
    }, [nodes]);

    return (
        <TreeNav
            nodes={nodes}
            selectedId={selectedId}
            expandedIds={expanded}
            onExpandedChange={setExpanded}
            onSelect={(id) => {
                if (folderIds.has(id)) return; // folder → expand/collapse only
                onSelectFile(id);
            }}
        />
    );
}
