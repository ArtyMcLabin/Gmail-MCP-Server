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
4. **After every push to any branch:** run `gh run list --branch {branch} --limit 1` and verify CI passes. If CI fails, fix immediately — do NOT leave broken CI for the user to discover. This applies to every `git push` in the session, not just merges.

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

**Use GitHub's merge to get the purple "merged" badge — do NOT close manually.**

1. `gh pr edit {N} --base experimental` (retarget PR to experimental BEFORE any local merge)
2. If post-merge fixes are needed (indentation, lockfiles, missing annotations, etc.):
   a. Fetch and fix locally on experimental, push — the PR diff updates automatically.
   b. Or: merge first via GitHub, then commit fixes on top.
3. `gh pr merge {N} --merge` (merge via GitHub — shows purple "merged" badge, credits the contributor)
4. **Verify CI:** `gh run list --branch experimental --limit 1` — wait for result. If CI fails, fix before proceeding.
5. Comment on PR explaining security audit result + any post-merge fixes applied.

**Why not manual close:** "Closed" (red) looks like rejection to contributors and doesn't credit their work on their GitHub profile. Always use `gh pr merge` for accepted PRs.

**If `gh pr merge` can't be used (conflicts):** Merge locally, resolve conflicts, push to the target branch. GitHub will auto-detect the PR as merged when the PR's head commit appears in the target branch history. Leave the PR open (don't close manually) — let GitHub close it automatically with the purple badge.

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

## CI Verification (Mandatory)

After every push (to any branch), check CI status: `gh run list --branch {branch} --limit 1`
- If CI fails: investigate and fix before moving on. Do NOT leave broken CI.
- **README check:** CI requires README.md to be updated on every push to `main`. If the change doesn't need docs, add `[skip-readme]` to the commit message.
- **Build & Test:** Must pass. If it fails, fix the code.
- CI triggers on both `main` and `experimental` pushes, and PRs targeting either branch.

## Session Hygiene

- **Always end on `experimental` branch.** Before finishing a session, verify: `git branch --show-current` = `experimental`. If not, `git checkout experimental`.
- Local working copy should always track `experimental` since that's the active development branch.
