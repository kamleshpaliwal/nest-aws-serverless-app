# LEARNING.md — Docs API (NestJS + AWS Serverless)

Interview target: Technical Architect, 23 Nov 2026. Plan: compressed 3-day path.

---

## Phase 0: Big Picture

### Architecture (summary)
Client → API Gateway (HTTP API) → Lambda #1 (NestJS) → DynamoDB.
Presigned PUT URL → client uploads directly to S3 → S3 ObjectCreated event → Lambda #2 → DynamoDB status = UPLOADED.
CloudWatch for logs/metrics/alarms. GitHub Actions → OIDC → STS → CDK deploy → CloudFormation.

### Request flows
- **Create doc:** APIGW → Lambda (sync) → Nest pipeline (ValidationPipe → controller → service → repo) → PutItem with `attribute_not_exists` → 201.
- **Upload:** `POST /docs/:id/upload-url` signs locally (no S3 call) → client PUTs to S3 directly.
- **S3 event:** async invoke, at-least-once → conditional UpdateItem → idempotent.
- **List:** Query on GSI1, `Limit` + base64(`LastEvaluatedKey`) cursor, newest first.
- **Deploy:** push → Actions → OIDC JWT → STS AssumeRoleWithWebIdentity → temp creds → `cdk deploy` → change set.

### Serverless vs containers vs EC2
| | Lambda | Fargate/ECS | EC2 |
|---|---|---|---|
| Ops | code only | image + scaling config | everything |
| Cost | per request + GB-s, idle = $0 | always-on vCPU/GB-hr | always-on instance-hr |
| Cold start | yes | no | no |
| Limits | 15 min, 6 MB sync payload | few | few |

Cost crossover: Lambda wins at low/bursty traffic; sustained high load favors containers/EC2.
Lambda forces stateless design; watch DB connection counts (DynamoDB is HTTP-based, so no pool issue).

### Decisions + trade-offs
- NestJS on Lambda: structure/DI/testability vs bigger bundle and slower cold start (measure in Phase 11).
- Direct-to-S3 upload: bypasses Lambda payload limits/cost, at the price of an async completion signal (S3 event).
- DynamoDB: no connection limits, scales to zero cost on-demand, but requires access-patterns-first modeling.

### Gotchas
- S3 → Lambda is async + at-least-once: duplicates and retries happen; handlers must be idempotent.
- DynamoDB has no OFFSET; use keyset pagination.

### Glossary
- **Region:** geographic cluster of AWS data centers; most resources live in one.
- **Lambda:** run code on demand, billed per invocation and per ms.
- **Cold start:** extra latency when Lambda creates a new execution environment.
- **Presigned URL:** S3 URL with a SigV4 signature in the query string proving an authorized principal approved this exact request.
- **Idempotency:** running an operation multiple times has the same effect as once.
- **At-least-once delivery:** a message is delivered one or more times, never zero (absent failures), so duplicates are possible.
- **Keyset/cursor pagination:** resume from the last seen key instead of skipping N rows.
- **OIDC:** protocol where an identity provider (GitHub) issues signed JWTs that another system (AWS) trusts.
- **STS:** AWS Security Token Service; issues temporary credentials.
- **Change set:** CloudFormation's preview of what a stack update will add/modify/replace/delete.

### Interview Q&A (corrected answers)
1. **Why upload directly to S3?** Lambda sync payload cap is 6 MB (HTTP API 10 MB); paying Lambda compute to pipe bytes is wasteful and slow clients keep it billing; S3 scales for parallel ingest; presigned URL is scoped to one key/method/expiry so no AWS creds reach the client.
2. **At-least-once async delivery risk?** Duplicate/out-of-order events and automatic retries (async Lambda retries 2x). Protect with idempotent conditional update (`SET status=UPLOADED` with condition; treat condition failure as already done). Production hardening: DLQ / on-failure destination.
3. **Why no OFFSET in DynamoDB?** It doesn't exist; skipping still reads and bills the skipped items; data shifts cause dupes/gaps. Use `Limit` + `LastEvaluatedKey` → `ExclusiveStartKey`, base64-encoded as an opaque cursor (validate it as untrusted input).
4. **Fargate over Lambda?** Sustained high traffic (cost crossover), strict latency SLOs w/o cold starts, >15 min work, WebSockets/warm caches/pools, existing container skills. It's a cost/ops trade-off.
5. **OIDC vs stored keys?** No long-lived secret to leak/rotate; temp creds (~1h) per run; trust policy pins `sub` (repo+branch/env) and `aud`; CloudTrail audit of each assumption.

### Commit message (suggested, deferred until `git init` in Phase 1)
`docs: add LEARNING.md with Phase 0 architecture, flows and interview Q&A`

---

## Phase 1: Accounts & Local Machine Setup

### Decisions + trade-offs
- **Root user locked with MFA, used only for billing/account tasks.** Root can't be restricted by IAM; IAM users can be audited/disabled.
- **IAM user + `aws login` instead of IAM Identity Center.** Identity Center needs AWS Organizations; creating an org upgraded a free-plan account to pay-as-you-go and expired the free credits ($99.98, expiring 2027-11-16). The "account instance" option can't grant AWS account access. `aws login` (CLI >= 2.32) gives temporary credentials without access keys. In a real company: Identity Center + Organizations.
- **Node 22 LTS (not 20):** Node 20 is EOL (Apr 2026); local Node should match the Lambda runtime.
- **Region ap-south-1 (Mumbai):** latency to India, resources are regional. Keep every resource in one region.
- **Separate named profile `docs-api`** instead of reusing `default`, to avoid pointing commands at the wrong account.
- **CDK bootstrap uses AdministratorAccess execution policy by default:** fine for learning; narrow with `--cloudformation-execution-policies` in real orgs.

### Commands used
- `nvm install 22 && nvm alias default 22` — install Node 22 and make it the default in new shells.
- `aws configure list-profiles` / `aws configure list` — list profiles; show where credentials come from (masked).
- `aws login --profile docs-api` — OAuth2 authorization-code + PKCE browser login; caches temporary creds; writes profile to ~/.aws/config.
- `aws sts get-caller-identity --profile docs-api` — "who am I?"; needs no permissions; the first thing to run when debugging.
- `npm install -g aws-cdk` — install the CDK CLI globally.
- `cdk bootstrap aws://933022260230/ap-south-1 --profile docs-api` — creates the CDKToolkit stack (assets S3 bucket, ECR repo, deploy/publish/lookup/execution IAM roles, SSM version parameter). Deploys use a change set.
- `ssh-keygen -t ed25519 -C "<email>" -f ~/.ssh/id_ed25519_github` — key pair; private key never leaves the laptop.
- `cat >> ~/.ssh/config <<'EOF' ... EOF` — APPEND (>> not >) a Host github.com block (IdentityFile, IdentitiesOnly, UseKeychain).
- `ssh -T git@github.com` — test auth; "Hi <user>! ... no shell access" = success.
- `git init -b main`, `git add <files>`, `git commit -m`, `git remote add origin`, `git push -u origin main`.

### Gotchas
- IAM users (even admins) can't see Billing until root enables "IAM user and role access to Billing information".
- Creating an AWS Organization silently converts a free-plan account to paid (check the yellow warning box before clicking Enable).
- `aws login` prompts for a region if the new profile has none; the bracketed default came from the `default` profile, so type the intended region.
- `IdentitiesOnly yes` prevents SSH offering the wrong key (e.g. the Bitbucket one) and getting rejected.
- `git add <missing file>` fails with "pathspec did not match any file"; nothing is staged.
- Budgets alert; they do NOT stop spending.

### Glossary
- **Root user:** the account owner identity; unrestricted; protect with MFA.
- **IAM user / role / policy:** a permanent identity / an assumable identity with temporary creds / a JSON permission document.
- **Principal:** any entity that can make AWS requests.
- **ARN:** `arn:partition:service:region:account-id:resource`, AWS's unique resource ID. IAM ARNs have empty region (global).
- **MFA:** second factor (TOTP code) after a password.
- **IAM Identity Center:** SSO portal issuing temporary role credentials; needs Organizations.
- **Credential provider chain:** ordered lookup of credentials: flags, env vars, profile (config/credentials/SSO/login), container/instance role.
- **Profile:** named settings group in ~/.aws/config.
- **STS:** Security Token Service; issues temporary credentials; `get-caller-identity` shows who you are.
- **OAuth2 authorization code + PKCE:** browser sign-in where the client gets a one-time code and proves possession of a secret via a hash (code_challenge).
- **CDK / CloudFormation / bootstrap / asset:** TS infrastructure code that synthesizes templates / AWS's deployment engine / one-time per account+region setup of a staging bucket and roles / a file (e.g. Lambda zip) uploaded for deployment.
- **Change set:** CloudFormation's preview of modifications.
- **Host key / known_hosts:** the server's identity fingerprint, saved on first use (trust on first use).
- **ssh-agent:** background process holding unlocked private keys.
- **Budget / Cost Explorer:** spend alerts / spend charts with ~1 day lag.

### Commit message
`docs: add Phase 1 setup notes to LEARNING.md`

### Interview Q&A (corrected answers)
1. **Why avoid root / long-lived keys?** Root is unrestricted and can't be limited by IAM; long-lived keys never expire and leak via laptops/repos/logs. Use IAM user/role + MFA with temporary credentials (`aws login`; Identity Center in orgs; OIDC/roles for CI and Lambda) so a stolen credential expires in ~1h.
2. **`Unable to locate credentials`?** Chain order: flags, env vars, profile (config/credentials incl. SSO/login), container/instance role. First match wins; error = none found (forgot `--profile`/`AWS_PROFILE`, expired session). Debug: `aws configure list`, `aws sts get-caller-identity --profile X`; fix by re-running `aws login`.
3. **What does `cdk bootstrap` create?** CDKToolkit stack: assets S3 bucket, ECR repo, IAM roles (deploy, file/image publishing, lookup, CFN execution), SSM version parameter. Needed because templates can't embed code (size limit); CDK uploads assets there. Once per account+region.
4. **Does a $5 budget cap spend?** No, it only alerts, with lagging billing data. A hard cap needs automation (Budget actions / SNS to Lambda applying deny policies or stopping resources), quotas, anomaly detection.
5. **Why region matters?** Latency and data residency; regional isolation (wrong console region looks like missing resources; cross-region is complex/costly); price and service availability differ; some services are fixed (e.g. CloudFront certs in us-east-1).

---

## Phase 2: NestJS Fundamentals

### What we built (app/src)
- `docs/` module: controller -> service -> repository (abstract class `DocsRepository`, in-memory impl for now; DynamoDB in Phase 3).
- DTOs: `CreateDocDto` (trim + length bounds), `ListDocsQueryDto` (`@Type(() => Number)`, limit 1..100, default 20).
- `common/all-exceptions.filter.ts`: maps HttpException, domain errors (409/400) and unknown errors (generic 500, stack only in logs).
- `config/validate-env.ts` + `@nestjs/config` (fail fast on bad env); JSON logging via `ConsoleLogger({ json: true })`.
- `health/health.controller.ts`: liveness only (no DB call).
- `docs/docs.service.spec.ts`: 5 unit tests with a mocked repository.

### Decisions + trade-offs
- **Layering + repository pattern:** testability and swappable persistence, at the cost of more files.
- **Abstract class as DI token:** interfaces are erased at compile time; a class exists at runtime.
- **`APP_PIPE` / `APP_FILTER` in AppModule, not main.ts:** the Lambda handler won't run main.ts, so main.ts-only registration would silently drop validation in production.
- **`forbidNonWhitelisted: true`:** reject unknown fields (stops mass assignment) rather than silently stripping.
- **Domain errors in the repository, mapped to HTTP in a filter:** keeps persistence free of HTTP concepts.
- **Liveness health check doesn't touch the DB:** a DB blip shouldn't mark the service dead.
- **Scaffold is Nest 12 / TS 6 / Jest 30 / oxlint:** newer than the tutor's memory; verify against docs.nestjs.com when behaviour differs. Nest packages are ESM-only; CJS projects load them via require(esm) (Node 22.12+).
- Declined optional NestJS Observe and agent-skill add-ons; observability is CloudWatch (Phase 8).

### Commands used
- `npx @nestjs/cli new app --directory app --package-manager npm --skip-git` — scaffold (CJS + Jest, no nested git repo).
- `npm install class-validator class-transformer @nestjs/config` — runtime deps (installed under `dependencies` by default).
- `npm run start:dev` — watch-mode dev server. `npm test` — Jest.
- `lsof -i :3000`, `kill <PID>`, `pkill -f "nest start --watch"` — find/stop zombie watchers.
- `PORT=3001 npm run start:dev` — env var for one command.
- `curl -i -X POST ... -H 'Content-Type: application/json' -d '{...}'` — -i shows headers, -X method, -H header, -d body.

### Gotchas
- `EADDRINUSE`: a watch-mode process never exits, even after the app crashes; a second server can't bind the same port.
- `whitelist: true` strips any property with no decorator: every DTO field needs at least one.
- Query-string values are strings; use `@Type(() => Number)` before `@IsInt`.
- `emitDecoratorMetadata` is what makes DI work; esbuild doesn't emit it (Phase 4).
- `await expect(promise).rejects...` needs the `await`, or the test can pass falsely.
- Shared mocks across tests leak state; create fresh ones in `beforeEach`.

### Glossary
- **Module / controller / provider:** unit of organisation / HTTP route handler / injectable class.
- **DI container, token, scope:** object that builds and supplies dependencies / the key used to look one up / lifetime (default singleton, request, transient).
- **Decorator:** function run at class-definition time that attaches metadata.
- **reflect-metadata:** library providing Reflect.defineMetadata/getMetadata; stores `design:paramtypes`.
- **Pipe / guard / interceptor / filter / middleware:** validate-transform input / allow-deny / wrap handler / shape errors / raw req-res hook.
- **DTO:** class describing the shape and validation rules of a request payload.
- **Mass assignment:** client sets fields it shouldn't (e.g. status); stopped by whitelisting.
- **Fail fast:** crash at startup on bad config instead of failing later.
- **Liveness vs readiness:** process alive vs able to serve traffic.
- **Stub / mock / spy:** canned answer / checks how it was called / wraps real function and records calls.
- **Unit vs integration vs e2e:** one piece with fakes / real repository + DynamoDB Local / whole deployed system.

### Interview Q&A
1. **How does Nest know DocsService needs DocsRepository; why must the token be a class?** `emitDecoratorMetadata` makes the compiler emit `design:paramtypes` (via reflect-metadata); Nest reads it and resolves each type against registered provider tokens, building singletons recursively. Interfaces are erased at compile time so there is no runtime value to look up; use a class (or a string/Symbol with `@Inject`). esbuild doesn't emit this metadata (Phase 4).
2-5. **To revisit** (skipped by choice, 21 Nov): lifecycle order and roles (middleware, guards, interceptors, pipes, handler, filters); why APP_PIPE in AppModule (Lambda doesn't run main.ts); mass-assignment walkthrough (whitelist + forbidNonWhitelisted + service sets status); what mocked unit tests can't catch (real queries/keys/IAM) and how integration/e2e tests cover it.

### Commit message
`feat(app): scaffold NestJS docs module with validation, filter, config and unit tests`

