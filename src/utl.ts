import fs from 'fs';
import path from 'path';
import { lookup as mimeLookup } from 'mime-types';
import nodemailer from 'nodemailer';

/**
 * Upper bound on the decoded size of a base64 `content` inline image. Rejecting
 * oversized payloads before nodemailer buffers them prevents host-process memory
 * exhaustion. File-path images stream and are not subject to this check.
 */
export const MAX_INLINE_IMAGE_CONTENT_BYTES = 10 * 1024 * 1024;

/**
 * Helper function to encode email headers containing non-ASCII characters
 * according to RFC 2047 MIME specification
 */
function encodeEmailHeader(text: string): string {
    // Only encode if the text contains non-ASCII characters
    if (/[^\x00-\x7F]/.test(text)) {
        // Use MIME Words encoding (RFC 2047)
        return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?=';
    }
    return text;
}

export const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

/**
 * Sanitize a value destined for an email header to prevent CRLF injection.
 * Strips \r, \n, and \0 characters that could inject additional headers.
 */
function sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n\0]/g, '');
}

export function createEmailMessage(validatedArgs: any): string {
    const encodedSubject = encodeEmailHeader(sanitizeHeaderValue(validatedArgs.subject));
    // Determine content type based on available content and explicit mimeType
    let mimeType = validatedArgs.mimeType || 'text/plain';
    
    // If htmlBody is provided and mimeType isn't explicitly set to text/plain,
    // use multipart/alternative to include both versions
    if (validatedArgs.htmlBody && mimeType !== 'text/plain') {
        mimeType = 'multipart/alternative';
    }

    // Generate a random boundary string for multipart messages
    const boundary = `----=_NextPart_${Math.random().toString(36).substring(2)}`;

    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Sanitize all user-supplied header values to prevent CRLF injection
    const from = sanitizeHeaderValue(validatedArgs.from || 'me');
    const to = (validatedArgs.to as string[]).map(sanitizeHeaderValue).join(', ');
    const cc = validatedArgs.cc ? (validatedArgs.cc as string[]).map(sanitizeHeaderValue).join(', ') : '';
    const bcc = validatedArgs.bcc ? (validatedArgs.bcc as string[]).map(sanitizeHeaderValue).join(', ') : '';
    const inReplyTo = validatedArgs.inReplyTo ? sanitizeHeaderValue(validatedArgs.inReplyTo) : '';
    const references = validatedArgs.references
        ? sanitizeHeaderValue(validatedArgs.references)
        : validatedArgs.inReplyTo ? sanitizeHeaderValue(validatedArgs.inReplyTo) : '';

    // Common email headers
    const emailParts = [
        `From: ${from}`,
        `To: ${to}`,
        cc ? `Cc: ${cc}` : '',
        bcc ? `Bcc: ${bcc}` : '',
        `Subject: ${encodedSubject}`,
        inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
        references ? `References: ${references}` : '',
        'MIME-Version: 1.0',
    ].filter(Boolean);

    // Construct the email based on the content type
    if (mimeType === 'multipart/alternative') {
        // Multipart email with both plain text and HTML
        emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        emailParts.push('');
        
        // Plain text part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
        emailParts.push('');
        
        // HTML part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body); // Use body as fallback
        emailParts.push('');
        
        // Close the boundary
        emailParts.push(`--${boundary}--`);
    } else if (mimeType === 'text/html') {
        // HTML-only email
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body);
    } else {
        // Plain text email (default)
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
    }

    return emailParts.join('\r\n');
}


export async function createEmailWithNodemailer(validatedArgs: any): Promise<string> {
    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Create a nodemailer transporter (we won't actually send, just generate the message)
    const transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
    });

    // Inline images can only be referenced from an HTML body via cid: URLs.
    const inlineImages = validatedArgs.inlineImages || [];
    if (inlineImages.length > 0 && !validatedArgs.htmlBody) {
        throw new Error('inlineImages require htmlBody — a cid: reference only resolves from HTML content');
    }

    // Prepare attachments for nodemailer
    const attachments: any[] = [];
    for (const filePath of (validatedArgs.attachments || [])) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File does not exist: ${filePath}`);
        }

        const fileName = path.basename(filePath);

        attachments.push({
            filename: fileName,
            path: filePath
        });
    }

    // In-memory parts carried over from another message (forward_email). These
    // never touch the filesystem: the bytes come straight from the Gmail API.
    // A part keeping its `cid` stays inline so cid: references in the quoted
    // HTML body still resolve for the recipient.
    for (const part of (validatedArgs.rawAttachments || [])) {
        const entry: Record<string, unknown> = {
            filename: part.filename,
            content: part.content,
            encoding: 'base64',
        };
        if (part.contentType) {
            entry.contentType = part.contentType;
        }
        if (part.cid) {
            entry.cid = sanitizeHeaderValue(String(part.cid));
        }
        attachments.push(entry);
    }

    // Inline images: nodemailer emits a multipart/related container and sets
    // Content-ID + Content-Disposition: inline for any attachment carrying a `cid`.
    for (const img of inlineImages) {
        // `cid` lands in a Content-ID header — strip CR/LF/NUL as defense in depth
        // on top of the schema-level character restriction.
        const cid = sanitizeHeaderValue(String(img.cid || ''));
        if (!cid) {
            throw new Error('Inline image cid must be a non-empty string');
        }

        const part: Record<string, unknown> = { cid };

        if (img.path) {
            if (!fs.existsSync(img.path)) {
                throw new Error(`Inline image file does not exist: ${img.path}`);
            }
            part.path = img.path;
            part.filename = img.filename || path.basename(img.path);
        } else {
            // Reject oversized base64 payloads before nodemailer buffers them in
            // memory. Estimate decoded size from the base64 length (~3/4 ratio).
            const estimatedBytes = Math.floor((String(img.content || '').length * 3) / 4);
            if (estimatedBytes > MAX_INLINE_IMAGE_CONTENT_BYTES) {
                throw new Error(
                    `Inline image '${cid}' exceeds the ${MAX_INLINE_IMAGE_CONTENT_BYTES / (1024 * 1024)} MB size limit`,
                );
            }
            part.content = img.content;
            part.encoding = 'base64';
            part.filename = img.filename || cid;
        }

        if (img.contentType) {
            part.contentType = img.contentType;
        }

        attachments.push(part);
    }

    const mailOptions = {
        from: validatedArgs.from || 'me', // Gmail API uses default send-as if 'me', or specified alias
        to: validatedArgs.to.join(', '),
        cc: validatedArgs.cc?.join(', '),
        bcc: validatedArgs.bcc?.join(', '),
        subject: validatedArgs.subject,
        text: validatedArgs.body,
        html: validatedArgs.htmlBody,
        attachments: attachments,
        inReplyTo: validatedArgs.inReplyTo,
        references: validatedArgs.references || validatedArgs.inReplyTo
    };

    // Generate the raw message
    const info = await transporter.sendMail(mailOptions);
    const rawMessage = info.message.toString();

    return rawMessage;
}

/**
 * Decide which email builder to use. Messages carrying file attachments,
 * inline images, or parts carried over from a forwarded message need the
 * nodemailer-based raw builder (multipart/mixed and multipart/related); plain
 * or simple HTML mail uses the lightweight createEmailMessage() builder.
 */
export function needsRawBuilder(args: any): boolean {
    const hasAttachments = Array.isArray(args?.attachments) && args.attachments.length > 0;
    const hasInlineImages = Array.isArray(args?.inlineImages) && args.inlineImages.length > 0;
    const hasRawAttachments = Array.isArray(args?.rawAttachments) && args.rawAttachments.length > 0;
    return hasAttachments || hasInlineImages || hasRawAttachments;
}

