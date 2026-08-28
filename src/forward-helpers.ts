/**
 * Helper functions for forward_email functionality.
 * Extracted for testability.
 */

/**
 * Total decoded size allowed across all re-attached parts of a forwarded
 * message. Gmail rejects sends above ~25 MB anyway; failing here produces a
 * clear error instead of an opaque API rejection, and bounds how much
 * attachment data the host process buffers in memory at once.
 */
export const MAX_FORWARD_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * A single attachment part discovered on the message being forwarded.
 */
export interface ForwardAttachmentRef {
    attachmentId: string;
    filename: string;
    mimeType: string;
    size: number;
    /** Content-ID without angle brackets, when the part is referenced inline from the HTML body. */
    cid?: string;
}

/**
 * Minimal shape of a Gmail MIME part, mirroring the subset used here.
 */
interface MessagePartLike {
    mimeType?: string | null;
    filename?: string | null;
    headers?: Array<{ name?: string | null; value?: string | null }> | null;
    body?: { attachmentId?: string | null; size?: number | null } | null;
    parts?: MessagePartLike[] | null;
}

/**
 * Adds "Fwd: " prefix to a subject if not already present.
 * Recognises the common existing prefixes so chained forwards don't stack
 * ("Fwd: Fwd: Fwd: ..."). Case-insensitive.
 *
 * @param subject - The original email subject
 * @returns Subject with "Fwd: " prefix
 */
export function addFwdPrefix(subject: string): string {
    const trimmed = subject.trim();
    if (/^(fwd|fw):/i.test(trimmed)) {
        return trimmed;
    }
    return `Fwd: ${trimmed}`;
}

/**
 * Strips angle brackets from a Content-ID header value.
 * Gmail returns "<abc123>"; nodemailer expects "abc123".
 */
export function normalizeContentId(raw: string): string {
    return raw.trim().replace(/^</, '').replace(/>$/, '');
}

/**
 * Walks a Gmail MIME tree and collects every part that should be carried over
 * to the forwarded message.
 *
 * A part qualifies when it has an attachmentId. That covers both regular file
 * attachments and inline images (which additionally carry a Content-ID and are
 * re-attached with their cid intact so `<img src="cid:...">` in the forwarded
 * HTML body keeps resolving).
 *
 * @param payload - The message payload from messages.get(format: 'full')
 * @returns Attachment references in document order
 */
export function collectForwardAttachments(payload: MessagePartLike | null | undefined): ForwardAttachmentRef[] {
    const found: ForwardAttachmentRef[] = [];

    const walk = (part: MessagePartLike | null | undefined): void => {
        if (!part) return;

        const attachmentId = part.body?.attachmentId;
        if (attachmentId) {
            const contentIdHeader = (part.headers || []).find(
                h => h.name?.toLowerCase() === 'content-id'
            )?.value;
            const cid = contentIdHeader ? normalizeContentId(contentIdHeader) : undefined;

            found.push({
                attachmentId,
                // Inline images frequently have no filename; fall back to the cid
                // so the part still gets a sane name in the forwarded message.
                filename: part.filename || cid || 'attachment',
                mimeType: part.mimeType || 'application/octet-stream',
                size: part.body?.size || 0,
                ...(cid ? { cid } : {}),
            });
        }

        for (const child of part.parts || []) {
            walk(child);
        }
    };

    walk(payload);
    return found;
}

/**
 * Throws when the combined size of the parts to re-attach exceeds the cap.
 *
 * @param attachments - Parts discovered on the original message
 * @param limit - Byte ceiling (overridable for tests)
 */
export function assertForwardAttachmentsWithinLimit(
    attachments: ForwardAttachmentRef[],
    limit: number = MAX_FORWARD_ATTACHMENT_TOTAL_BYTES
): void {
    const total = attachments.reduce((sum, a) => sum + (a.size || 0), 0);
    if (total > limit) {
        throw new Error(
            `Forwarded attachments total ${(total / (1024 * 1024)).toFixed(1)} MB, ` +
            `exceeding the ${limit / (1024 * 1024)} MB limit. ` +
            `Use includeAttachments: false to forward without them.`
        );
    }
}

/**
 * Header fields of the message being forwarded, as rendered in the quote block.
 */
export interface ForwardedHeaderFields {
    from: string;
    date: string;
    subject: string;
    to: string;
    cc?: string;
}

/**
 * Builds the plain-text "---------- Forwarded message ----------" block that
 * Gmail's own web client prepends, followed by the original text body.
 *
 * @param fields - Header values from the original message
 * @param originalBody - Plain-text body of the original message
 * @param prefaceBody - Optional note typed by the sender, placed above the quote
 */
export function buildForwardedTextBody(
    fields: ForwardedHeaderFields,
    originalBody: string,
    prefaceBody?: string
): string {
    const lines: string[] = [];

    if (prefaceBody) {
        lines.push(prefaceBody, '');
    }

    lines.push('---------- Forwarded message ----------');
    lines.push(`From: ${fields.from}`);
    lines.push(`Date: ${fields.date}`);
    lines.push(`Subject: ${fields.subject}`);
    lines.push(`To: ${fields.to}`);
    if (fields.cc) {
        lines.push(`Cc: ${fields.cc}`);
    }
    lines.push('');
    lines.push(originalBody);

    return lines.join('\n');
}

/**
 * Escapes the five XML-significant characters so header values from the
 * original message can't break out of the quote block markup.
 */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Builds the HTML equivalent of the forwarded-message quote block.
 *
 * The original HTML body is embedded verbatim: it is already-rendered mail the
 * user received in their own client, and re-escaping it would show raw markup
 * to the recipient.
 *
 * @param fields - Header values from the original message
 * @param originalHtmlBody - HTML body of the original message
 * @param prefaceHtmlBody - Optional note typed by the sender, placed above the quote
 */
export function buildForwardedHtmlBody(
    fields: ForwardedHeaderFields,
    originalHtmlBody: string,
    prefaceHtmlBody?: string
): string {
    const rows: string[] = [
        `<div>From: ${escapeHtml(fields.from)}</div>`,
        `<div>Date: ${escapeHtml(fields.date)}</div>`,
        `<div>Subject: ${escapeHtml(fields.subject)}</div>`,
        `<div>To: ${escapeHtml(fields.to)}</div>`,
    ];
    if (fields.cc) {
        rows.push(`<div>Cc: ${escapeHtml(fields.cc)}</div>`);
    }

    return [
        prefaceHtmlBody ? `<div>${prefaceHtmlBody}</div><br>` : '',
        '<div>---------- Forwarded message ----------</div>',
        ...rows,
        '<br>',
        originalHtmlBody,
    ].filter(Boolean).join('\n');
}
