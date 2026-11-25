export const EMAIL_MIME_TYPES = ['text/plain', 'text/html', 'multipart/alternative'] as const;
export type EmailMimeType = typeof EMAIL_MIME_TYPES[number];

export interface EmailBodyInput {
    body?: string;
    htmlBody?: string;
    mimeType?: EmailMimeType;
}

export interface EmailBodyContent {
    mimeType: EmailMimeType;
    text?: string;
    html?: string;
}

export function resolveDefaultEmailFormat(env: NodeJS.ProcessEnv = process.env): EmailMimeType {
    const value = env.GMAIL_DEFAULT_MIME_TYPE ?? 'text/plain';
    if (!EMAIL_MIME_TYPES.includes(value as EmailMimeType)) {
        throw new Error(`GMAIL_DEFAULT_MIME_TYPE must be one of: ${EMAIL_MIME_TYPES.join(', ')}`);
    }
    return value as EmailMimeType;
}

function textToHtml(text: string): string {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
        .replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
    return `<div>${escaped}</div>`;
}

/** Resolve format once for both MIME builders, without changing the input. */
export function resolveEmailBody(
    args: EmailBodyInput,
    env: NodeJS.ProcessEnv = process.env,
): EmailBodyContent {
    const defaultType = args.mimeType ?? resolveDefaultEmailFormat(env);
    // Supplied HTML should work without requiring a redundant MIME argument.
    const mimeType = !args.mimeType && args.htmlBody != null && defaultType === 'text/plain'
        ? 'multipart/alternative' : defaultType;
    const text = args.body ?? '';
    if (mimeType === 'text/plain') return { mimeType, text };

    // Only an explicit text/html call treats body as markup. A configured HTML
    // default still accepts ordinary body text, including literal < and &.
    const html = args.htmlBody ?? (args.mimeType === 'text/html' ? text : textToHtml(text));
    return mimeType === 'text/html' ? { mimeType, html } : { mimeType, text, html };
}
