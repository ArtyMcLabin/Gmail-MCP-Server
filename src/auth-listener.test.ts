import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { listenLoopback, isPrimaryBindMissing, portOwnerHint, LOOPBACK_HOSTS } from './auth-listener.js';

const openListeners: http.Server[] = [];

afterEach(async () => {
    const closing = openListeners.splice(0);
    // Keep-alive connections (undici's fetch pool) hold server.close() open
    // until they idle out; drop them so the afterEach hook finishes.
    for (const server of closing) server.closeAllConnections?.();
    await Promise.all(closing.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function listenEphemeral(host: string): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer();
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
            const address = server.address();
            if (address === null || typeof address === 'string') reject(new Error('unexpected address'));
            else resolve({ server, port: address.port });
        });
        openListeners.push(server);
    });
}

/** A port that is (almost certainly) free: borrow one from an ephemeral bind, then release it. */
async function freePort(): Promise<number> {
    const { server, port } = await listenEphemeral('127.0.0.1');
    openListeners.splice(openListeners.indexOf(server), 1);
    await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
    });
    return port;
}

describe('listenLoopback', () => {
    it('binds every requested loopback stack and serves requests on each', async () => {
        const port = await freePort();
        const hits: string[] = [];
        const listener = await listenLoopback(port, (_req, res) => {
            hits.push('hit');
            res.writeHead(200);
            res.end('ok');
        });
        try {
            expect(listener.bound.sort()).toEqual([...LOOPBACK_HOSTS].sort());
            expect(listener.failures).toEqual([]);

            for (const host of LOOPBACK_HOSTS) {
                const url = host === '::1' ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`;
                const response = await fetch(url);
                expect(response.status).toBe(200);
            }
            expect(hits.length).toBe(LOOPBACK_HOSTS.length);
        } finally {
            await listener.close();
        }
    });

    it('reports a busy host as a failure instead of rejecting, and still binds the others', async () => {
        // Occupy ::1 only, so the ::1 bind attempt inside listenLoopback must fail.
        const hijacker = await listenEphemeral('::1');
        const blocker = await listenEphemeral('127.0.0.1');
        expect(hijacker.port).toBeGreaterThan(0);

        const listener = await listenLoopback(hijacker.port, () => {});
        try {
            expect(listener.bound).toContain('127.0.0.1');
            const busy = listener.failures.find(({ host }) => host === '::1');
            expect(busy).toBeDefined();
            expect(busy?.error.code).toBe('EADDRINUSE');
        } finally {
            await listener.close();
        }
    });

    it('close() stops serving on every stack', async () => {
        const port = await freePort();
        const listener = await listenLoopback(port, () => {});
        await listener.close();
        for (const host of LOOPBACK_HOSTS) {
            const url = host === '::1' ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`;
            await expect(fetch(url)).rejects.toThrow();
        }
    });
});

describe('isPrimaryBindMissing', () => {
    it('is true when nothing bound', () => {
        expect(isPrimaryBindMissing({ bound: [], failures: [], close: () => Promise.resolve() })).toBe(true);
    });

    it('is true when only the non-primary stack bound', () => {
        expect(isPrimaryBindMissing({ bound: ['::1'], failures: [], close: () => Promise.resolve() })).toBe(true);
    });

    it('is false when the primary stack bound', () => {
        expect(isPrimaryBindMissing({ bound: ['::1', '127.0.0.1'], failures: [], close: () => Promise.resolve() })).toBe(false);
        expect(isPrimaryBindMissing({ bound: ['127.0.0.1'], failures: [], close: () => Promise.resolve() })).toBe(false);
    });
});

describe('portOwnerHint', () => {
    it('formats the lsof command for the port', () => {
        expect(portOwnerHint(3000)).toBe('lsof -nP -iTCP:3000 -sTCP:LISTEN');
    });
});
