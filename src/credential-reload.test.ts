import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ReloadingOAuth2Client, isInvalidGrant, readStoredRefreshToken } from './credential-reload.js';

const tempDirs: string[] = [];

afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-reload-'));
    tempDirs.push(dir);
    return dir;
}

function credentialsFile(value: unknown): string {
    const file = path.join(makeTempDir(), 'credentials.json');
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
}

function missingFile(): string {
    return path.join(makeTempDir(), 'credentials.json');
}

// Shape google-auth-library throws when the token endpoint rejects a refresh grant.
function invalidGrantError(): Error {
    return Object.assign(new Error('invalid_grant'), {
        response: { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } },
    });
}

/**
 * A real ReloadingOAuth2Client whose token endpoint is stubbed: Google accepts
 * only the refresh tokens in `accepted`. The in-memory access token is expired,
 * so the next token request goes to the endpoint.
 */
function makeClient(credentialsPath: string, accepted: string[], failure: () => Error = invalidGrantError) {
    const client = new ReloadingOAuth2Client('cid', 'secret', 'http://localhost:3000/oauth2callback', credentialsPath);
    client.setCredentials({ refresh_token: 'old', access_token: 'expired', expiry_date: 1 });
    const exchanged: string[] = [];
    (client as unknown as { transporter: unknown }).transporter = {
        async request(opts: { data: string }) {
            const refreshToken = new URLSearchParams(opts.data).get('refresh_token') ?? '';
            exchanged.push(refreshToken);
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (!accepted.includes(refreshToken)) throw failure();
            return { data: { access_token: `access-for-${refreshToken}`, expires_in: 3600, token_type: 'Bearer' } };
        },
    };
    return { client, exchanged };
}

describe('isInvalidGrant', () => {
    it('matches a rejected refresh grant', () => {
        expect(isInvalidGrant(invalidGrantError())).toBe(true);
    });

    it('ignores other failures', () => {
        expect(isInvalidGrant(new Error('socket hang up'))).toBe(false);
        expect(isInvalidGrant({ response: { data: { error: 'invalid_client' } } })).toBe(false);
        expect(isInvalidGrant(null)).toBe(false);
    });
});

describe('readStoredRefreshToken', () => {
    it('reads the { tokens, scopes } shape', () => {
        expect(readStoredRefreshToken(credentialsFile({ tokens: { refresh_token: 'new' }, scopes: ['gmail.modify'] }))).toBe('new');
    });

    it('reads the legacy flat shape', () => {
        expect(readStoredRefreshToken(credentialsFile({ refresh_token: 'new' }))).toBe('new');
    });

    it('returns undefined when the file is missing, malformed, or has no refresh token', () => {
        expect(readStoredRefreshToken(missingFile())).toBeUndefined();
        expect(readStoredRefreshToken(credentialsFile('{not json'))).toBeUndefined();
        expect(readStoredRefreshToken(credentialsFile('null'))).toBeUndefined();
        expect(readStoredRefreshToken(credentialsFile({ tokens: { access_token: 'a' } }))).toBeUndefined();
    });
});

describe('ReloadingOAuth2Client', () => {
    it('does not read the file while the current refresh token works', async () => {
        const file = credentialsFile({ tokens: { refresh_token: 'new' } });
        const { client, exchanged } = makeClient(file, ['old', 'new']);
        const read = vi.spyOn(fs, 'readFileSync');
        expect((await client.getAccessToken()).token).toBe('access-for-old');
        expect(read).not.toHaveBeenCalledWith(file, 'utf8');
        expect(exchanged).toEqual(['old']);
    });

    it('switches to the re-authed refresh token from the file', async () => {
        const file = credentialsFile({ tokens: { refresh_token: 'new' } });
        const { client, exchanged } = makeClient(file, ['new']);
        const read = vi.spyOn(fs, 'readFileSync');
        expect((await client.getAccessToken()).token).toBe('access-for-new');
        expect(read).toHaveBeenCalledWith(file, 'utf8');
        expect(client.credentials.refresh_token).toBe('new');
        expect(exchanged).toEqual(['old', 'new']);
    });

    it('keeps the new refresh token on the request path the Gmail API uses', async () => {
        const { client, exchanged } = makeClient(credentialsFile({ tokens: { refresh_token: 'new' } }), ['new']);
        const headers = await client.getRequestHeaders();
        expect(headers.Authorization).toBe('Bearer access-for-new');
        expect(client.credentials.refresh_token).toBe('new');
        expect(exchanged).toEqual(['old', 'new']);
    });

    it('recovers concurrent calls with a single exchange per token', async () => {
        const { client, exchanged } = makeClient(credentialsFile({ tokens: { refresh_token: 'new' } }), ['new']);
        const results = await Promise.all([client.getAccessToken(), client.getAccessToken()]);
        expect(results.map((r) => r.token)).toEqual(['access-for-new', 'access-for-new']);
        expect(exchanged).toEqual(['old', 'new']);
    });

    it('emits the refreshed tokens so the server persists them', async () => {
        const { client } = makeClient(credentialsFile({ tokens: { refresh_token: 'new' } }), ['new']);
        const emitted: unknown[] = [];
        client.on('tokens', (tokens) => emitted.push(tokens.access_token));
        await client.getAccessToken();
        expect(emitted).toEqual(['access-for-new']);
    });

    it('rethrows invalid_grant when no re-auth happened', async () => {
        const { client, exchanged } = makeClient(credentialsFile({ tokens: { refresh_token: 'old' } }), []);
        await expect(client.getAccessToken()).rejects.toThrow('invalid_grant');
        expect(exchanged).toEqual(['old']);
    });

    it('rethrows other failures without reading the file', async () => {
        const file = credentialsFile({ tokens: { refresh_token: 'new' } });
        const { client, exchanged } = makeClient(file, [], () => new Error('socket hang up'));
        const read = vi.spyOn(fs, 'readFileSync');
        await expect(client.getAccessToken()).rejects.toThrow('socket hang up');
        expect(read).not.toHaveBeenCalledWith(file, 'utf8');
        expect(client.credentials.refresh_token).toBe('old');
        expect(exchanged).toEqual(['old']);
    });

    it('retries only once when the re-authed token is rejected too', async () => {
        const { client, exchanged } = makeClient(credentialsFile({ tokens: { refresh_token: 'new' } }), []);
        await expect(client.getAccessToken()).rejects.toThrow('invalid_grant');
        expect(client.credentials.refresh_token).toBe('old');
        expect(exchanged).toEqual(['old', 'new']);
    });
});
