import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SyncFs } from './config-sync-targets.js';
import { McpPreparationError } from './mcp-preparation-error.js';
import { TYNN_TOML_BEGIN, TYNN_TOML_END } from './tynn-agent-token.js';

const object = (v: unknown): Record<string, unknown> | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const refuse = (): never => { throw new McpPreparationError('config'); };

function jsonWithoutLegacy(text: string): string {
    const data = object(JSON.parse(text));
    if (!data) return refuse();
    if (!Object.hasOwn(data, 'mcpServers')) return text;
    const servers = object(data.mcpServers);
    if (!servers) return refuse();
    if (!Object.hasOwn(servers, 'tynn')) return text;
    // JSON has no ownership markers. Recognize only the exact shape Genie wrote; custom entries need a decision.
    const entry = object(servers.tynn); const headers = object(entry?.headers);
    if (!entry || !headers || Object.keys(entry).some((k) => !['type', 'url', 'headers'].includes(k))
        || (entry.type !== undefined && entry.type !== 'http') || !['https://tynn.ai/mcp', 'https://tynn.ai/mcp/tynn'].includes(String(entry.url))
        || Object.keys(headers).length !== 1 || typeof headers.Authorization !== 'string' || !/^Bearer\s+\S/.test(headers.Authorization)) return refuse();
    const remaining = { ...servers }; delete remaining.tynn;
    return `${JSON.stringify({ ...data, mcpServers: remaining }, null, 2)}\n`;
}

/** Markers inside literal/basic strings are examples or user instructions, never ownership boundaries. */
function outsideString(text: string, end: number): boolean {
    let quote: string | null = null;
    for (let i = 0; i < end; i++) {
        if (quote === null) {
            if (text[i] === '#') { const newline = text.indexOf('\n', i); if (newline < 0 || newline >= end) return false; i = newline; }
            else if (text[i] === '"' || text[i] === "'") {
                const triple = text[i]!.repeat(3);
                if (text.startsWith(triple, i)) { quote = triple; i += 2; } else quote = text[i]!;
            }
        } else if ((quote === '"' || quote === '"""') && text[i] === '\\') i++;
        else if (text.startsWith(quote, i)) { i += quote.length - 1; quote = null; }
    }
    return quote === null;
}

function withoutBlock(text: string, begin: string, end: string): string {
    while (text.includes(begin) || text.includes(end)) {
        const b = text.indexOf(begin); const e = text.indexOf(end);
        if (b < 0 || e < b || (b > 0 && text[b - 1] !== '\n') || (e > 0 && text[e - 1] !== '\n')) return refuse();
        if (!outsideString(text, b) || !outsideString(text, e)) return refuse();
        const nextBegin = text.indexOf(begin, b + begin.length);
        if (nextBegin >= 0 && nextBegin < e) return refuse();
        // Markers are complete lines; never remove text before a marker or after its final line.
        const beginLine = text.slice(b, text.indexOf('\n', b) < 0 ? text.length : text.indexOf('\n', b)).trimEnd();
        if (beginLine !== begin) return refuse();
        const after = text.indexOf('\n', e + end.length);
        text = text.slice(0, b) + (after < 0 ? '' : text.slice(after + 1));
    }
    return text;
}

function tomlWithoutLegacy(text: string): string {
    const next = withoutBlock(withoutBlock(text, TYNN_TOML_BEGIN, TYNN_TOML_END), '# BEGIN GENIE MCP: tynn', '# END GENIE MCP: tynn');
    // Scan individual lines: avoid nested whole-file patterns on user-controlled configuration.
    let mcpRoot = false;
    for (const line of next.split(/\r?\n/)) {
        if (/^\s*\[\s*["']?mcp_servers["']?\s*\.\s*["']?tynn["']?(?:\s*[.\]])/.test(line)
            || /^\s*["']?mcp_servers["']?\s*\.\s*["']?tynn["']?\s*=/.test(line)
            || (mcpRoot && /^\s*["']?tynn["']?\s*=/.test(line))) return refuse();
        if (/^\s*\[/.test(line)) mcpRoot = /^\s*\[\s*["']?mcp_servers["']?\s*\]/.test(line);
    }
    return next;
}

/** Read/parse every file before any write; an unknown entry is preserved and blocks provider startup. */
export async function reconcileLegacyTynnConfig(input: { workspacePath: string; fs: SyncFs }): Promise<void> {
    try {
        const plans: Array<{ path: string; before: string; after: string }> = [];
        for (const file of ['.mcp.json', '.cursor/mcp.json', '.codex/config.toml']) {
            const path = join(input.workspacePath, file).replace(/\\/g, '/');
            const before = await input.fs.read(path);
            if (before === null) continue;
            const after = file.endsWith('.toml') ? tomlWithoutLegacy(before) : jsonWithoutLegacy(before);
            if (before !== after) plans.push({ path, before, after });
        }
        for (const plan of plans) {
            if (await input.fs.read(plan.path) !== plan.before) return refuse();
            await input.fs.write(plan.path, plan.after);
        }
    } catch { throw new McpPreparationError('config'); }
}

/** A missing file is distinct from unreadable storage. Final files and harness directories cannot be links. */
export function nodeTynnConfigFs(workspacePath: string): SyncFs {
    const inspect = async (path: string, directory: boolean) => {
        try {
            const stat = await lstat(path);
            if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) return refuse();
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
    const check = async (path: string) => {
        if (dirname(path) !== workspacePath) await inspect(dirname(path), true);
        await inspect(path, false);
    };
    return {
        read: async (path) => {
            await check(path);
            try { return await readFile(path, 'utf8'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
        },
        write: async (path, text) => { await check(path); await writeFile(path, text, 'utf8'); },
    };
}
