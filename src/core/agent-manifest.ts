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

/** What a person's switch writes into AGENT.md (genie#1569). */
export type ManifestTuiEdit = { kind: 'written'; text: string; tuis: string[] } | { kind: 'unchanged' } | { kind: 'refused'; reason: string };

/**
 * THE PERSON'S CHOICE, WRITTEN INTO THE PERSONA (genie#1569; the owner, 2026-11-05: "I should never be restricted to a
 * provider"). `tuis:` is the persona's default and description, not a lock on the person: after a person switches, the
 * chosen provider goes FIRST in it — the first entry is the default driver (Genie 1's agent-file.ts), the one adoption
 * starts the agent on — and any later entry of it is moved up, not duplicated. No `tuis:` gains `tuis: [<provider>]` as
 * the front matter's last line.
 *
 * The file is a person's and tracked in git, so ONLY the `tuis:` entry changes: every other byte stays, each line keeps
 * its own ending, and a dash list keeps its indent. Read by the same two shapes `parseAgentManifest` reads.
 */
export function manifestWithTui(text: string, provider: string): ManifestTuiEdit {
    const to = provider.trim().toLowerCase();
    const fence = /^---(\r?\n)/.exec(text);
    if (!fence) return { kind: 'refused', reason: 'it has no front matter (the --- block at its top) to hold tuis:' };
    // Lines with their own endings, so a rewrite puts back exactly what it took out.
    const parts = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const ending = (line: string) => (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '');
    const bare = (line: string) => line.replace(/\r?\n$/, '');
    const close = parts.findIndex((line, i) => i > 0 && bare(line) === '---');
    if (close < 0) return { kind: 'refused', reason: 'its front matter (the --- block at its top) is not closed' };
    const eol = fence[1]!;
    for (let i = 1; i < close; i += 1) {
        const line = bare(parts[i]!);
        const inline = /^(tuis:\s*\[)(.*)(\]\s*)$/.exec(line);
        if (inline) {
            const list = inline[2]!.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            if (list[0]?.toLowerCase() === to) return { kind: 'unchanged' };
            const tuis = [to, ...list.filter((s) => s.toLowerCase() !== to)];
            parts[i] = `tuis: [${tuis.join(', ')}]${ending(parts[i]!)}`;
            return { kind: 'written', text: parts.join(''), tuis: tuis.map((s) => s.toLowerCase()) };
        }
        if (/^tuis:\s*$/.test(line)) {
            let end = i + 1;
            while (end < close && /^\s*-\s*/.test(bare(parts[end]!))) end += 1;
            const items = parts.slice(i + 1, end);
            const name = (item: string) => bare(item).replace(/^\s*-\s*/, '').trim();
            if (items.length > 0 && name(items[0]!).toLowerCase() === to) return { kind: 'unchanged' };
            const first = items[0] ?? null;
            const indent = first === null ? '  ' : /^(\s*)-/.exec(bare(first))![1]!;
            const marker = first === null ? '- ' : /^\s*(-\s*)/.exec(bare(first))![1]!;
            const added = `${indent}${marker}${to}${first === null ? ending(parts[i]!) || eol : ending(first)}`;
            const kept = items.filter((item) => name(item).toLowerCase() !== to);
            parts.splice(i + 1, items.length, added, ...kept);
            return { kind: 'written', text: parts.join(''), tuis: [to, ...kept.map((item) => name(item).toLowerCase())] };
        }
    }
    // No `tuis:` at all: one line, the front matter's last, ending as the line before the closing fence does.
    const before = parts[close - 1]!;
    parts.splice(close, 0, `tuis: [${to}]${ending(before) || eol}`);
    return { kind: 'written', text: parts.join(''), tuis: [to] };
}
