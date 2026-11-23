export interface ProcessRow { pid: number; ppid: number; created: number; name: string; cmd: string }
export interface EndPorts {
    table(): Promise<ProcessRow[]>;
    taskkillTree(pid: number): { status: number | null; out: string; err: string; ms: number };
    kill(pid: number): void;
    alive(pid: number): boolean;
    sleep(ms: number): Promise<void>;
    now(): number;
    log(line: string): void;
}
export interface EndResult { ok: boolean; left: ProcessRow[]; ended: number; ms: number }
export function parseProcessTable(text: string): ProcessRow[];
export function treeOf(rows: readonly ProcessRow[], roots: readonly number[], since: number): Map<number, ProcessRow>;
export function endOwnTree(input: { roots: ReadonlyArray<{ pid: number | null | undefined; what: string }>; treeRoot?: number | null; since: number; boundMs?: number; ports: EndPorts }): Promise<EndResult>;
export function endOwnRun(input: { app?: { pid?: number } | null; hostPid?: number | null; others?: readonly number[]; since: number; boundMs?: number; log?: (line: string) => void }): Promise<EndResult>;
