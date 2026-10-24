import type { Buffer } from 'node:buffer';

export function fetchLocalSite(host: string, ca: string | Buffer, port?: number): Promise<{ status: number; body: string }>;
