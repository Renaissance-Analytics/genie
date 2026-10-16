import type { AgentManifest } from './agent-ops.js';

/**
 * THE PERSONA'S OWN WORD (§6.2) — `.agents/<name>/AGENT.md` front matter. `tuis:` is the agent saying
 * which providers may run it; absent means any. Two shapes are read, the ones the envelope actually
 * uses — `tuis: [claude, codex]` and a YAML dash list — with no YAML library behind them.
 */
export function parseAgentManifest(text: string | null, fallbackName: string): AgentManifest {
    if (!text) return { name: fallbackName };
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) return { name: fallbackName };
    const lines = m[1]!.split(/\r?\n/);
    let name = fallbackName;
    let tuis: string[] | undefined;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const nameMatch = /^name:\s*(.+?)\s*$/.exec(line);
        if (nameMatch) name = nameMatch[1]!;
        const inline = /^tuis:\s*\[(.*)\]\s*$/.exec(line);
        if (inline) {
            tuis = inline[1]!.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
            continue;
        }
        if (/^tuis:\s*$/.test(line)) {
            tuis = [];
            while (i + 1 < lines.length && /^\s*-\s*/.test(lines[i + 1]!)) {
                i += 1;
                tuis.push(lines[i]!.replace(/^\s*-\s*/, '').trim().toLowerCase());
            }
        }
    }
    return tuis ? { name, tuis } : { name };
}
