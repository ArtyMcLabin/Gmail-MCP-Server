/**
 * Loopback HTTP listeners for the `auth` OAuth callback.
 *
 * The consent URL this server prints uses `localhost`, and browsers resolve
 * `localhost` to IPv6 `::1` first on most modern platforms. A listener bound
 * only to `127.0.0.1` never sees the callback when another process holds
 * `[::1]:port` — the browser tab loads the redirect with a fresh code, nothing
 * errors, and no token is written. Binding both loopback stacks closes that
 * gap, and reporting a `::1` bind failure turns the silent hijack into a
 * visible warning.
 */
import * as http from 'http';

export type LoopbackHost = '127.0.0.1' | '::1';

/** The hosts a localhost callback URL can land on, in browser resolution order. */
export const LOOPBACK_HOSTS: readonly LoopbackHost[] = ['::1', '127.0.0.1'];

export interface LoopbackListener {
    /** Hosts successfully bound. */
    bound: LoopbackHost[];
    /** Hosts that could not be bound, each with the bind error. */
    failures: Array<{ host: LoopbackHost; error: NodeJS.ErrnoException }>;
    close(): Promise<void>;
}

/**
 * Bind the callback handler on every loopback stack for `port`.
 *
 * Resolves with what bound and what failed; it never rejects for a busy host —
 * the caller decides whether a failure is fatal (see `isPrimaryBindMissing`).
 * The primary `127.0.0.1` binding is expected to work; a failure there means
 * the callback can never arrive.
 */
export async function listenLoopback(
    port: number,
    handler: http.RequestListener,
    hosts: readonly LoopbackHost[] = LOOPBACK_HOSTS
): Promise<LoopbackListener> {
    const servers = hosts.map((host) => ({ host, server: http.createServer(handler) }));
    const bound: LoopbackHost[] = [];
    const failures: LoopbackListener['failures'] = [];

    await Promise.all(
        servers.map(async ({ host, server }) => {
            // Executor form, not Promise.withResolvers: the package supports
            // node >=14 and withResolvers landed in Node 22.
            const bound_ = new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.removeListener('error', reject);
                    resolve();
                });
            });
            try {
                await bound_;
                bound.push(host);
            } catch (error) {
                failures.push({ host, error: error as NodeJS.ErrnoException });
            }
        })
    );

    // Lazy close: must not fire until the caller asks, or the listener stops
    // serving before the consent redirect ever arrives.
    let closeRequested = false;
    let closeResolve!: () => void;
    // Executor form, not Promise.withResolvers: the package supports
    // node >=14 and withResolvers landed in Node 22.
    const closed = new Promise<void>((resolve) => {
        closeResolve = resolve;
    });

    return {
        bound,
        failures,
        close: () => {
            if (closeRequested) return closed;
            closeRequested = true;
            let pending = servers.length;
            if (pending === 0) closeResolve();
            for (const { server } of servers) server.close(() => (pending -= 1) === 0 && closeResolve());
            return closed;
        },
    };
}

/**
 * Whether the listener cannot receive the callback at all: nothing bound on
 * any loopback stack, or only the non-primary one. A `::1`-only bind still
 * serves Chrome's default `localhost` resolution, but `127.0.0.1` is what the
 * URL-derived port derivation and most manual checks assume.
 */
export function isPrimaryBindMissing(listener: LoopbackListener): boolean {
    return listener.bound.length === 0 || !listener.bound.includes('127.0.0.1');
}

/** The `lsof` command that names the process holding a busy loopback port. */
export function portOwnerHint(port: number): string {
    return `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}
