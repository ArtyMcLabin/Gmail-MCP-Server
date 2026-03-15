---
name: pr-review-sop
description: PR and issue review SOP for this repository. Use when reviewing PRs, scanning open PRs, triaging issues, or when user says "review PRs", "check PRs", "scan issues". Defines the mandatory security audit, branch workflow, comment/label checks, and merge flow.
user-invocable: false
---

# PR & Issue Review SOP

## Branch Workflow

**Two-branch model: `main` (stable) and `experimental` (staging).**

1. Before starting a new batch of PR reviews/changes: merge `experimental` → `main` IF the experiment is confirmed successful. If no evidence, ask the user.
2. PR merges and own changes go into `experimental` first. Never merge PRs directly into `main`.
3. After a batch is complete on `experimental`: wait for user confirmation, then merge `experimental` → `main`.

## PR Review Checklist (All Steps Mandatory)

### Step 1: Read All Comments and Reviews
- Fetch PR comments: `gh api repos/{owner}/{repo}/pulls/{N}/comments`
- Fetch review comments: `gh api repos/{owner}/{repo}/pulls/{N}/reviews`
- Fetch issue-level comments: included in `gh pr view --json comments`
- Summarize unresolved discussions or requests from repo owner.

### Step 2: Check Labels
- Check for labels: "help wanted", "needs help", "good first issue", etc.
- If "help wanted" / "needs help": assess if anyone volunteered, if PR is stale, if requested help was provided.

### Step 3: Security Audit (Mandatory, Before Presenting)
- Run comprehensive security audit on EVERY PR using `security-auditor` subagent.
- Explicitly report verdict: "Security audit: **PASS**" or "Security audit: **FAIL** — [findings]"
- Never present a PR review to user without a completed security audit.
- For FAIL verdicts: list all findings with severity (CRITICAL/HIGH/MEDIUM/LOW/INFO).
- **Local MCP threat model:** This is a local stdio MCP server (user self-hosts on own PC, not remote/hosted). The LLM client already has full filesystem/shell access. Path traversal, filename injection, and local XSS are NOT security issues in this context — the "attacker" (LLM) already has more powerful tools (Bash, Write). Only flag issues that represent actual risk in the local threat model (e.g., credential leaks to third parties, network-exposed endpoints, dependency supply chain). Do NOT flag local filesystem operations as security vulnerabilities.

### Step 4: Code Review
- Check for merge conflicts, build breakage, test failures.
- Verify consistency with project's established patterns (security hardening, coding style).
- Note missing tests, documentation gaps, dependency concerns.

### Step 5: Present Findings
- Each PR gets: security verdict, comment summary, label status, code review findings, recommendation (approve/request changes/close).

## Merge Flow (When Approving)

1. Fetch PR branch locally: `git fetch origin pull/{N}/head:pr-{N}`
2. Checkout `experimental` and merge: `git merge pr-{N} --no-edit`
3. Fix any build/test breakage caused by the merge.
4. **Post-merge patching:** If the PR has minor quality issues (wrong indentation, extra lockfiles, missing annotations for new tools, etc.), fix them ourselves in the same commit rather than sending back to the contributor. Avoid back-and-forth on trivial fixes.
5. Commit fixes, push experimental.
6. Comment on PR explaining the merge + security audit result + any post-merge fixes applied. Close PR.

## Staleness Policy

- PRs with "help wanted" label: keep open for up to 6 months. Close if no community participation by then.
- Stale PRs without label: assess on a case-by-case basis.

## Issue Review (Same Rules Apply)

When scanning issues:
- Read all comments.
- Check labels ("help wanted", "needs help", "bug", "enhancement", etc.).
- Assess actionability: is someone working on it? Is it stale? Is help still needed?
- Report findings same as PRs.

## Security Standards (This Project)

**Threat model: local stdio MCP server.** User self-hosts on own machine. LLM client already has full filesystem/shell access. Security audits must account for this context.

Established hardening from commits `95071e7` and `208ce00`:
- CRLF header injection prevention
- OAuth callback localhost binding
- Credential file permission hardening
- Dependency security (npm audit)

**NOT security issues for this project** (local MCP context):
- Path traversal on filesystem operations (LLM already has Bash/Write)
- Filename injection (same reasoning)
- Local XSS in exported files (user opens their own files)
- Symlink following (local user's filesystem)
