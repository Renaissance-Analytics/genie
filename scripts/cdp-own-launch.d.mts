export function descends(pid: number, root: number, parentOf: (pid: number) => number | null): boolean;
export function portOwner(port: number): number | null;
export function notOwnLaunch(port: number, root: number): string | null;
