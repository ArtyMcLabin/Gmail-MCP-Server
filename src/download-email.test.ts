/**
 * Test plan for download_email tool (PR #13)
 *
 * 1. Verify download_email with each format (json, eml, txt, html)
 * 2. Verify scope filtering works (tool visible with gmail.readonly)
 * 3. Verify directory creation when savePath doesn't exist
 * 4. Verify existing tools still work after extractHeaders refactor
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  gmailMessageToJson,
  emailToTxt,
  emailToHtml,
  parseEmailAddress,
  parseEmailAddresses,
} from "./email-export.js";
import { toolDefinitions, getToolByName, DownloadEmailSchema } from "./tools.js";
import { hasScope } from "./scopes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Shared mock data
const mockHeaders = [
  { name: "From", value: "Alice <alice@example.com>" },
  { name: "To", value: "Bob <bob@example.com>, Carol <carol@example.com>" },
  { name: "Cc", value: "dave@example.com" },
  { name: "Subject", value: "Test Email Subject" },
  { name: "Date", value: "Fri, 13 Mar 2026 10:00:00 +0000" },
  { name: "Message-ID", value: "<msg123@example.com>" },
  { name: "In-Reply-To", value: "<prev@example.com>" },
  { name: "References", value: "<orig@example.com> <prev@example.com>" },
];

const mockMessage = {
  id: "msg_abc123",
  threadId: "thread_xyz",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "This is a test email...",
  payload: { headers: mockHeaders },
};

const mockContent = {
  text: "Hello, this is the plain text body.",
  html: "<html><body><p>Hello, this is the <b>HTML</b> body.</p></body></html>",
};

const mockAttachments = [
  { id: "att1", filename: "report.pdf", mimeType: "application/pdf", size: 102400 },
  { id: "att2", filename: "photo.jpg", mimeType: "image/jpeg", size: 204800 },
];

// ─────────────────────────────────────────────
// 1. Format tests (json, txt, html)
// ─────────────────────────────────────────────
describe("download_email formats", () => {
  describe("JSON format", () => {
    it("produces valid structured JSON with all fields", () => {
      const json = gmailMessageToJson(mockMessage, mockContent, mockAttachments);

      expect(json.messageId).toBe("msg_abc123");
      expect(json.threadId).toBe("thread_xyz");
      expect(json.subject).toBe("Test Email Subject");
      expect(json.from.email).toBe("alice@example.com");
      expect(json.from.name).toBe("Alice");
      expect(json.to).toHaveLength(2);
      expect(json.to[0].email).toBe("bob@example.com");
      expect(json.cc).toHaveLength(1);
      expect(json.cc[0].email).toBe("dave@example.com");
      expect(json.labels).toEqual(["INBOX", "UNREAD"]);
      expect(json.snippet).toBe("This is a test email...");
      expect(json.body.plain).toBe(mockContent.text);
      expect(json.body.html).toBe(mockContent.html);
      expect(json.attachments).toHaveLength(2);
      expect(json.attachments[0].filename).toBe("report.pdf");
      expect(json.headers["Message-ID"]).toBe("<msg123@example.com>");
      expect(json.headers["In-Reply-To"]).toBe("<prev@example.com>");
      expect(json.headers["References"]).toBe("<orig@example.com> <prev@example.com>");
    });

    it("converts date to ISO format", () => {
      const json = gmailMessageToJson(mockMessage, mockContent, []);
      expect(json.date).toBe("2026-03-13T10:00:00.000Z");
    });

    it("handles missing headers gracefully", () => {
      const emptyMessage = { id: "x", threadId: "t", payload: { headers: [] } };
      const json = gmailMessageToJson(emptyMessage, { text: "", html: "" }, []);
      expect(json.subject).toBe("");
      expect(json.from.email).toBe("");
      expect(json.to).toEqual([]);
    });

    it("serializes to valid JSON string", () => {
      const json = gmailMessageToJson(mockMessage, mockContent, mockAttachments);
      const str = JSON.stringify(json, null, 2);
      expect(() => JSON.parse(str)).not.toThrow();
    });
  });

  describe("TXT format", () => {
    it("produces headers and body in plain text", () => {
      const txt = emailToTxt(mockMessage, mockContent, mockAttachments);

      expect(txt).toContain("From: Alice <alice@example.com>");
      expect(txt).toContain("To: Bob <bob@example.com>, Carol <carol@example.com>");
      expect(txt).toContain("CC: dave@example.com");
      expect(txt).toContain("Subject: Test Email Subject");
      expect(txt).toContain("Date: Fri, 13 Mar 2026 10:00:00 +0000");
      expect(txt).toContain("Hello, this is the plain text body.");
      expect(txt).toContain("Attachments: report.pdf, photo.jpg");
    });

    it("omits CC line when empty", () => {
      const noCcHeaders = mockHeaders.filter((h) => h.name !== "Cc");
      const msg = { ...mockMessage, payload: { headers: noCcHeaders } };
      const txt = emailToTxt(msg, mockContent, []);
      expect(txt).not.toContain("CC:");
    });

    it("shows placeholder when no text content", () => {
      const txt = emailToTxt(mockMessage, { text: "", html: "<p>HTML only</p>" }, []);
      expect(txt).toContain("[No plain text content]");
    });

    it("omits attachment section when no attachments", () => {
      const txt = emailToTxt(mockMessage, mockContent, []);
      expect(txt).not.toContain("Attachments:");
    });
  });

  describe("HTML format", () => {
    it("returns raw HTML content", () => {
      const html = emailToHtml(mockContent);
      expect(html).toBe(mockContent.html);
      expect(html).toContain("<b>HTML</b>");
    });

    it("throws when no HTML content available", () => {
      expect(() => emailToHtml({ text: "plain only", html: "" })).toThrow(
        "This email has no HTML content"
      );
    });
  });
});

// ─────────────────────────────────────────────
// 2. Scope filtering
// ─────────────────────────────────────────────
describe("download_email scope filtering", () => {
  it("is registered in toolDefinitions", () => {
    const tool = getToolByName("download_email");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("download_email");
  });

  it("is visible with gmail.readonly scope", () => {
    const tool = getToolByName("download_email")!;
    expect(hasScope(["gmail.readonly"], tool.scopes)).toBe(true);
  });

  it("is visible with gmail.modify scope", () => {
    const tool = getToolByName("download_email")!;
    expect(hasScope(["gmail.modify"], tool.scopes)).toBe(true);
  });

  it("is NOT visible with only gmail.send scope", () => {
    const tool = getToolByName("download_email")!;
    expect(hasScope(["gmail.send"], tool.scopes)).toBe(false);
  });

  it("is NOT visible with only gmail.compose scope", () => {
    const tool = getToolByName("download_email")!;
    expect(hasScope(["gmail.compose"], tool.scopes)).toBe(false);
  });

  it("works with full URL scope format", () => {
    const tool = getToolByName("download_email")!;
    expect(
      hasScope(["https://www.googleapis.com/auth/gmail.readonly"], tool.scopes)
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────
// 3. Schema validation
// ─────────────────────────────────────────────
describe("DownloadEmailSchema", () => {
  it("accepts valid input with all fields", () => {
    const result = DownloadEmailSchema.parse({
      messageId: "msg123",
      savePath: "/tmp/emails",
      format: "json",
    });
    expect(result.messageId).toBe("msg123");
    expect(result.savePath).toBe("/tmp/emails");
    expect(result.format).toBe("json");
  });

  it("defaults format to json", () => {
    const result = DownloadEmailSchema.parse({
      messageId: "msg123",
      savePath: "/tmp/emails",
    });
    expect(result.format).toBe("json");
  });

  it("accepts all valid formats", () => {
    for (const fmt of ["json", "eml", "txt", "html"]) {
      const result = DownloadEmailSchema.parse({
        messageId: "msg123",
        savePath: "/tmp",
        format: fmt,
      });
      expect(result.format).toBe(fmt);
    }
  });

  it("rejects invalid format", () => {
    expect(() =>
      DownloadEmailSchema.parse({
        messageId: "msg123",
        savePath: "/tmp",
        format: "xml",
      })
    ).toThrow();
  });

  it("requires messageId", () => {
    expect(() =>
      DownloadEmailSchema.parse({ savePath: "/tmp" })
    ).toThrow();
  });

  it("requires savePath", () => {
    expect(() =>
      DownloadEmailSchema.parse({ messageId: "msg123" })
    ).toThrow();
  });
});

// ─────────────────────────────────────────────
// 4. extractHeaders refactor verification
// ─────────────────────────────────────────────
describe("extractHeaders refactor - source verification", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "index.ts"), "utf-8");

  it("extractHeaders function exists and returns rfcMessageId", () => {
    expect(indexSource).toContain("function extractHeaders");
    expect(indexSource).toContain("rfcMessageId");
    expect(indexSource).toContain('getHeader("message-id")');
  });

  it("read_email uses extractHeaders (not inline header extraction)", () => {
    // The read_email case should use destructured extractHeaders call
    expect(indexSource).toContain("const { subject, from, to, date, rfcMessageId } = extractHeaders(");
  });

  it("download_email uses extractHeaders", () => {
    // download_email should also use extractHeaders
    expect(indexSource).toContain('const { subject, from, date } = extractHeaders(');
  });

  it("read_email still outputs Message-ID in response", () => {
    expect(indexSource).toContain("Message-ID: ${rfcMessageId}");
  });
});

// ─────────────────────────────────────────────
// Email address parsing (email-export.ts)
// ─────────────────────────────────────────────
describe("email-export parseEmailAddress", () => {
  it('parses "Name" <email> format', () => {
    const result = parseEmailAddress('"John Doe" <john@example.com>');
    expect(result.name).toBe("John Doe");
    expect(result.email).toBe("john@example.com");
  });

  it("parses Name <email> without quotes", () => {
    const result = parseEmailAddress("Alice <alice@example.com>");
    expect(result.name).toBe("Alice");
    expect(result.email).toBe("alice@example.com");
  });

  it("parses bare email", () => {
    const result = parseEmailAddress("user@example.com");
    expect(result.name).toBe("");
    expect(result.email).toBe("user@example.com");
  });

  it("handles empty string", () => {
    const result = parseEmailAddress("");
    expect(result.email).toBe("");
  });
});

describe("email-export parseEmailAddresses", () => {
  it("splits comma-separated addresses", () => {
    const results = parseEmailAddresses("a@test.com, b@test.com");
    expect(results).toHaveLength(2);
    expect(results[0].email).toBe("a@test.com");
    expect(results[1].email).toBe("b@test.com");
  });

  it("handles undefined", () => {
    expect(parseEmailAddresses(undefined)).toEqual([]);
  });
});
