/**
 * Helper functions for reply_all email functionality.
 * Extracted for testability.
 */

/**
 * Parses email addresses from a header value.
 * Handles formats like:
 * - "email@example.com"
 * - "Name <email@example.com>"
 * - Multiple addresses separated by commas
 *
 * @param headerValue - The raw header value (e.g., From, To, CC)
 * @returns Array of extracted email addresses
 */
export function parseEmailAddresses(headerValue: string): string[] {
    if (!headerValue) return [];

    const emails: string[] = [];
    const parts = headerValue.split(',');

    for (const part of parts) {
        const trimmed = part.trim();
        // Extract email from "Name <email>" format
        const match = trimmed.match(/<([^>]+)>/);
        if (match) {
            emails.push(match[1].trim());
        } else if (trimmed.includes('@')) {
            emails.push(trimmed);
        }
    }

    return emails;
}

/**
 * Filters out the authenticated user's email from a list of emails.
 * Case-insensitive comparison.
 *
 * @param emails - Array of email addresses to filter
 * @param myEmail - The authenticated user's email address
 * @returns Filtered array excluding the user's email
 */
export function filterOutEmail(emails: string[], myEmail: string): string[] {
    const myEmailLower = myEmail.toLowerCase();
    return emails.filter(email => email.toLowerCase() !== myEmailLower);
}

/**
 * Adds "Re: " prefix to a subject if not already present.
 * Case-insensitive check for existing prefix.
 *
 * @param subject - The original email subject
 * @returns Subject with "Re: " prefix
 */
export function addRePrefix(subject: string): string {
    if (subject.toLowerCase().startsWith('re:')) {
        return subject;
    }
    return `Re: ${subject}`;
}

/**
 * Builds the References header for a reply email.
 * Combines original References with original Message-ID.
 *
 * @param originalReferences - The References header from the original email
 * @param originalMessageId - The Message-ID of the original email
 * @returns Combined References header value
 */
export function buildReferencesHeader(originalReferences: string, originalMessageId: string): string {
    if (!originalMessageId) {
        return originalReferences;
    }
    return originalReferences ? `${originalReferences} ${originalMessageId}` : originalMessageId;
}

/**
 * Builds recipient lists for a reply-all email.
 *
 * Rules:
 * - TO: original From (sender of the email)
 * - CC: original To + original CC (excluding the authenticated user)
 *
 * @param originalFrom - From header value
 * @param originalTo - To header value
 * @param originalCc - CC header value
 * @param myEmail - The authenticated user's email address
 * @returns Object with 'to' and 'cc' arrays
 */
export function buildReplyAllRecipients(
    originalFrom: string,
    originalTo: string,
    originalCc: string,
    myEmail: string
): { to: string[]; cc: string[] } {
    const fromEmails = parseEmailAddresses(originalFrom);
    const toEmails = parseEmailAddresses(originalTo);
    const ccEmails = parseEmailAddresses(originalCc);

    // TO recipients: original From (the person who sent the email), excluding myself
    const replyTo = filterOutEmail(fromEmails, myEmail);

    // CC recipients: everyone else who was on To and CC, excluding myself
    const replyCc = filterOutEmail([...toEmails, ...ccEmails], myEmail);

    return {
        to: replyTo,
        cc: replyCc
    };
}
