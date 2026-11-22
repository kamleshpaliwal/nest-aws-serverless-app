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

---

## Phase 3: DynamoDB in depth

### Key design (from access patterns)
| Item | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| Doc | `DOC#<id>` | `METADATA` | `USER#<userId>` | `DOC#<createdAt>` |

Access patterns: A1 create (Put + attribute_not_exists), A2 get (GetItem, ConsistentRead), A3 list by user newest-first (Query GSI1, ScanIndexForward=false), A4 mark uploaded (UpdateItem + attribute_exists).

### How DynamoDB works
Partition key hashed -> partition (<=10 GB, ~3000 RCU/1000 WCU each); items sorted by SK in a partition (item collection); 3-AZ replication; no joins/OFFSET. Query reads within a key, Scan reads everything. GSI: own keys, eventually consistent, extra writes, can be added later. LSI: same PK, must exist at table creation, 10 GB collection limit, strong reads OK. On-demand vs provisioned; 400 KB item limit; TTL (deletes within ~48h, free); Streams (24h ordered change log); transactions (2x cost, <=100 items); batch ops (not atomic, handle UnprocessedItems).

RCU = 1 strongly consistent 4 KB read/s (0.5 eventual, 2 transactional); WCU = 1 KB write/s (2 transactional); round UP.

### Decisions + trade-offs
- Single table with prefixed keys: one resource to secure/manage, related items in one query; harder to read and to change access patterns later.
- ConsistentRead on GetItem: read-your-writes for ~1 RCU instead of 0.5; GSIs can't be strongly consistent.
- `Limit + 1` pagination: one extra item read avoids an empty trailing page.
- Cursor = base64url(JSON of LastEvaluatedKey), validated (shape + must match requested user); production: sign/encrypt it.
- toDoc() allow-list: key attributes never leak into API responses.
- Server-generated UUIDv4 ids (crypto.randomUUID): unguessable, evenly hashed, not time-sortable (UUIDv7/ULID are). Retried POSTs create duplicates -> idempotency keys.
- Local dev: DynamoDB Local in Docker, throwaway creds (`local`/`local`) so a mistake can never touch real AWS.
- Projection ALL on GSI1: simplest, costs storage/WCU; KEYS_ONLY/INCLUDE are cheaper but need extra reads.

### Commands used
- `docker run -d --name dynamodb-local -p 8000:8000 amazon/dynamodb-local` — start DynamoDB Local (in-memory; data lost when the container is removed). `docker ps`, `docker stop|rm dynamodb-local`.
- `AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local aws dynamodb create-table --endpoint-url http://localhost:8000 ...` — create the table locally (attribute-definitions only for key attrs; key-schema HASH/RANGE; GSI with projection; PAY_PER_REQUEST).
- `npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb` — low-level client + DocumentClient (marshalling).
- `npm run test:int` — integration tests (`*.int-spec.ts`, excluded from `npm test`).

### Gotchas
- `status` is a DynamoDB reserved word: alias with ExpressionAttributeNames (`#status`).
- UpdateItem is an upsert: add `attribute_exists(PK)` or you create ghost items.
- PutItem overwrites by default: add `attribute_not_exists(PK)`.
- SDK rejects `undefined` values unless `removeUndefinedValues: true`.
- Limit without +1 can yield a cursor to an empty page.
- Waiters: default minDelay 20s and maxWaitTime must exceed it; a failing `beforeAll` fails every test in the file (read the FIRST error).
- TS: interfaces have no implicit index signature, so they're not assignable to `Record<string, unknown>`; cast at the boundary where untyped SDK data enters.
- `npm run` finds the nearest package.json: run it from `app/`, not the repo root.
- **`npm install` from the wrong folder** silently created a root package.json + node_modules; the app still worked because Node resolution walks UP parent folders, but app/package.json lacked the deps, so CI (`npm ci`) and CDK bundling would have failed with "Cannot find module". Clues: "Missing script" error and `../node_modules` in a stack trace. Fix: delete root install, reinstall inside `app/`. Always check `pwd` before `npm install`.
- Build caches (`*.tsbuildinfo`) must not be committed; `git rm --cached -f <file>` untracks without deleting.
- Calling a mocked unit test "proof" is a trap: it can't catch key-design, condition or IAM bugs.

### Glossary
- **Partition / partition key / sort key / item collection:** storage shard / its hashed key / ordering key within it / all items sharing a PK.
- **GSI / LSI:** index with its own keys (any time, eventual) / same PK, different SK (creation time only).
- **Hot partition:** one key value getting disproportionate traffic.
- **RCU / WCU:** read / write capacity units (4 KB / 1 KB).
- **On-demand:** pay per request. **Provisioned:** reserve capacity.
- **Marshalling:** converting JS values to DynamoDB's typed wire format (`{S: "x"}`) and back.
- **ConditionExpression:** server-side atomic precondition on a write.
- **LastEvaluatedKey / ExclusiveStartKey:** where a Query stopped / where the next one resumes.
- **Reserved word / ExpressionAttributeNames:** keywords that can't be used raw / aliases (`#name`).
- **Idempotency:** repeating an operation has the same effect as doing it once.
- **Waiter:** SDK helper that polls until a resource reaches a state.

### Interview Q&A (model answers)
1. **Why does PK=DOC#id avoid hot partitions; when could the GSI be hot?** Random UUIDs hash evenly. GSI1PK=USER#id puts one user's docs in one index partition; a very heavy user can exceed per-partition limits. Mitigate by write-sharding the key (USER#id#0..N) and merging reads.
2. **Why Limit+1?** DynamoDB returns LastEvaluatedKey whenever Limit stopped the read, even if nothing remains, causing an empty last page; one extra item tells us if more exist.
3. **How do you stop POST overwriting; what error?** `ConditionExpression: attribute_not_exists(PK)` evaluated atomically server-side; failure = ConditionalCheckFailedException -> domain error -> 409. Without it PutItem silently replaces.
4. **Cost: 6 KB item, 100 strongly consistent reads/s?** ceil(6/4)=2 RCU per read -> 200 RCU; eventual: 100 RCU.
5. **Why not store files in DynamoDB?** 400 KB item limit, large items burn capacity, S3 is cheaper and built for objects; store metadata + key only.

### Commit message
`feat(app): add DynamoDB repository with conditional writes, GSI pagination and integration tests`

---

## Phases 4-7: Lambda, API Gateway, S3, CDK, first deploy (22 Nov 2026)

### Architecture as deployed (stack `DocsApiStack`, account 933022260230, ap-south-1)
HTTP API (`ANY /{proxy+}`) -> `ApiFunction` (NestJS via @codegenie/serverless-express, 512 MB, 10 s) -> `TableV2` (PK/SK + GSI1, on-demand). `POST /docs/:id/upload-url` presigns a PUT to `uploads/<docId>`; S3 `ObjectCreated` (prefix `uploads/`) -> `UploadedFunction` (plain handler, 256 MB, DLQ) -> `UpdateItem status=UPLOADED`. Log groups retention 7 days. Deploy took ~80 s.

### Lambda (Phase 4)
- Execution environment = Firecracker microVM, one request at a time; INIT (runtime + top-level code) runs once, INVOKE per request; warm reuse for minutes. Concurrency default 1000/region. Memory sets CPU. Timeout max 15 min, sync payload 6 MB, /tmp 512 MB-10 GB. Execution role provides credentials (no keys in code). Price ~$0.20/M requests + ~$0.0000167/GB-s; always-free 1M req + 400k GB-s.
- Handler caches the bootstrap PROMISE at module level (shared by overlapping calls; cleared on failure so a transient error isn't cached). `app.init()` not `listen()`.
- HTTP API vs REST API: HTTP ~$1/M, lower latency, JWT authorizers, CORS; REST ~$3.50/M adds API keys/usage plans, request validation, WAF, caching. Payload format v2; integration timeout 30 s; payload 10 MB.
- **esbuild + Nest DI gotcha:** esbuild doesn't emit `design:paramtypes`. Reproduced locally: Nest 12 warns "X has no decorator metadata ... esbuild don't emit it", then `DynamoDocsRepository` crashed at bootstrap (`config` undefined). Explicit `@Inject(Token)` needs no metadata (index [0] worked, [1] failed). Fix: compile with tsc first, then bundle the JS. Also mark Nest's optional packages (`@nestjs/microservices`, `@nestjs/websockets`, subpaths) external or esbuild fails to resolve.
- **Final build design:** `npm run build:lambda` (tsc -p tsconfig.lambda.json -> app/build/lambda), run automatically by cdk.json `app` command; CDK bundles `build/lambda/*.js`. We first tried `bundling.preCompilation` (works, needs `esbuildArgs --resolve-extensions .js` so esbuild picks compiled JS) but it emits .js/.d.ts/.js.map NEXT TO the sources (it swaps .ts->.js in place), which can shadow .ts in Jest (moduleFileExtensions js before ts). Trade-off: convenience vs source-tree pollution.
- Verified bundles contain metadata: `grep -c design:paramtypes infra/cdk.out/asset.*/index.js` (45 / 30 for our two functions, 0 for CDK helper).

### S3 + presigned URLs (Phase 5)
- Buckets/keys/objects; 11-nines durability; strong read-after-write; storage classes; PUT up to 5 GB (multipart up to 5 TB); private + Block Public Access; bucket policy (resource) vs IAM policy (identity); SSE-S3 default; CORS needed for browser PUT.
- SigV4 presign is local math (no network call). Signature covers method, path, signed headers, expiry; URL carries the signer's permissions; with role credentials the URL's real lifetime is min(expiresIn, credential expiry) and includes X-Amz-Security-Token. The signing role itself needs s3:PutObject (we granted `uploads/*` only).
- **GOTCHA found by the e2e test:** SDK v3 does NOT sign `Content-Type` by default, so a URL minted for text/plain accepted image/png (200 instead of 403). Fix: `getSignedUrl(..., { signableHeaders: new Set(['content-type']) })`. Verified option in @smithy/types.
- Presigned PUT can't cap size; presigned POST (content-length-range) can; multipart for large files; allow-list content types (stored XSS via text/html).
- S3 event handling: async invoke, at-least-once, out-of-order possible, 2 retries then DLQ; object key URL-encoded ("+" = space); idempotent conditional update; unknown doc -> log, don't throw (retry can't help); unexpected error -> throw (retry).

### CDK / CloudFormation (Phase 6)
- CFN: template, stack, resource (logical vs physical ID), parameters, outputs, intrinsics (Ref, GetAtt, Sub, Join), change set (add [+], modify [~], delete [-], replace [-/+]), rollback. CDK synthesizes CFN; construct tree App > Stack > Construct; L1/L2/L3; tokens; assets in bootstrap bucket (`cdk-hnb659fds-assets-<acct>-<region>`).
- Logical ID = construct path + hash: renaming a construct id REPLACES the resource (data loss for table/bucket).
- CDK CLI (2.1149) and aws-cdk-lib (2.278) are versioned independently; CLI pinned in infra/package.json, run with `npx cdk`.
- cdk.json `context` = feature flags (opt-in to new defaults); `app` = command CDK runs to build the tree; cdk.context.json caches lookups (commit it).
- Template notes: TableV2 = `AWS::DynamoDB::GlobalTable`; `RemovalPolicy.DESTROY` -> DeletionPolicy Delete (default is RETAIN); BucketPolicy denies non-TLS; extra resources CDK adds: auto-delete custom resource Lambda, S3 notification custom resource (Python Lambda), SQS DLQ.
- Least privilege: API role = GetItem/PutItem/Query (+ /index/*) and s3:PutObject on `<bucket>/uploads/*`; Uploaded role = UpdateItem + sqs:SendMessage to DLQ. (`table.grant` also adds /index/* - slightly broader than needed.)
- CDK vs SAM vs Terraform: CDK = real language + CFN engine, AWS-only; SAM = YAML, local invoke; Terraform = multi-cloud, own state.

### Deploy + e2e (Phase 7)
- `npx cdk diff --profile docs-api` then `npx cdk deploy --profile docs-api` (from infra/). Outputs: ApiUrl, BucketName, TableName.
- `node scripts/e2e.mjs <api-url>`: 14 assertions covering health, validation, create/get/404/400, presign, wrong content-type 403, upload, async UPLOADED via S3 event, pagination, bad cursor.
- Cold start (new environment after deploy) 1712 ms vs ~327 ms warm.

### Gotchas (this stretch)
- `aws login` sessions are short-lived: "Your session has expired" -> `aws login --profile docs-api`. CDK said "no credentials have been configured" when the session was expired. If CDK can't read login sessions: `eval "$(aws configure export-credentials --profile docs-api --format env)"` and omit --profile.
- zsh expands unquoted `*` in arguments: quote `'--external:@nestjs/websockets/*'`.
- nvm global packages are per Node version: a global `cdk` vanished after switching Node; use `npx cdk` / project devDependency.
- Fetch keep-alive to S3 can give ECONNRESET on reused sockets: retry idempotent PUTs.
- Waiters: maxWaitTime must exceed minDelay (20 s default).
- `Handler: index.handler`: CDK names the bundle index.js.
- Wrong Content-Type is only rejected if signed (see above); test negative cases, don't assume.

### Commands used
`npx aws-cdk init app --language typescript --generate-only`, `npm install -D esbuild`, `npx cdk synth|diff|deploy --profile docs-api`, `npm run build:lambda`, `npx esbuild ... --bundle --platform=node --target=node22 --external:...`, `grep -c design:paramtypes ...`, `node scripts/e2e.mjs <url>`.

### Glossary
Execution environment, cold/warm start, Init/Invoke, concurrency, execution role, HTTP API, payload format v2, proxy route, Firecracker, esbuild, tree-shaking, external module, preCompilation, SigV4, presigned URL, signable headers, multipart upload, SSE-S3, Block Public Access, bucket policy, CORS preflight, dead-letter queue, at-least-once, idempotent, CloudFormation (template/stack/logical ID/change set/rollback), CDK (App/Stack/Construct/L1-L3/token/synth/asset/feature flag), custom resource, removal policy, least privilege, `aws login` session.

### Interview Q&A (model answers)
1. **Why does a Nest app need tsc before esbuild on Lambda?** esbuild transpiles per file and doesn't emit `design:paramtypes`; Nest's DI reads it, so injected params are undefined (crash at bootstrap or on first use). Compile with tsc (metadata), then bundle JS; or use explicit `@Inject`.
2. **Presigned PUT: what stops a user uploading a different content type or a huge file?** Content-Type only if signed (`signableHeaders`; SDK v3 doesn't by default); size not at all with PUT -> use presigned POST with content-length-range, or validate in the S3-event Lambda and delete.
3. **S3 event delivered twice / handler fails?** At-least-once; idempotent conditional update; unknown doc logged not thrown; real errors thrown -> 2 retries -> DLQ.
4. **What happens in CloudFormation if you rename a construct id?** New logical ID -> create new + delete old (replacement); for stateful resources that means data loss; use RemovalPolicy.RETAIN/ deletion protection and review `cdk diff` for [-/+].
5. **Cold start causes and mitigations?** Init = runtime + bundle load + Nest bootstrap; smaller bundles, less top-level work, more memory, provisioned concurrency, lighter framework; measured 1.7 s cold vs ~0.3 s warm.
6. **Why HTTP API with a catch-all route + NestJS?** Cheaper/faster than REST API; Nest routes internally; trade-off: one big function (shared cold start/blast radius) vs function per route.

### Commit message
`feat: add Lambda handlers, S3 presigned uploads, CDK stack and e2e script`

