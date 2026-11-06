import type { StreamEvent } from './stream-event.js';

/**
 * BOUNDED TOOL ROWS (Tynn story #386; .ai/plans/genie-crash-safe-mode-reporting-spec.md §3).
 *
 * The window's main hung twice on 2026-11-06 on an agent ledger of 959 MB / 384,564 rows: rows up to 238 KB, each tool
 * stored twice (in_progress and completed), and a boot that loaded 3,000 of them per agent with no byte bound. So a
 * tool row keeps at most {@link TOOL_PREVIEW_BYTES} of its input and of its output. The whole output goes in a sidecar
 * file beside the ledger, named by the row's `outputFile`, and is read only when a person opens the row. An
 * `in_progress` (or `pending`) row carries no output at all: the call's answer is the terminal row's.
 *
 * Pure (no node modules): the session writes with it, the thread store reads old ledgers with it.
 */
export const TOOL_PREVIEW_BYTES = 16 * 1024;

/** What the window gets back when it asks for a tool row's whole output (`agents.toolOutput`). */
export type ToolOutputReply = { ok: true; text: string; bytes: number; cut: boolean } | { ok: false; reason: string };

type ToolEvent = Extract<StreamEvent, { kind: 'tool' }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Bytes(text: string): number {
    return encoder.encode(text).length;
}

/** The longest head of `text` that is at most `maxBytes` of UTF-8, cut on a character boundary. */
export function utf8Head(text: string, maxBytes: number): string {
    // A string of n UTF-16 units is at most 3n bytes: short enough strings need no encoding at all.
    if (text.length * 3 <= maxBytes) return text;
    const bytes = encoder.encode(text);
    if (bytes.length <= maxBytes) return text;
    let end = Math.max(0, maxBytes);
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return decoder.decode(bytes.subarray(0, end));
}

/**
 * The sidecar's file name for a call: `tool-<id>.out`. An id that is not a plain file name (a path separator, a dot
 * first, an odd character, a very long id) is made one: its odd characters become `_` and a hash of the whole id keeps
 * two such ids apart.
 */
export function toolOutputFileName(toolCallId: string): string {
    if (/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(toolCallId)) return `tool-${toolCallId}.out`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < toolCallId.length; i += 1) hash = Math.imul(hash ^ toolCallId.charCodeAt(i), 0x01000193) >>> 0;
    return `tool-${toolCallId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}-${hash.toString(16).padStart(8, '0')}.out`;
}

function jsonBytes(value: unknown): number | null {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? null : utf8Bytes(text);
    } catch {
        return null;
    }
}

/** `value` with every string cut to `cap` bytes, arrays to their first 32 items and nesting to 6 levels: its shape kept. */
function shrink(value: unknown, cap: number, depth: number): unknown {
    if (typeof value === 'string') return utf8Bytes(value) > cap ? `${utf8Head(value, cap)}…` : value;
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 6) return '…';
    if (Array.isArray(value)) {
        const head = value.slice(0, 32).map((v) => shrink(v, cap, depth + 1));
        return value.length > 32 ? [...head, `… ${value.length - 32} more`] : head;
    }
    const out: Record<string, unknown> = {};
    let keys = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (keys >= 64) { out['…'] = 'more fields'; break; }
        out[k] = shrink(v, cap, depth + 1);
        keys += 1;
    }
    return out;
}

/**
 * A tool's input as a preview of at most {@link TOOL_PREVIEW_BYTES} of JSON, or `null` when it already fits. The
 * preview keeps the input's SHAPE — its fields, with long strings cut — because the stream reads an edit's path and a
 * command's text from it; only an input that will not fit even so becomes the head of its JSON, as a string.
 */
export function previewInput(raw: unknown): { rawInput: unknown; inputBytes: number } | null {
    const bytes = jsonBytes(raw);
    if (bytes === null || bytes <= TOOL_PREVIEW_BYTES) return null;
    for (let cap = TOOL_PREVIEW_BYTES / 2; cap >= 64; cap = Math.floor(cap / 2)) {
        const shrunk = shrink(raw, cap, 0);
        const size = jsonBytes(shrunk);
        if (size !== null && size <= TOOL_PREVIEW_BYTES) return { rawInput: shrunk, inputBytes: bytes };
    }
    return { rawInput: `${utf8Head(JSON.stringify(raw), TOOL_PREVIEW_BYTES - 8)}…`, inputBytes: bytes };
}

/** A call still running carries no output: its answer is the terminal row's (the spec: only `completed` does). */
function stillRunning(event: ToolEvent): boolean {
    return event.status === 'in_progress' || event.status === 'pending';
}

/**
 * A tool row as it is written and shown: input and output cut to their previews, an unfinished call's output dropped.
 * `whole` is the output that did not fit, for the sidecar; `null` when nothing was cut (or the event is no tool row).
 *
 * `sidecar: false` is the READ of a row already stored (an old ledger's): it is cut the same way, but names no sidecar
 * unless it already did, so the window never offers a whole that was never kept.
 */
export function boundToolEvent(event: StreamEvent, options: { sidecar: boolean }): { event: StreamEvent; whole: string | null } {
    if (event.kind !== 'tool') return { event, whole: null };
    let next: ToolEvent = event;
    let whole: string | null = null;
    const input = previewInput(event.rawInput);
    if (input) next = { ...next, rawInput: input.rawInput, inputBytes: input.inputBytes };
    if (next.output !== undefined && stillRunning(next)) {
        const { output: _dropped, outputBytes: _bytes, outputFile: _file, ...rest } = next;
        next = rest;
    } else if (typeof next.output === 'string') {
        const bytes = utf8Bytes(next.output);
        if (bytes > TOOL_PREVIEW_BYTES) {
            const { outputFile, ...rest } = next;
            const file = options.sidecar ? toolOutputFileName(next.toolCallId) : outputFile;
            next = { ...rest, output: utf8Head(next.output, TOOL_PREVIEW_BYTES), outputBytes: next.outputBytes ?? bytes, ...(file !== undefined ? { outputFile: file } : {}) };
            if (options.sidecar) whole = event.output!;
        }
    }
    return { event: next === event ? event : next, whole };
}
