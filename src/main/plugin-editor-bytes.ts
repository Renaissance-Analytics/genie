import type { EditorBytesDecision } from '../core/plugin-editors.js';
import type { BytesResult, BytesWriteResult } from './files-host.js';

/**
 * THE PLUGIN GATE IN FRONT OF A FILE'S BYTES (beta.33 item 14; Genie 1 editor-bridge.ts). The renderer's plugin editor asks
 * for a file's bytes NAMING the plugin whose editor holds it; the bytes move only when that plugin is enabled and its own
 * editor claims the type AND its fs capability declares it (`PluginHost.editorBytes`). Anything else is refused before the
 * disk is touched. Kept out of main.ts so the rule is tested without Electron; main.ts only forwards the IPC arguments.
 */

export interface EditorBytesDeps {
    readonly gate: (pluginId: string, path: string) => EditorBytesDecision;
    readonly files: {
        readBytes(workspaceId: string, path: string): Promise<BytesResult>;
        writeBytes(workspaceId: string, path: string, base64: string, expectedSha: string | null): Promise<BytesWriteResult>;
    };
}

const str = (v: unknown): v is string => typeof v === 'string';

export async function editorRead(deps: EditorBytesDeps, workspaceId: unknown, pluginId: unknown, path: unknown): Promise<BytesResult> {
    if (!str(workspaceId) || !str(pluginId) || !str(path)) return { ok: false, path: str(path) ? path : '', error: 'bad arguments' };
    const decision = deps.gate(pluginId, path);
    if (!decision.allowed) return { ok: false, path, error: decision.reason };
    return deps.files.readBytes(workspaceId, path);
}

export async function editorWrite(deps: EditorBytesDeps, workspaceId: unknown, pluginId: unknown, path: unknown, base64: unknown, expectedSha: unknown): Promise<BytesWriteResult> {
    if (!str(workspaceId) || !str(pluginId) || !str(path) || !str(base64)) return { ok: false, reason: 'bad arguments' };
    const decision = deps.gate(pluginId, path);
    if (!decision.allowed) return { ok: false, reason: decision.reason };
    return deps.files.writeBytes(workspaceId, path, base64, str(expectedSha) ? expectedSha : null);
}
