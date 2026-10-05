/**
 * `doctor` subcommand: diagnose the stored Gmail OAuth tokens without starting
 * the MCP server.
 *
 * The failure users hit in practice is Google rejecting the refresh token
 * (`invalid_grant` — expired after the unverified-app seven-day cap, revoked,
 * or rotated away by a password change). The MCP server then fails every tool
 * call with the same one-line error. The doctor answers, before any consent
 * flow: does the file exist, is a refresh token present, does Google still
 * accept it, and when does the current access grant expire. Exit code 0 means
 * healthy, 1 means the account needs a browser re-consent — scriptable for
 * cron checks.
 */
import fs from 'fs';

export type DoctorVerdict = 'healthy' | 'unusable';

export interface DoctorReport {
    credentialsPath: string;
    keysPath: string;
    keysPresent: boolean;
    filePresent: boolean;
    hasRefreshToken: boolean;
    scopes: string[];
    verdict: DoctorVerdict;
    /** Google's error when the refresh grant is rejected, e.g. `invalid_grant`. */
    error?: string;
    errorDescription?: string;
    /** Lifetime of the freshly exchanged access grant, in seconds, when healthy. */
    expiresInSeconds?: number;
}

interface StoredCredentials {
    tokens?: {
        access_token?: string;
        refresh_token?: string;
        expiry_date?: number;
        scope?: string;
    };
    scopes?: string[];
}

interface OAuthKeys {
    installed?: { client_id?: string; client_secret?: string };
    web?: { client_id?: string; client_secret?: string };
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Read and shape the on-disk credentials file; null when unreadable or empty. */
export function parseCredentialsFile(text: string): StoredCredentials | null {
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null) return null;
        return parsed as StoredCredentials;
    } catch {
        return null;
    }
}

/**
 * Map a refresh-grant exchange response onto a verdict. Exported pure so the
 * classification is testable without network access.
 */
export function classifyRefreshResponse(status: number, bodyText: string): Pick<DoctorReport, 'verdict' | 'error' | 'errorDescription' | 'expiresInSeconds'> {
    if (status === 200) {
        try {
            const body = JSON.parse(bodyText) as { expires_in?: number };
            return { verdict: 'healthy', expiresInSeconds: body.expires_in };
        } catch {
            return { verdict: 'unusable', error: 'unexpected_response', errorDescription: 'Token endpoint returned 200 with a non-JSON body' };
        }
    }
    try {
        const body = JSON.parse(bodyText) as { error?: string; error_description?: string };
        return { verdict: 'unusable', error: body.error ?? `http_${status}`, errorDescription: body.error_description };
    } catch {
        return { verdict: 'unusable', error: `http_${status}`, errorDescription: bodyText.slice(0, 200) };
    }
}

export interface DoctorEnv {
    credentialsPath: string;
    keysPath: string;
    fetchImpl: typeof fetch;
}

/** Read a JSON file, returning null for unreadable or invalid content. */
function readJson<T>(file: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

/**
 * Run every check that does not need a browser: file presence, refresh token
 * presence, and a live refresh-grant exchange against Google.
 */
export async function runDoctorChecks(env: DoctorEnv): Promise<DoctorReport> {
    const report: DoctorReport = {
        credentialsPath: env.credentialsPath,
        keysPath: env.keysPath,
        keysPresent: fs.existsSync(env.keysPath),
        filePresent: fs.existsSync(env.credentialsPath),
        hasRefreshToken: false,
        scopes: [],
        verdict: 'unusable',
    };

    if (!report.filePresent) {
        report.error = 'missing_credentials_file';
        report.errorDescription = 'No credentials file — run `auth` once to create it.';
        return report;
    }

    const credentials = readJson<StoredCredentials>(env.credentialsPath);
    const tokens = credentials?.tokens;
    if (!tokens?.refresh_token) {
        report.error = 'missing_refresh_token';
        report.errorDescription = 'The file has no refresh token — run `auth` to obtain one.';
        return report;
    }
    report.hasRefreshToken = true;
    if (credentials?.scopes) report.scopes = credentials.scopes;
    else if (tokens.scope) report.scopes = tokens.scope.split(' ');

    const keys = report.keysPresent ? readJson<OAuthKeys>(env.keysPath) : null;
    const client = keys?.installed ?? keys?.web;
    if (!client?.client_id || !client?.client_secret) {
        report.error = 'missing_oauth_keys';
        report.errorDescription = `Cannot exchange the refresh grant without client credentials at ${env.keysPath}.`;
        return report;
    }

    const response = await env.fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: client.client_id,
            client_secret: client.client_secret,
            refresh_token: tokens.refresh_token,
            grant_type: 'refresh_token',
        }),
    });
    const classification = classifyRefreshResponse(response.status, await response.text());
    return { ...report, ...classification };
}

/**
 * CLI entry: run the checks, print a human-readable report, return the process
 * exit code (0 healthy, 1 anything else).
 */
export async function runDoctorCli(env: NodeJS.ProcessEnv): Promise<number> {
    const configDir = env.GMAIL_CONFIG_DIR ?? `${process.env.HOME ?? '~'}/.gmail-mcp`;
    const credentialsPath = env.GMAIL_CREDENTIALS_PATH ?? `${configDir}/credentials.json`;
    const keysPath = env.GMAIL_OAUTH_PATH ?? `${configDir}/gcp-oauth.keys.json`;

    const report = await runDoctorChecks({ credentialsPath, keysPath, fetchImpl: fetch });

    console.log(`Credentials: ${report.credentialsPath}${report.filePresent ? '' : ' (missing)'}`);
    console.log(`OAuth keys:  ${report.keysPath}${report.keysPresent ? '' : ' (missing)'}`);
    console.log(`Scopes:      ${report.scopes.join(', ') || '(none recorded)'}`);
    if (report.verdict === 'healthy') {
        console.log(`Verdict:     healthy — Google accepted the refresh token (fresh access grant lives ${report.expiresInSeconds ?? '?'}s)`);
        return 0;
    }
    console.log(`Verdict:     needs re-auth (${report.error}) — ${report.errorDescription ?? ''}`.trimEnd());
    console.log('Fix: run `gmail-mcp auth --scopes=<your scopes>` with this account\'s');
    console.log('GMAIL_OAUTH_PATH / GMAIL_CREDENTIALS_PATH env vars, then restart the MCP clients.');
    return 1;
}
