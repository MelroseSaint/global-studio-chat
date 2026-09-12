# Security review

## When a change needs a security look

- It parses or stores anything a user (or the internet) controls.
- It changes the auth stack (`@convex-dev/auth`, sessions, JWTs, the
  auth provider in `src/convex/auth.ts`).
- It touches crypto (`src/lib/dm-crypto.ts` — E2E DMs), the moderation
  pipeline, the admin surfaces, or the upload path (`src/convex/media*`).
- It adds a new external service call or env var.

## The standing invariants (a change must not weaken them)

1. **DMs are E2E-encrypted.** The server stores only AES-GCM ciphertext
   and never sees key material. Any server-side "just log the plaintext"
   is a design violation, not a debugging aid.
2. **Media bytes live in Cloudinary; Convex holds references only**
   (docs/media-storage.md). Uploads are client-side re-encoded (metadata
   stripped) and the server remuxes video before storing/serving.
3. **Email identity is normalized before ownership decisions**
   (`normalizeEmailIdentity`) — one inbox, one verified badge, no
   dot/+tag farming.
4. **Email hashes are salted** (`EMAIL_HASH_SALT`) — a DB leak does not
   leak membership.
5. **Test isolation:** QA fixtures (qa_ handles) are invisible to real
   members on every surface; real members cannot follow qa_ accounts.
6. **The harness is gated:** every `testHarness` mutation requires
   `TEST_HARNESS_ENABLED=1` AND the secret; QA usernames are
   namespace-reserved.
7. **Admin surfaces check role + IP binding**, and moderation actions
   leave an audit trail with the acting admin's identity.

## Dependency & supply chain

- The **Dependency audit** CI job fails on high/critical advisories.
  If a finding must be accepted (no fix exists), add its advisory ID to
  `NPM_AUDIT_ALLOWLIST` in the workflow env **and** record the reason
  and review date in this file:

  ```
  ## Accepted risks
  (none currently — keep it that way when possible)
  ```

- Dependabot opens grouped weekly PRs (minor/patch together, majors
  separately). Auth-adjacent bumps (`@convex-dev/auth`, `@auth/core`,
  `convex`) always get the full verification pass: typecheck, lint,
  unit tests, build, backend deploy to prod, then the signup E2E
  (`RESEND_API_KEY=… npm run qa:signup-e2e`) and `qa:prod-pipeline`.

## Secrets hygiene

- The **Secrets scan** CI job fails the build if credential-shaped
  strings land in the tree. Live secrets belong in Convex env, GitHub
  secrets, or Vercel env — never in code, never in docs, never in the
  run logs pasted into issues.
- The repo owner's password and API secrets are user-held; CI receives
  them only through GitHub's secret vault.

## Reviewer's quick triage for a risky diff

1. Where does the new input come from, and where does it go?
2. What is the worst thing a hostile user could do with this endpoint?
3. Is anything trusted client-side that shouldn't be?
4. Does the change widen the admin surface?
5. Are the QA scripts updated to cover the new behavior (negative
   cases, not just the happy path)?
