import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalJson, sha256Hex } from './deploy-plan.js';

/**
 * DEPLOYMENT: THE AUDIT LOG (Tynn #871; spec .ai/plans/specs/deployment.md §4.7).
 *
 * Append-only JSONL in host state (`deploy-audit.jsonl`): one record per plan, approval, rejection, apply step, provider
 * error and credential event. Each line carries `prev` (the previous line's hash) and `hash` (over `prev` and the line's
 * own content), so editing or deleting any past line is found by `verify()`, which names the first line that fails.
 *
 * IT NEVER HOLDS A SECRET. Before a line is written, `redactSecrets` removes:
 * - every token Genie holds for a cloud account, wherever it appears (`knownSecrets`), whatever its shape;
 * - known key formats: DigitalOcean `dop_v1_`, Vercel `vcp_`, AWS access key ids, `Bearer …`;
 * - the value of any secret-named field (token, secret, password, api key, authorization, value);
 * - the values of env vars (the names stay: "set DB_PASSWORD" is the record, its value is not).
 */

export type AuditActor = { readonly kind: 'person' } | { readonly kind: 'agent'; readonly name: string; readonly workspace: string } | { readonly kind: 'genie' };

export interface AuditRecord {
    readonly actor: AuditActor;
    readonly action: string;
    readonly result: string;
    readonly accountId?: string;
    readonly target?: string;
    readonly planHash?: string;
    readonly approvalId?: string;
    readonly requestId?: string;
    readonly estimate?: unknown;
}

export type AuditVerdict = { readonly ok: true; readonly records: number } | { readonly ok: false; readonly line: number; readonly reason: string };

export const REDACTED = '[redacted]';
const GENESIS = '0'.repeat(64);

const KEY_FORMATS: readonly RegExp[] = [
    /dop_v1_[A-Za-z0-9]{16,}/g,
    /\bvcp_[A-Za-z0-9]{16,}/g,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
const SECRET_FIELD = /^(?:token|access_?token|refresh_?token|secret|client_?secret|password|passphrase|api_?key|access_?key|secret_?access_?key|private_?key|authorization|value)$/i;
const ENV_FIELD = /^(?:env|env_?vars|environment_?variables|variables|secrets)$/i;

function redactText(text: string, known: readonly string[]): string {
    let out = text;
    for (const secret of known) if (secret.length > 0) out = out.split(secret).join(REDACTED);
    for (const pattern of KEY_FORMATS) out = out.replace(pattern, REDACTED);
    return out;
}

/** The value with every secret removed (a new value; the input is not changed). */
export function redactSecrets(value: unknown, known: readonly string[]): unknown {
    if (typeof value === 'string') return redactText(value, known);
    if (Array.isArray(value)) return value.map((item) => redactSecrets(item, known));
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            if (SECRET_FIELD.test(key)) out[key] = REDACTED;
            else if (ENV_FIELD.test(key) && item !== null && typeof item === 'object' && !Array.isArray(item)) {
                out[key] = Object.fromEntries(Object.keys(item).map((name) => [redactText(name, known), REDACTED]));
            } else out[key] = redactSecrets(item, known);
        }
        return out;
    }
    return value;
}

const lineHash = (prev: string, body: unknown): string => sha256Hex(`${prev}\n${canonicalJson(body)}`);

export class DeployAudit {
    readonly #file: string;
    readonly #knownSecrets: () => readonly string[];
    readonly #now: () => number;
    #prev: string | null = null;
    #tail: Promise<unknown> = Promise.resolve();

    constructor(file: string, options: { readonly knownSecrets: () => readonly string[]; readonly now?: () => number }) {
        this.#file = file;
        this.#knownSecrets = options.knownSecrets;
        this.#now = options.now ?? Date.now;
    }

    /** Appends one record. Appends are written one at a time, in call order, so the chain never forks. */
    append(record: AuditRecord): Promise<void> {
        const run = this.#tail.then(() => this.#write(record));
        this.#tail = run.catch(() => undefined);
        return run;
    }

    async #write(record: AuditRecord): Promise<void> {
        this.#prev ??= await this.#lastHash();
        const body = redactSecrets({ at: new Date(this.#now()).toISOString(), ...record }, this.#knownSecrets()) as Record<string, unknown>;
        const prev = this.#prev;
        const hash = lineHash(prev, body);
        await mkdir(dirname(this.#file), { recursive: true });
        await appendFile(this.#file, `${JSON.stringify({ ...body, prev, hash })}\n`, { mode: 0o600 });
        this.#prev = hash;
    }

    async #lines(): Promise<string[]> {
        let text: string;
        try {
            text = await readFile(this.#file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        return text.split('\n').filter((line) => line.trim().length > 0);
    }

    async #lastHash(): Promise<string> {
        const lastLine = (await this.#lines()).at(-1);
        if (lastLine === undefined) return GENESIS;
        const last = JSON.parse(lastLine) as { hash?: unknown };
        if (typeof last.hash !== 'string') throw new Error('The deploy audit log\'s last line has no hash; it was changed outside Genie.');
        return last.hash;
    }

    /** Walks the chain from the first line; names the first line that was edited, removed after, or is not a record. */
    async verify(): Promise<AuditVerdict> {
        const lines = await this.#lines();
        let prev = GENESIS;
        for (const [i, line] of lines.entries()) {
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(line) as Record<string, unknown>;
            } catch {
                return { ok: false, line: i + 1, reason: 'not a JSON record' };
            }
            const { prev: claimedPrev, hash, ...body } = parsed;
            if (claimedPrev !== prev) return { ok: false, line: i + 1, reason: 'the chain is broken here: a line before it was removed or changed' };
            if (hash !== lineHash(prev, body)) return { ok: false, line: i + 1, reason: 'this line was edited after it was written' };
            prev = hash as string;
        }
        return { ok: true, records: lines.length };
    }
}
