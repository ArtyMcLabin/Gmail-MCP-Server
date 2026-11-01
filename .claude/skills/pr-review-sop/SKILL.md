---
name: pr-review-sop
description: PR and issue review SOP for this repository. Use when reviewing PRs, scanning open PRs, triaging issues, or when user says "review PRs", "check PRs", "scan issues". Defines the mandatory security audit, branch workflow, comment/label checks, and merge flow.
user-invocable: false
---

# PR & Issue Review SOP

## Project Philosophy (Read First - Governs Every Review)

**SSoT: README.md § Philosophy.** This fork is **lean and pragmatic**. Local stdio MCP server, minimal dependencies, maintainer dogfoods it daily - "if I wouldn't run it or maintain it myself, it doesn't go in." The **maximalist** direction lives in the downstream fork **klodr/gmail-mcp** (unaffiliated); feature-hungry users get redirected there, politely, with the standard caveat that we don't track its security.

**Every PR and issue assessment MUST include a philosophy verdict: MATCH / MISMATCH / NEUTRAL.**

Heuristics:
- **MATCH:** bugfixes, correctness/reliability of the existing surface, docs accuracy, test coverage for existing behavior, zero-dependency improvements, credential-safety per the local threat model.
- **MISMATCH (default decline + redirect to klodr fork):** new feature surface the maintainer wouldn't use daily, new dependencies, infra/deployment expansion (Docker images, hosting), hardening classes the local threat model explicitly excludes (see Security Standards below), capabilities with an existing simple workaround (e.g. registering the server twice ≈ multi-account).
- **NEUTRAL:** repo hygiene, triage, support/environmental issues, distribution of the existing lean server.

MISMATCH handling: don't build it, don't merge it. **Pitch the item to the maintainer FIRST (angry-king style) and close only after his explicit call** - never auto-close a contributor's PR/issue on philosophy grounds alone (Arty directive 2026-07-10: outward-facing closures are his judgment, MISMATCH verdict or not). Once he says close: comment kindly, point to klodr/gmail-mcp, close.

## Branch Workflow

**Two-branch model: `main` (stable) and `experimental` (staging).**

1. Before starting a new batch of PR reviews/changes: merge `experimental` → `main` IF the experiment is confirmed successful. If no evidence, ask the user.
2. PR merges and own changes go into `experimental` first. Never merge PRs directly into `main`.
3. After a batch is complete on `experimental`: wait for user confirmation, then merge `experimental` → `main`.
4. **After every push to any branch:** run `gh run list --branch {branch} --limit 1` and verify CI passes. If CI fails, fix immediately - do NOT leave broken CI for the user to discover. This applies to every `git push` in the session, not just merges.
   - **Also at the START of every review/triage session:** `gh run list --branch experimental --workflow ci.yml --limit 1`. Red = fix before anything else (incident 2026-11-01: experimental CI had been red since 2026-10-07 on `npm audit --audit-level=critical` and nobody saw it for 3.5 weeks, which blocked the promotion mid-flight).
   - **Lockfile refresh when local npm crashes** (`Cannot read properties of null (reading 'edgesOut')` = npm 10.x arborist bug): regenerate with `npx -y npm@11 install`, then verify with the local `npm ci` + `npm audit --audit-level=critical` + `npm run lockfile:lint` before committing.
5. **End of each dev round (batch merged to `experimental`, awaiting soak):** create a task in the user's Personal CRM (`mcp__claude_ai_Personal_CRM__crm_create_task`, load via ToolSearch) titled "Promote Gmail-MCP experimental→main if soak clean", due ~1 week out (or whatever fits the round's size). The user tracks promotions there, not in GitHub. (Arty directive 2026-07-11.)

## npm & MCP Registry Releases

Published as **@artymclabin/gmail-mcp** on npm + **io.github.ArtyMcLabin/Gmail-MCP-Server** on the official MCP Registry.

- **Tags are cut from `main` ONLY.** Pushing a `v*` tag triggers `.github/workflows/publish.yml` -> npm publish. Never tag `experimental` (incident 2026-07-11: v1.2.0/v1.2.1 tagged off experimental put unsoaked staging code on npm as `latest`; resolved by same-day promotion).
- **Release procedure (at promotion):** merge `experimental`->`main` -> bump version in package.json + package-lock.json + server.json (both `version` fields) -> commit on main -> `git tag vX.Y.Z && git push origin vX.Y.Z` -> verify the "Publish release" workflow is green. The tag push publishes EVERYWHERE automatically: npm -> official MCP Registry (OIDC, no interactive login) -> Smithery (.mcpb bundle built in CI from `mcpb-manifest.json`, version-synced via jq). No manual `mcp-publisher` or `smithery` steps needed. First automated exercise: next release after 2026-07-11 - watch it end-to-end once.
- **npm publishes via OIDC trusted publishing (no NPM_TOKEN).** It only works if npmjs.com has a trusted publisher entry for this package exactly matching GitHub Actions / `ArtyMcLabin` / `Gmail-MCP-Server` / `publish.yml` / no environment. A missing, mismatched or EXPIRED entry fails as a misleading `404 Not Found - PUT .../@artymclabin%2fgmail-mcp`. 🚨 A new entry sits in "Pending validation" and EXPIRES unless a real publish runs within ~2 days, so add it right before cutting a release tag, never weeks ahead (the 2026-08-12 entry had silently expired by the first release). Never change publish auth in the workflow without verifying the npm-side setting in the same session (incident 2026-11-01: the workflow was switched to OIDC on 2026-08-12 claiming npm trusted it; it did not, and v1.2.4 failed to publish). The setting lives on https://www.npmjs.com/package/@artymclabin/gmail-mcp/access and sign-in needs the maintainer's security key - PA drives the browser, the maintainer only taps the key. After a failed publish: fix, then `gh run rerun <run-id> --failed`.
- `mcpName` in package.json must always equal `name` in server.json (registry ownership validation).
- **NPM_TOKEN secret** rotation is tracked in the maintainer's PRIVATE task tracker (Personal CRM) - 🚨 NEVER document token/auth posture details (expiry dates, 2FA state, token types) in this public repo, including GitHub issues (incident 2026-07-11: such an issue was created and had to be deleted - supply-chain recon risk).

## PR Review Checklist (All Steps Mandatory)

### Step 1: Read All Comments and Reviews
- Fetch PR comments: `gh api repos/{owner}/{repo}/pulls/{N}/comments`
- Fetch review comments: `gh api repos/{owner}/{repo}/pulls/{N}/reviews`
- Fetch issue-level comments: included in `gh pr view --json comments`
- Summarize unresolved discussions or requests from repo owner.

### Step 2: Check Labels
- Check for labels: "help wanted", "needs help", "good first issue", etc.
- If "help wanted" / "needs help": assess if anyone volunteered, if PR is stale, if requested help was provided.

### Step 3: Security Audit (Conditional)
- **Skip security audit for PRs with "help wanted" label that are still waiting for community testing/volunteers.** These PRs are parked - auditing them wastes resources. Report a one-liner instead: "PR #N: still waiting for community help, no action needed."
- For all other PRs: run comprehensive security audit using `security-auditor` subagent.
- Explicitly report verdict: "Security audit: **PASS**" or "Security audit: **FAIL** - [findings]"
- Never present a PR review to user without a completed security audit (unless skipped per above).
- For FAIL verdicts: list all findings with severity (CRITICAL/HIGH/MEDIUM/LOW/INFO).
- **Local MCP threat model:** This is a local stdio MCP server (user self-hosts on own PC, not remote/hosted). The LLM client already has full filesystem/shell access. Path traversal, filename injection, and local XSS are NOT security issues in this context - the "attacker" (LLM) already has more powerful tools (Bash, Write). Only flag issues that represent actual risk in the local threat model (e.g., credential leaks to third parties, network-exposed endpoints, dependency supply chain). Do NOT flag local filesystem operations as security vulnerabilities.

### Step 4: Code Review
- Check for merge conflicts, build breakage, test failures.
- Verify consistency with project's established patterns (security hardening, coding style).
- Note missing tests, documentation gaps, dependency concerns.

### Step 5: Philosophy Alignment (Mandatory)
- Assess against **Project Philosophy** (top of this file; SSoT = README.md § Philosophy).
- Verdict per PR: **MATCH / MISMATCH / NEUTRAL** with one-line reasoning.
- MISMATCH default action: request changes or close + redirect to klodr/gmail-mcp - regardless of code quality or security PASS.

### Step 6: Present Findings
- Each PR gets: security verdict, **philosophy verdict**, comment summary, label status, code review findings, recommendation (approve/request changes/close).
- **All tables (PRs and issues) MUST include the author/opener name AND the created date** (last-update date too when it differs meaningfully). Never omit who created the PR/issue or when - the user needs both for context.
- **Pitch decisions in Angry King style by default** (`~/.claude/output-styles/angry-king.md`): one PR at a time, self-contained ≤300-char pitch with date + author, closed A/B/C options, `→ rec:` marked. No technical detail unless asked.

## Merge Flow (When Approving)

**Use GitHub's merge to get the purple "merged" badge - do NOT close manually.**

1. `gh pr edit {N} --base experimental` (retarget PR to experimental BEFORE any local merge)
2. If post-merge fixes are needed (indentation, lockfiles, missing annotations, etc.):
   a. Fetch and fix locally on experimental, push - the PR diff updates automatically.
   b. Or: merge first via GitHub, then commit fixes on top.
3. `gh pr merge {N} --merge` (merge via GitHub - shows purple "merged" badge, credits the contributor)
4. **Verify CI:** `gh run list --branch experimental --limit 1` - wait for result. If CI fails, fix before proceeding.
5. Comment on PR explaining security audit result + any post-merge fixes applied.

**Why not manual close:** "Closed" (red) looks like rejection to contributors and doesn't credit their work on their GitHub profile. Always use `gh pr merge` for accepted PRs.

**Post-merge integration test (mandatory for feature PRs):**
After merging a PR that adds new tools or features, rebuild from source (`npm run build`) and test the actual new functionality end-to-end. Do NOT simulate by using existing tools that happen to call the same API - test the actual new code path. For new MCP tools: rebuild, then invoke the tool via the local MCP server or direct `node` execution to verify it returns correct data.

**If `gh pr merge` can't be used (conflicts):** Merge locally, resolve conflicts, push to the target branch. GitHub will auto-detect the PR as merged when the PR's head commit appears in the target branch history. Leave the PR open (don't close manually) - let GitHub close it automatically with the purple badge.

## Staleness Policy

- PRs with "help wanted" label: keep open for up to **8 months from creation** (Arty directive 2026-07-10, supersedes the earlier 6-month rule). Close as stale if no community participation by then.
- **Track stale-close deadlines as a Personal CRM task, never a self-deleting cron workflow.** The repo `GITHUB_TOKEN` cannot modify `.github/workflows/`, so a workflow that tries to delete itself fails silently and runs forever (the #19 closer ran daily for months after #19 closed; removed 2026-11-01).
- Stale PRs without label: assess on a case-by-case basis.

## Issue Review (Same Rules Apply)

When scanning issues:
- **Philosophy verdict (MATCH / MISMATCH / NEUTRAL) mandatory per issue**, same heuristics as PRs. Feature requests default MISMATCH -> decline + redirect to klodr/gmail-mcp unless maintainer would use it daily.
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
