import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyRefreshResponse, parseCredentialsFile, runDoctorChecks } from './auth-doctor.js';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-doctor-'));
    tempDirs.push(dir);
    return dir;
}

function writeJson(file: string, value: unknown): void {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const OK_KEYS = {
    installed: { client_id: 'cid', client_secret: 'secret' },
};

function stubFetch(status: number, body: unknown): typeof fetch {
    return (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch;
}

describe('parseCredentialsFile', () => {
    it('reads the v1.2 tokens envelope', () => {
        expect(parseCredentialsFile(JSON.stringify({ tokens: { refresh_token: 'r' }, scopes: ['gmail.readonly'] }))).toEqual({
            tokens: { refresh_token: 'r' },
            scopes: ['gmail.readonly'],
        });
    });

    it('reads the legacy flat shape as-is', () => {
        expect(parseCredentialsFile(JSON.stringify({ refresh_token: 'r' }))).toEqual({ refresh_token: 'r' });
    });

    it('returns null for non-JSON text', () => {
        expect(parseCredentialsFile('not json')).toBeNull();
    });
});

describe('classifyRefreshResponse', () => {
    it('classifies a 200 exchange as healthy with the grant lifetime', () => {
        expect(classifyRefreshResponse(200, JSON.stringify({ access_token: 'a', expires_in: 3599 }))).toEqual({
            verdict: 'healthy',
            expiresInSeconds: 3599,
        });
    });

    it('classifies a 200 with a non-JSON body as unusable', () => {
        const result = classifyRefreshResponse(200, 'gateway garbage');
        expect(result.verdict).toBe('unusable');
        expect(result.error).toBe('unexpected_response');
    });

    it('carries Google error and description for a rejected refresh token', () => {
        const result = classifyRefreshResponse(400, JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
        expect(result.verdict).toBe('unusable');
        expect(result.error).toBe('invalid_grant');
        expect(result.errorDescription).toBe('Token has been expired or revoked.');
    });

    it('falls back to the HTTP status for non-JSON failures', () => {
        const result = classifyRefreshResponse(503, '<html>down</html>');
        expect(result.verdict).toBe('unusable');
        expect(result.error).toBe('http_503');
    });
});

describe('runDoctorChecks', () => {
    it('reports a missing credentials file without touching the network', async () => {
        const dir = makeTempDir();
        const report = await runDoctorChecks({
            credentialsPath: path.join(dir, 'credentials.json'),
            keysPath: path.join(dir, 'keys.json'),
            fetchImpl: stubFetch(200, {}),
        });
        expect(report.filePresent).toBe(false);
        expect(report.verdict).toBe('unusable');
        expect(report.error).toBe('missing_credentials_file');
    });

    it('reports a credentials file without a refresh token', async () => {
        const dir = makeTempDir();
        const credentialsPath = path.join(dir, 'credentials.json');
        writeJson(credentialsPath, { tokens: { access_token: 'a' } });
        const report = await runDoctorChecks({
            credentialsPath,
            keysPath: path.join(dir, 'keys.json'),
            fetchImpl: stubFetch(200, {}),
        });
        expect(report.hasRefreshToken).toBe(false);
        expect(report.error).toBe('missing_refresh_token');
    });

    it('reports missing OAuth keys before attempting the exchange', async () => {
        const dir = makeTempDir();
        const credentialsPath = path.join(dir, 'credentials.json');
        writeJson(credentialsPath, { tokens: { refresh_token: 'r' }, scopes: ['gmail.readonly'] });
        const report = await runDoctorChecks({
            credentialsPath,
            keysPath: path.join(dir, 'keys.json'),
            fetchImpl: stubFetch(200, {}),
        });
        expect(report.error).toBe('missing_oauth_keys');
    });

    it('exchanges a live refresh token and reports healthy', async () => {
        const dir = makeTempDir();
        const credentialsPath = path.join(dir, 'credentials.json');
        writeJson(credentialsPath, { tokens: { refresh_token: 'r', scope: 'gmail.readonly gmail.compose' }, scopes: ['gmail.readonly', 'gmail.compose'] });
        writeJson(path.join(dir, 'keys.json'), OK_KEYS);
        const report = await runDoctorChecks({
            credentialsPath,
            keysPath: path.join(dir, 'keys.json'),
            fetchImpl: stubFetch(200, { access_token: 'a', expires_in: 3599 }),
        });
        expect(report.verdict).toBe('healthy');
        expect(report.expiresInSeconds).toBe(3599);
        expect(report.scopes).toEqual(['gmail.readonly', 'gmail.compose']);
    });

    it('reports unusable when Google rejects the refresh token', async () => {
        const dir = makeTempDir();
        const credentialsPath = path.join(dir, 'credentials.json');
        writeJson(credentialsPath, { tokens: { refresh_token: 'dead' } });
        writeJson(path.join(dir, 'keys.json'), OK_KEYS);
        const report = await runDoctorChecks({
            credentialsPath,
            keysPath: path.join(dir, 'keys.json'),
            fetchImpl: stubFetch(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
        });
        expect(report.verdict).toBe('unusable');
        expect(report.error).toBe('invalid_grant');
        expect(report.hasRefreshToken).toBe(true);
    });

    it('reads web-shaped OAuth keys', async () => {
        const dir = makeTempDir();
        const credentialsPath = path.join(dir, 'credentials.json');
        writeJson(credentialsPath, { tokens: { refresh_token: 'r' } });
        writeJson(path.join(dir, 'keys.json'), { web: { client_id: 'cid', client_secret: 'secret' } });
        const report = await runDoctorChecks({
            credentialsPath,
            keysPath: path.join(dir, 'keys.json'),
            fetchImpl: stubFetch(200, { access_token: 'a', expires_in: 100 }),
        });
        expect(report.verdict).toBe('healthy');
    });
});
