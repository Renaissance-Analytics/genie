/**
 * Pty-host wire protocol (Tier 3).
 *
 * The detached pty-host (main/terminal/pty-host.ts) and the in-app HostClient
 * (main/terminal/host-client.ts) talk over a local IPC transport — a named pipe
 * on Windows, a unix domain socket on POSIX — using a tiny length-prefixed JSON
 * framing so there's no heavy dependency. This module is PURE (no electron, no
 * node-pty, no net): just the message shapes + the encode/decode for the framing,
 * so it can be imported by both ends AND unit-tested in isolation.
 *
 * Framing: each message is `[4-byte big-endian uint32 length][utf8 JSON body]`.
 * The length prefix is the byte length of the JSON body. A FrameDecoder buffers
 * partial reads and yields whole messages as they complete — TCP/pipe streams
 * don't preserve message boundaries, so we can't assume one `data` event == one
 * message.
 */

/**
 * Protocol version. Bumped whenever the message shapes change in a way that
 * makes an old host incompatible with a new client (or vice-versa). The client
 * refuses to attach to a host whose pidfile reports a different version and
 * spawns a fresh host instead — see host-client.ts connect-or-spawn.
 */
export const PROTOCOL_VERSION = 1;

/** Requests the client sends to the host. `seq` correlates a reply. */
export type ClientMessage =
    | { kind: 'hello'; seq: number; protocolVersion: number }
    | {
          kind: 'create';
          seq: number;
          opts: {
              id: string;
              cwd: string;
              shell?: string;
              args?: string[];
              cols?: number;
              rows?: number;
              env?: Record<string, string>;
          };
      }
    | { kind: 'write'; id: string; data: string }
    | { kind: 'resize'; id: string; cols: number; rows: number }
    | { kind: 'kill'; id: string }
    | { kind: 'list'; seq: number }
    | { kind: 'set-retained'; id: string; retained: boolean }
    | { kind: 'get-scrollback'; seq: number; id: string }
    | { kind: 'ping'; seq: number };

/** Pushes + replies the host sends to the client. */
export type HostMessage =
    | { kind: 'hello-ok'; seq: number; protocolVersion: number; pid: number }
    | {
          kind: 'created';
          seq: number;
          result: {
              id: string;
              pid: number;
              shell: string;
              existing: boolean;
              scrollback: string;
          };
      }
    | {
          kind: 'list-result';
          seq: number;
          terminals: Array<{ id: string; pid: number; shell: string }>;
      }
    | { kind: 'scrollback-result'; seq: number; scrollback: string | null }
    | { kind: 'pong'; seq: number }
    | { kind: 'data'; id: string; data: string }
    | { kind: 'exit'; id: string; exitCode: number; signal?: number };

export type Frame = ClientMessage | HostMessage;

const LENGTH_BYTES = 4;

/** Encode a message as a length-prefixed JSON frame ready for the socket. */
export function encodeFrame(msg: Frame): Buffer {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.allocUnsafe(LENGTH_BYTES);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}

/**
 * Streaming frame decoder. Feed it raw socket chunks via `push`; it returns the
 * complete messages that became available (zero or more), buffering any partial
 * tail until the rest arrives. One decoder per socket.
 *
 * Resilient by design: a malformed JSON body is skipped (the frame is consumed
 * but yields nothing) rather than throwing — a corrupt frame must not wedge the
 * whole stream. An absurd length prefix (> MAX_FRAME) is treated as a desync and
 * the buffer is reset; the caller can decide whether to drop the connection.
 */
export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0);

    /** Hard cap on a single frame (16 MB). Guards against a runaway/garbage
     *  length prefix allocating unbounded memory. node-pty data chunks are tiny;
     *  a serialized scrollback is bounded well under this. */
    static readonly MAX_FRAME = 16 * 1024 * 1024;

    /** True when the last push hit an oversized/desynced frame. The caller
     *  should drop the connection — the stream can't be trusted to realign. */
    desynced = false;

    push(chunk: Buffer): Frame[] {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        const out: Frame[] = [];
        for (;;) {
            if (this.buffer.length < LENGTH_BYTES) break;
            const len = this.buffer.readUInt32BE(0);
            if (len > FrameDecoder.MAX_FRAME) {
                // Desync / garbage. Reset and flag — realigning a length-prefixed
                // stream after a bad prefix isn't possible without a sentinel.
                this.desynced = true;
                this.buffer = Buffer.alloc(0);
                break;
            }
            if (this.buffer.length < LENGTH_BYTES + len) break; // wait for more
            const body = this.buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + len);
            this.buffer = this.buffer.subarray(LENGTH_BYTES + len);
            try {
                out.push(JSON.parse(body.toString('utf8')) as Frame);
            } catch {
                /* skip a corrupt frame; the framing itself is still aligned */
            }
        }
        return out;
    }
}
