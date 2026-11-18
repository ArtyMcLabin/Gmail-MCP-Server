/**
 * Pick up a re-auth that happened while this server was running.
 *
 * `auth` writes a fresh refresh token to the credentials file, but a server
 * started before that keeps the old token in memory. Once Google rejects the
 * old token (`invalid_grant`: the seven-day cap for unverified apps, or a
 * revocation), every tool call fails until the MCP client respawns the server.
 *
 * This client hooks the one place where Google answers `invalid_grant`: the
 * refresh-token exchange. When the credentials file holds a different refresh
 * token, it retries the exchange once with that token and keeps it. The
 * exchange happens before the Gmail request is sent, so nothing is sent twice,
 * and google-auth-library already shares one exchange between concurrent calls.
 */
import fs from 'fs';
import { OAuth2Client } from 'google-auth-library';
import { parseCredentialsFile } from './auth-doctor.js';

/** True when Google rejected the refresh grant (expired or revoked token). */
export function isInvalidGrant(error: unknown): boolean {
    const response = (error as { response?: { data?: { error?: unknown } } } | null)?.response;
    return response?.data?.error === 'invalid_grant';
}

/** The refresh token stored in the credentials file, or undefined when there is none. */
export function readStoredRefreshToken(credentialsPath: string): string | undefined {
    let text: string;
    try {
        text = fs.readFileSync(credentialsPath, 'utf8');
    } catch {
        return undefined;
    }
    const stored = parseCredentialsFile(text);
    // Same two shapes loadCredentials() reads: { tokens, scopes } or the legacy flat token object.
    const token = (stored?.tokens || stored)?.refresh_token;
    return typeof token === 'string' && token !== '' ? token : undefined;
}

export class ReloadingOAuth2Client extends OAuth2Client {
    private readonly credentialsPath: string;

    constructor(clientId: string, clientSecret: string, redirectUri: string, credentialsPath: string) {
        super(clientId, clientSecret, redirectUri);
        this.credentialsPath = credentialsPath;
    }

    protected override async refreshTokenNoCache(refreshToken?: string | null) {
        try {
            return await super.refreshTokenNoCache(refreshToken);
        } catch (error) {
            const reauthed = isInvalidGrant(error) ? readStoredRefreshToken(this.credentialsPath) : undefined;
            if (!reauthed || reauthed === refreshToken) throw error;
            console.error(`Refresh token rejected (invalid_grant); retrying with the newer one in ${this.credentialsPath}`);
            const result = await super.refreshTokenNoCache(reauthed);
            // Both callers copy this.credentials.refresh_token into the refreshed credentials.
            this.credentials = { ...this.credentials, refresh_token: reauthed };
            return result;
        }
    }
}
