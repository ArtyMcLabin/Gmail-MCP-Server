import { describe, it, expect } from 'vitest';
import {
    addFwdPrefix,
    normalizeContentId,
    collectForwardAttachments,
    assertForwardAttachmentsWithinLimit,
    buildForwardedTextBody,
    buildForwardedHtmlBody,
    MAX_FORWARD_ATTACHMENT_TOTAL_BYTES,
} from './forward-helpers.js';

describe('addFwdPrefix', () => {
    it('adds the prefix to a bare subject', () => {
        expect(addFwdPrefix('Invoice 2026-03')).toBe('Fwd: Invoice 2026-03');
    });

    it('does not stack an existing Fwd: prefix', () => {
        expect(addFwdPrefix('Fwd: Invoice 2026-03')).toBe('Fwd: Invoice 2026-03');
    });

    it('recognises the existing prefix case-insensitively', () => {
        expect(addFwdPrefix('FWD: Invoice')).toBe('FWD: Invoice');
        expect(addFwdPrefix('fwd: Invoice')).toBe('fwd: Invoice');
    });

    it('recognises the short Fw: variant', () => {
        expect(addFwdPrefix('Fw: Invoice')).toBe('Fw: Invoice');
    });

    it('still prefixes a reply subject, since Re: is not a forward marker', () => {
        expect(addFwdPrefix('Re: Invoice')).toBe('Fwd: Re: Invoice');
    });

    it('trims surrounding whitespace', () => {
        expect(addFwdPrefix('  Invoice  ')).toBe('Fwd: Invoice');
    });

    it('handles an empty subject', () => {
        expect(addFwdPrefix('')).toBe('Fwd: ');
    });
});

describe('normalizeContentId', () => {
    it('strips angle brackets as returned by Gmail', () => {
        expect(normalizeContentId('<abc123@mail.gmail.com>')).toBe('abc123@mail.gmail.com');
    });

    it('leaves a bare cid untouched', () => {
        expect(normalizeContentId('abc123')).toBe('abc123');
    });
});

describe('collectForwardAttachments', () => {
    it('returns nothing for a plain-text message with no parts', () => {
        const payload = { mimeType: 'text/plain', body: { size: 42 } };
        expect(collectForwardAttachments(payload)).toEqual([]);
    });

    it('ignores body parts and picks up only parts with an attachmentId', () => {
        const payload = {
            mimeType: 'multipart/mixed',
            parts: [
                { mimeType: 'text/plain', body: { size: 10 } },
                { mimeType: 'text/html', body: { size: 20 } },
                {
                    mimeType: 'application/pdf',
                    filename: 'invoice.pdf',
                    body: { attachmentId: 'att-1', size: 1000 },
                },
            ],
        };

        const result = collectForwardAttachments(payload);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            attachmentId: 'att-1',
            filename: 'invoice.pdf',
            mimeType: 'application/pdf',
            size: 1000,
        });
        expect(result[0].cid).toBeUndefined();
    });

    it('descends into nested multipart trees', () => {
        const payload = {
            mimeType: 'multipart/mixed',
            parts: [
                {
                    mimeType: 'multipart/related',
                    parts: [
                        {
                            mimeType: 'multipart/alternative',
                            parts: [{ mimeType: 'text/plain', body: { size: 5 } }],
                        },
                        {
                            mimeType: 'image/png',
                            filename: 'logo.png',
                            headers: [{ name: 'Content-ID', value: '<logo@example>' }],
                            body: { attachmentId: 'att-inline', size: 300 },
                        },
                    ],
                },
                {
                    mimeType: 'application/zip',
                    filename: 'bundle.zip',
                    body: { attachmentId: 'att-deep', size: 700 },
                },
            ],
        };

        const result = collectForwardAttachments(payload);
        expect(result.map(a => a.attachmentId)).toEqual(['att-inline', 'att-deep']);
    });

    it('captures the Content-ID of an inline image so cid: references keep resolving', () => {
        const payload = {
            parts: [
                {
                    mimeType: 'image/png',
                    filename: 'logo.png',
                    headers: [{ name: 'Content-ID', value: '<logo@example>' }],
                    body: { attachmentId: 'att-1', size: 300 },
                },
            ],
        };

        expect(collectForwardAttachments(payload)[0].cid).toBe('logo@example');
    });

    it('matches the Content-ID header case-insensitively', () => {
        const payload = {
            parts: [
                {
                    mimeType: 'image/png',
                    headers: [{ name: 'content-id', value: '<x@y>' }],
                    body: { attachmentId: 'att-1', size: 1 },
                },
            ],
        };

        expect(collectForwardAttachments(payload)[0].cid).toBe('x@y');
    });

    it('falls back to the cid as filename when an inline part has none', () => {
        const payload = {
            parts: [
                {
                    mimeType: 'image/png',
                    headers: [{ name: 'Content-ID', value: '<logo@example>' }],
                    body: { attachmentId: 'att-1', size: 300 },
                },
            ],
        };

        expect(collectForwardAttachments(payload)[0].filename).toBe('logo@example');
    });

    it('falls back to a generic filename when there is neither filename nor cid', () => {
        const payload = {
            parts: [{ mimeType: 'application/octet-stream', body: { attachmentId: 'att-1', size: 1 } }],
        };

        expect(collectForwardAttachments(payload)[0].filename).toBe('attachment');
    });

    it('defaults a missing mimeType to application/octet-stream', () => {
        const payload = {
            parts: [{ filename: 'x.bin', body: { attachmentId: 'att-1', size: 1 } }],
        };

        expect(collectForwardAttachments(payload)[0].mimeType).toBe('application/octet-stream');
    });

    it('tolerates a null or undefined payload', () => {
        expect(collectForwardAttachments(null)).toEqual([]);
        expect(collectForwardAttachments(undefined)).toEqual([]);
    });
});

describe('assertForwardAttachmentsWithinLimit', () => {
    const ref = (size: number) => ({
        attachmentId: 'a',
        filename: 'f',
        mimeType: 'application/pdf',
        size,
    });

    it('accepts an empty list', () => {
        expect(() => assertForwardAttachmentsWithinLimit([])).not.toThrow();
    });

    it('accepts a total under the limit', () => {
        expect(() => assertForwardAttachmentsWithinLimit([ref(1000), ref(2000)], 5000)).not.toThrow();
    });

    it('accepts a total exactly at the limit', () => {
        expect(() => assertForwardAttachmentsWithinLimit([ref(5000)], 5000)).not.toThrow();
    });

    it('rejects a total over the limit and names the escape hatch', () => {
        expect(() => assertForwardAttachmentsWithinLimit([ref(4000), ref(2000)], 5000))
            .toThrow(/includeAttachments: false/);
    });

    it('sums across parts rather than checking each individually', () => {
        expect(() => assertForwardAttachmentsWithinLimit([ref(3000), ref(3000)], 5000)).toThrow();
    });

    it('defaults to the 25 MB cap', () => {
        expect(MAX_FORWARD_ATTACHMENT_TOTAL_BYTES).toBe(25 * 1024 * 1024);
        expect(() => assertForwardAttachmentsWithinLimit([ref(MAX_FORWARD_ATTACHMENT_TOTAL_BYTES + 1)]))
            .toThrow();
    });
});

describe('buildForwardedTextBody', () => {
    const fields = {
        from: 'Alice <alice@example.com>',
        date: 'Mon, 3 Aug 2026 10:00:00 +0200',
        subject: 'Invoice 2026-03',
        to: 'bob@example.com',
    };

    it('emits the standard separator and header block above the original body', () => {
        const result = buildForwardedTextBody(fields, 'Original body text');

        expect(result).toContain('---------- Forwarded message ----------');
        expect(result).toContain('From: Alice <alice@example.com>');
        expect(result).toContain('Date: Mon, 3 Aug 2026 10:00:00 +0200');
        expect(result).toContain('Subject: Invoice 2026-03');
        expect(result).toContain('To: bob@example.com');
        expect(result).toContain('Original body text');
    });

    it('omits the Cc line when there is no Cc', () => {
        expect(buildForwardedTextBody(fields, 'body')).not.toContain('Cc:');
    });

    it('includes the Cc line when present', () => {
        expect(buildForwardedTextBody({ ...fields, cc: 'carol@example.com' }, 'body'))
            .toContain('Cc: carol@example.com');
    });

    it('places the sender note above the separator', () => {
        const result = buildForwardedTextBody(fields, 'body', 'FYI, see below');
        expect(result.indexOf('FYI, see below')).toBeLessThan(result.indexOf('---------- Forwarded'));
    });

    it('starts at the separator when no note is given', () => {
        expect(buildForwardedTextBody(fields, 'body').startsWith('---------- Forwarded message ----------'))
            .toBe(true);
    });
});

describe('buildForwardedHtmlBody', () => {
    const fields = {
        from: 'Alice <alice@example.com>',
        date: 'Mon, 3 Aug 2026 10:00:00 +0200',
        subject: 'Invoice',
        to: 'bob@example.com',
    };

    it('embeds the original HTML verbatim rather than escaping it', () => {
        const result = buildForwardedHtmlBody(fields, '<p>Hello <b>world</b></p>');
        expect(result).toContain('<p>Hello <b>world</b></p>');
    });

    it('escapes header values so they cannot break out of the quote block', () => {
        const result = buildForwardedHtmlBody(
            { ...fields, from: '<script>alert(1)</script>' },
            '<p>body</p>'
        );
        expect(result).toContain('&lt;script&gt;');
        expect(result).not.toContain('<script>alert(1)</script>');
    });

    it('escapes the angle brackets around a normal display address', () => {
        const result = buildForwardedHtmlBody(fields, '<p>body</p>');
        expect(result).toContain('Alice &lt;alice@example.com&gt;');
    });

    it('omits the Cc row when there is no Cc', () => {
        expect(buildForwardedHtmlBody(fields, '<p>b</p>')).not.toContain('Cc:');
    });

    it('includes the Cc row when present', () => {
        expect(buildForwardedHtmlBody({ ...fields, cc: 'carol@example.com' }, '<p>b</p>'))
            .toContain('Cc: carol@example.com');
    });

    it('places the sender note above the separator', () => {
        const result = buildForwardedHtmlBody(fields, '<p>b</p>', '<i>FYI</i>');
        expect(result.indexOf('<i>FYI</i>')).toBeLessThan(result.indexOf('---------- Forwarded'));
    });
});
