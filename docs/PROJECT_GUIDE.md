# Docs API: from zero to production, end to end

A serverless document API built step by step on a brand-new AWS account, with every stage documented as **What** (the goal), **Why** (the problem and the alternatives) and **How** (the commands and code).

**Stack:** NestJS (TypeScript) on AWS Lambda behind API Gateway HTTP API, DynamoDB (single table), S3 presigned uploads, an S3-event Lambda, AWS CDK, GitHub Actions with OIDC, CloudWatch alarms.

**Placeholders used below:** `<ACCOUNT_ID>` (12-digit AWS account), `<API_URL>` (stack output), `<GH_USER>` (GitHub user), `<YOUR_EMAIL>` (alert address). Region used throughout: `ap-south-1`.

---

## Contents
0. [The system and the decisions behind it](#0-the-system-and-the-decisions-behind-it)
1. [AWS account, identity and cost safety](#1-aws-account-identity-and-cost-safety)
2. [Local machine and tooling](#2-local-machine-and-tooling)
3. [GitHub repository](#3-github-repository)
4. [The NestJS application](#4-the-nestjs-application)
5. [DynamoDB: modeling and repository](#5-dynamodb-modeling-and-repository)
6. [Running NestJS on Lambda](#6-running-nestjs-on-lambda)
7. [S3 uploads and the event-driven status update](#7-s3-uploads-and-the-event-driven-status-update)
8. [Infrastructure as code with CDK](#8-infrastructure-as-code-with-cdk)
9. [First deployment and end-to-end testing](#9-first-deployment-and-end-to-end-testing)
10. [Observability and alarms](#10-observability-and-alarms)
11. [CI/CD with GitHub Actions and OIDC](#11-cicd-with-github-actions-and-oidc)
12. [Incidents we hit (and what they taught)](#12-incidents-we-hit-and-what-they-taught)
13. [Security review and production gaps](#13-security-review-and-production-gaps)
14. [Break-it labs](#14-break-it-labs)
15. [Operating the project: commands, cost, teardown](#15-operating-the-project-commands-cost-teardown)

---

## 0. The system and the decisions behind it

### Architecture
```
 Client ──HTTPS──► API Gateway (HTTP API, ANY /{proxy+})
                        │ sync invoke (payload v2)
                        ▼
                  Lambda "ApiFunction"  (NestJS, Node 24)
                    │             │
        Get/Put/Query│             │ getSignedUrl() (local signing, no S3 call)
                    ▼             ▼
              DynamoDB          returns presigned PUT URL
         (PK/SK + GSI1)               │
                    ▲                 ▼
                    │        Client ──PUT file bytes──► S3 bucket (private)
                    │                                       │ ObjectCreated (prefix uploads/)
                    │ UpdateItem status=UPLOADED            ▼ async, at-least-once
                    └──────────────────────── Lambda "UploadedFunction" ──failed──► SQS DLQ

 CloudWatch Logs/Metrics ──► Alarms ──► SNS ──► email

 git push ─► GitHub Actions ─(OIDC JWT)─► AWS STS ─► temporary creds ─► cdk deploy ─► CloudFormation
```

### API
| Method and path | Purpose |
|---|---|
| `GET /health` | Liveness (does not touch the database) |
| `POST /docs` | Create a doc (status `PENDING`), validated DTO |
| `GET /docs/:id` | Fetch one doc |
| `GET /users/:userId/docs?limit=&cursor=` | Paginated list, newest first (via GSI1) |
| `POST /docs/:id/upload-url` | Returns a presigned S3 PUT URL |

### Key decisions and trade-offs
| Decision | Why | Trade-off |
|---|---|---|
| Serverless (Lambda) | Scales to zero, no servers, pay per use | Cold starts, stateless, 15-min and 6 MB limits |
| HTTP API (not REST API) | About 3.5x cheaper, lower latency, JWT authorizers | No usage plans, request validation, WAF directly |
| One Lambda + NestJS catch-all route | One codebase, familiar structure, easy testing | Bigger bundle, shared cold start and blast radius |
| DynamoDB single table | One-query access patterns, no connection limits | Access patterns must be known up front; harder to read |
| Files go straight to S3 (presigned PUT) | No Lambda payload limit or compute cost per byte | Completion is asynchronous (S3 event) |
| Plain (non-Nest) handler for S3 events | Faster cold start, smaller surface | Two handler styles to maintain |
| CDK (TypeScript) | Real language, least-privilege `grant*` helpers | AWS-only, CloudFormation limits apply |
| OIDC instead of stored AWS keys | No long-lived secret; scoped by repo and branch | One-time setup of provider and roles |
| IAM user instead of IAM Identity Center | Identity Center needed AWS Organizations, which converts a free-plan account to paid and expires credits | Less ideal than SSO for real companies |

---

## 1. AWS account, identity and cost safety

**What:** a secured account with a daily-use identity and an early-warning budget.

**Why:** the root user has unlimited power and cannot be restricted by IAM; AWS bills after the fact, so a mistake shows up late.

**How:**
1. Sign in as root and **enable MFA** (Security credentials, Assign MFA device).
2. **IAM Identity Center was deliberately not used**: enabling it creates an AWS Organization, which upgrades a free-plan account to pay-as-you-go and expires the free credits (a warning box says so). Instead create an **IAM user with AdministratorAccess and MFA** (IAM, Users, Create user).
3. As root, enable **IAM user and role access to Billing information** (Account page) so the IAM user can open Billing.
4. Create a **monthly cost budget** (template, e.g. USD 5) with an email alert. Budgets alert; they do not stop spending.
5. Pick one region (`ap-south-1`) and use it everywhere: resources are regional, and the wrong console region makes resources look missing.

---

## 2. Local machine and tooling

**What:** Node, Git, Docker, AWS CLI and CDK, plus authenticated CLI access.

**Why:** local runtime must match CI and Lambda; credentials should be temporary.

**How:**
- **nvm** manages Node versions per project. The project finally standardized on **Node 24** (`.nvmrc` contains `24`; `engines: >=24.9`), because Jest needs Node 24.9+ to load NestJS 12's ESM-only packages, and Lambda offers `nodejs24.x`.
- **AWS CLI v2** with `aws login --profile docs-api`: a browser sign-in (OAuth 2.0 authorization code with PKCE) that stores **temporary** credentials. Sessions expire; repeat the command when you see "Your session has expired".
- Verify identity (needs no permissions): `aws sts get-caller-identity --profile docs-api`.
- The **credential provider chain** (flags, env vars, profile, container/instance role) decides which credentials every AWS tool uses.
- **CDK bootstrap** (once per account and region): `npx cdk bootstrap aws://<ACCOUNT_ID>/ap-south-1 --profile docs-api`. It creates the `CDKToolkit` stack: an assets S3 bucket (where Lambda bundles are uploaded), an ECR repo, and the IAM roles CDK assumes during deploys.
- Docker Desktop runs **DynamoDB Local** for tests.
- Per-version global npm packages are a trap under nvm: prefer `npx cdk` using the version pinned in `infra/package.json`.

---

## 3. GitHub repository

**What:** a private repo with SSH access and a sensible `.gitignore`.

**Why:** deployment is driven from git; SSH avoids passwords; ignored files keep secrets and build output out of history.

**How:**
- `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github` (private key stays local, public key is added in GitHub Settings, SSH keys). Add a `Host github.com` block with `IdentityFile` and `IdentitiesOnly yes` to `~/.ssh/config`. Test: `ssh -T git@github.com`.
- `.gitignore` excludes `node_modules/`, `dist/`, `cdk.out/`, `app/build/`, `.env*`, `*.tsbuildinfo`, `.DS_Store`, but **not** `cdk.context.json`.
- Work through branches and pull requests (the CI pipeline depends on this).

Repo layout: `/app` (NestJS), `/infra` (CDK), `/scripts` (e2e), `/.github/workflows`, `/docs`.

---

## 4. The NestJS application

**What:** the HTTP application with layered structure, validation, error handling, config, logging and tests.

**Why:** structure, dependency injection and testability for a team; validated input at the edge.

**How:**
- Scaffold: `npx @nestjs/cli new app --directory app --package-manager npm --skip-git` (CommonJS and Jest). Decline optional third-party add-ons.
- **Dependency injection:** `emitDecoratorMetadata` makes the compiler emit `design:paramtypes`; Nest reads it to know that `DocsService` needs a `DocsRepository`. The injection token is an **abstract class** because interfaces are erased at runtime.
- **Layers:** controller (HTTP only) → service (business rules, e.g. new docs start `PENDING`) → repository (all persistence).
- **Validation:** DTOs with `class-validator`/`class-transformer`; global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `transform`. Registered through `APP_PIPE` in `AppModule`, **not** `main.ts`, because the Lambda handler never runs `main.ts`.
- **Errors:** one `AllExceptionsFilter` maps domain errors (`DocAlreadyExistsError` → 409, `InvalidCursorError` → 400) and hides internals on 5xx.
- **Config:** `@nestjs/config` with a `validateEnv` function (fail fast at startup). Required: `TABLE_NAME`, `BUCKET_NAME`; optional: `DYNAMODB_ENDPOINT` (local only).
- **Logging:** `ConsoleLogger({ json: true })` so CloudWatch Logs Insights can query fields.
- **Tests:** unit tests mock the repository (`useValue` provider); `npm test`. Request lifecycle to remember: middleware → guards → interceptors → pipes → handler → interceptors → exception filters.

---

## 5. DynamoDB: modeling and repository

**What:** a single-table design derived from access patterns, plus a tested repository.

**Why:** DynamoDB only answers questions its keys were built for, so access patterns come first.

**How:**
| Pattern | Operation |
|---|---|
| Create a doc | `PutItem` with `attribute_not_exists(PK)` (never overwrite) |
| Get by id | `GetItem` (`ConsistentRead`) on `PK=DOC#<id>`, `SK=METADATA` |
| List a user's docs, newest first | `Query` on **GSI1** (`GSI1PK=USER#<id>`, `GSI1SK=DOC#<createdAt>`), `ScanIndexForward=false` |
| Mark uploaded | `UpdateItem` with `attribute_exists(PK)` |

- **Pagination:** `Limit + 1` to learn whether another page exists (DynamoDB returns a `LastEvaluatedKey` even when nothing remains), cursor = base64url of the last key, **validated as untrusted input** (shape and must belong to the same user).
- `status` is a DynamoDB **reserved word**: alias it (`#status`). `UpdateItem` is an upsert: always add a condition. The SDK rejects `undefined` unless `removeUndefinedValues: true`.
- Capacity math: 1 RCU = one strongly consistent read of up to 4 KB per second (0.5 eventual); 1 WCU = 1 KB write per second; round up.
- **Local development:** `docker run -d --name dynamodb-local -p 8000:8000 amazon/dynamodb-local`. Use fake credentials (`local`/`local`) so a mistake can never touch real AWS.
- **Integration tests** (`npm run test:int`, files `*.int-spec.ts`) create their own throwaway table and prove conditions, ordering, the 3-page cursor walk, foreign-user cursor rejection and idempotent updates.
- IDs are server-generated `crypto.randomUUID()` (unguessable, evenly hashed, not time-sortable).

---

## 6. Running NestJS on Lambda

**What:** a handler that boots Nest once per execution environment and adapts API Gateway events to Express.

**Why:** Lambda reuses environments, so initialization cost should be paid once (cold start), not per request.

**How:**
- `app/src/lambda.ts`: cache the bootstrap **promise** at module level (overlapping calls share one boot; a failed boot is cleared so the next call retries), use `app.init()` (no `listen`), and wrap with `@codegenie/serverless-express`.
- **Handler signature must be `async (event, context)`.** The Node 24 runtime rejects handlers declaring a third `callback` parameter (`Runtime.CallbackHandlerDeprecated`).
- **Bundling gotcha:** esbuild does not emit decorator metadata, so DI silently breaks (Nest warns "has no decorator metadata... esbuild don't emit it", then crashes). Solution used: `npm run build:lambda` (`tsc -p tsconfig.lambda.json` into `app/build/lambda`), then CDK bundles that plain JavaScript with esbuild. Optional Nest packages (`@nestjs/microservices`, `@nestjs/websockets`) are marked external.
- `esbuild` must be a devDependency **of `app/`** (CDK runs `npx --no-install esbuild` with `app/` as the working directory).
- Lambda facts: one request per environment at a time; Init vs Invoke; memory sets CPU; timeout max 15 min; sync payload 6 MB; role-provided credentials (no keys in code).

---

## 7. S3 uploads and the event-driven status update

**What:** direct-to-S3 uploads using presigned PUT URLs, then an asynchronous handler that flips the doc to `UPLOADED`.

**Why:** large files should not pass through Lambda (payload limit and compute cost); S3 scales for ingest.

**How:**
- `POST /docs/:id/upload-url` verifies the doc exists, then `getSignedUrl(PutObjectCommand{ Bucket, Key: "uploads/<docId>", ContentType })`. Signing is local SigV4 math; the URL carries the **signer's** permissions, so the API role needs `s3:PutObject` (scoped to `uploads/*`).
- **Content-Type is not signed by default in SDK v3**: without `signableHeaders: new Set(['content-type'])` an upload of the wrong type succeeded (found by the e2e test). With it, a mismatching type returns `403 SignatureDoesNotMatch`.
- Presigned PUT cannot cap size: use presigned POST with `content-length-range`, or validate in the event handler. Multipart for big files.
- **S3 event:** `ObjectCreated` with prefix `uploads/` invokes `UploadedFunction` asynchronously (**at-least-once**, possible duplicates and reordering; 2 automatic retries then the DLQ). The handler is idempotent (conditional update), ignores non-matching keys, decodes the URL-encoded key, **does not throw** for an unknown doc (a retry cannot help) and **throws** on unexpected errors (so Lambda retries).
- Bucket: Block Public Access, SSE-S3 encryption, TLS enforced by policy, CORS for browser PUT, lifecycle rule aborting incomplete multipart uploads.

---

## 8. Infrastructure as code with CDK

**What:** the whole stack defined in TypeScript (`infra/`), synthesized to CloudFormation.

**Why:** repeatable, reviewable, destroyable infrastructure; CDK generates IAM policies from `grant*` calls.

**How:**
- Scaffold: `npx aws-cdk init app --language typescript --generate-only`, then `npm install`. Run CDK with `npx cdk` from `infra/`. `cdk.json`'s `app` command first runs `npm --prefix ../app run build:lambda`.
- **Concepts:** App → Stack → Construct; L1/L2/L3; tokens (deploy-time values); synth (writes `cdk.out/`); assets uploaded to the bootstrap bucket; **logical ID = construct path + hash**.
- **`DocsApiStack`:** `TableV2` (+ GSI1, on-demand), private `Bucket`, two `NodejsFunction`s (API: 512 MB, 10 s; Uploaded: 256 MB with DLQ), `HttpApi` with a `/{proxy+}` catch-all, S3 event notification (prefix `uploads/`), 7-day log retention, alarms, outputs.
- **Least-privilege grants:** API = `GetItem`, `PutItem`, `Query` and `PutObject` on `uploads/*`; Uploaded = `UpdateItem` only.
- CDK adds helper resources for you (auto-delete custom resource, S3 notification custom resource, DLQ).
- `cdk diff` marks: `[+]` add, `[~]` modify, `[-]` delete, `[-/+]` replace. Rolling back is automatic on failure.
- Stateful resources use `RemovalPolicy.DESTROY` **for the lab only**; production should use `RETAIN`, deletion protection and PITR.

---

## 9. First deployment and end-to-end testing

**What:** the first real deploy and a rerunnable end-to-end script.

**Why:** unit tests cannot see IAM, signing, the S3 event or the real Lambda runtime.

**How:**
```
cd infra
npx cdk diff   DocsApiStack --profile docs-api -c alertEmail=<YOUR_EMAIL>
npx cdk deploy DocsApiStack --profile docs-api -c alertEmail=<YOUR_EMAIL>
node ../scripts/e2e.mjs <API_URL>
```
- **Always pass `-c alertEmail=...` locally**: without it, the plan removes the SNS subscription (the pipeline passes it from the `ALERT_EMAIL` repo variable).
- `scripts/e2e.mjs` runs 14 assertions: health, validation 400, create, get, 404/400 paths, presign, **wrong Content-Type is rejected (403)**, upload, **status becomes UPLOADED via the S3 event**, three-doc pagination, bad cursor. Exit code 0 only if all pass.
- Console tour: CloudFormation (Resources, Events), Lambda (config, role, logs), IAM roles, API Gateway routes, DynamoDB items, S3 objects and notifications.
- Measured: cold start about 1.7 s, warm about 0.3 s.

---

## 10. Observability and alarms

**What:** logs, metrics and three alarms notifying by email.

**Why:** you cannot operate what you cannot see.

**How:**
- Logs Insights examples: cold starts (`filter @type="REPORT" | stats count(), sum(ispresent(@initDuration))`), errors (`filter level="error"`), slowest requests.
- Metrics: Lambda (Invocations, Errors, Duration, Throttles, ConcurrentExecutions), API Gateway (Count, 4xx, 5xx, Latency), DynamoDB (consumed capacity, ThrottledRequests).
- Alarms: **API Gateway 5xx** (user-visible; Lambda's `Errors` metric misses HTTP 500s that Nest handles), **UploadedFunction errors**, **DLQ not empty**. SNS topic with email subscription (must be confirmed by clicking the link). `treatMissingData: NOT_BREACHING`.
- Proven in practice: the alarm emailed `OK -> ALARM` about 5 minutes after the Node 24 incident. Known improvements: 1-minute period, `addOkAction` for recovery mail.

---

## 11. CI/CD with GitHub Actions and OIDC

**What:** pull requests run checks and `cdk diff`; merging to `main` deploys and smoke-tests, with no AWS keys stored anywhere.

**Why:** long-lived keys leak; OIDC issues short-lived credentials per run, scoped to a repo and branch.

**How:**
- **OIDC flow:** GitHub mints a short-lived JWT per run (claims `iss`, `aud`, `sub`, `repository`, `ref`, `exp`), signed with GitHub's long-lived private key (published public keys at `https://token.actions.githubusercontent.com/.well-known/jwks`). The workflow calls STS `AssumeRoleWithWebIdentity`; STS verifies the signature via the issuer's JWKS, then checks the role's **trust policy** conditions on `aud` and `sub`, and returns about 1 hour of credentials. Registering the provider in AWS only records issuer URL and audience (no keys). The keys are shared by all of GitHub, so **the `sub` condition is the security boundary**.
- **`CiBootstrapStack`** (deployed once by hand with admin credentials): `OidcProviderNative` plus `GithubPlanRole` (trusted for `pull_request`, may only assume CDK's `lookup` role) and `GithubDeployRole` (trusted for the `main` branch, may assume CDK's deploy, file-publishing, image-publishing and lookup roles).
- **Gotcha:** for newer repositories the `sub` embeds **immutable numeric ids**: `repo:<owner>@<ownerId>/<repo>@<repoId>:pull_request`. A name-only trust policy fails with "Not authorized to perform sts:AssumeRoleWithWebIdentity". Print the token claims in a temporary `actions/github-script` step (`core.getIDToken`) and copy the real `sub`. Ids also prevent repo-jacking.
- **`.github/workflows/pr.yml`** (on `pull_request`): checkout, setup-node 24 (npm cache), `npm ci` in `app` and `infra`, lint, unit tests, `build:lambda`, assume the plan role, `cdk diff`.
- **`.github/workflows/deploy.yml`** (on push to `main`, serialized, never cancelled): the same checks, assume the deploy role, `cdk deploy DocsApiStack --require-approval never --outputs-file`, then run `scripts/e2e.mjs` against the output `ApiUrl`.
- `permissions: id-token: write` is mandatory for OIDC. Using a GitHub Environment changes `sub` to `environment:<name>`.
- Setup you must do once: repo variable `ALERT_EMAIL` (not masked in logs; use a secret if that matters).
- Extensions: dev/prod with Environments and required reviewers, one role and stack per environment, SHA-pinned actions, Lambda versions/aliases with CodeDeploy canary and alarm rollback.

---

## 12. Incidents we hit (and what they taught)

| # | Symptom | Root cause | Fix | Lesson |
|---|---|---|---|---|
| 1 | `npm run` said "Missing script"; an unexplained `../node_modules` in a stack trace | `npm install` ran in the repo root, so dependencies were missing from `app/package.json` | Delete the root install, reinstall in `app/` | Check `pwd`; CI (`npm ci`) would have exposed it |
| 2 | esbuild bundle: Nest "has no decorator metadata", crash at boot | esbuild does not emit `design:paramtypes` | tsc first, then bundle JS; externals for optional packages | Know what your bundler drops |
| 3 | e2e: wrong Content-Type returned 200 | SDK v3 does not sign `Content-Type` by default | `signableHeaders: new Set(['content-type'])` | Test negative paths |
| 4 | CI: Jest "Must use import to load ES Module" | CI ran Node 22, laptop Node 24 | Node 24 in `.nvmrc`, workflows and Lambda | Pin one runtime everywhere |
| 5 | CI: "Not authorized to perform sts:AssumeRoleWithWebIdentity" | OIDC `sub` includes numeric ids | Printed real claims, updated the trust policy | STS hides detail; look at the token |
| 6 | CI: `npx --no-install esbuild` failed | esbuild declared in `infra/`, but CDK bundles from `app/` | Declare it in `app/` | Declare tools where they run |
| 7 | Prod: every request `{"message":"Internal Server Error"}`; 5xx alarm emailed | Node 24 runtime rejects callback-style handlers | `async (event, context)` + regression test | Runtime upgrades change contracts; smoke-test post-deploy; consider canaries |
| 8 | `cdk diff` wanted to delete the SNS subscription | Ran without `-c alertEmail` | Always pass the context | Read every diff line; keep local and CI config aligned |

---

## 13. Security review and production gaps

- **IAM:** both Lambda roles are tight. Weak spots: CDK's CloudFormation execution role is `AdministratorAccess` by default (narrow it), and the human admin should be SSO-based in real organizations.
- **The API is currently public.** First steps to secure it: (1) JWT authorizer (Cognito) on the HTTP API, (2) take `userId` from the **verified token**, never from the URL (BOLA/IDOR), (3) throttling and WAF (via CloudFront), then tighten CORS and enable PITR.
- **Secrets:** none in the app today. Use SSM Parameter Store (free, config and simple secrets) or Secrets Manager (rotation, about USD 0.40 per secret per month); fetch at init and cache.
- **Uploads:** size limits (presigned POST), content-type allow-list (done), malware scanning, quarantine.
- **Add for production:** custom domain and ACM, WAF, PITR and `RETAIN`/deletion protection, multi-account (Organizations, Identity Center, SCPs), CloudTrail, GuardDuty, cost anomaly detection, X-Ray tracing, correlation ids, DLQ redrive process.

---

## 14. Break-it labs

| Lab | Result |
|---|---|
| Rename the table construct id (`cdk diff` only) | Shows `[-] DocsTable ... destroy` and `[+] DocsTableRenamed ...`, plus changed env vars, IAM policies and outputs: CloudFormation sees a different resource, so the data would be lost. Defenses: `RETAIN`, deletion protection, backups, stateful/stateless stack split, pinned logical ids, reviewing `diff` |
| Wrong Content-Type on upload | `403 SignatureDoesNotMatch` (after signing the header) |
| Duplicate create | `ConditionalCheckFailedException` mapped to 409 (integration-tested) |
| Break the OIDC trust policy | Happened for real (incident 5) |
| Failing deploy | Happened for real (incident 7: a deploy that succeeded but served 500s) |
| Drift | Console edits are invisible to `cdk diff` (it compares templates) and found by CloudFormation drift detection; a deploy with no template change does not revert them |

---

## 15. Operating the project: commands, cost, teardown

**Daily commands**
```
aws login --profile docs-api                         # refresh the short-lived session
cd app && npm run lint && npm test                   # fast checks (17 tests)
cd app && npm run test:int                           # needs the dynamodb-local container
cd infra && npx cdk diff|deploy DocsApiStack --profile docs-api -c alertEmail=<YOUR_EMAIL>
node scripts/e2e.mjs <API_URL>                       # end-to-end check against a deployed stack
```

**Cost:** idle cost is about zero (Lambda, API Gateway, DynamoDB on-demand, S3, SQS, SNS, CloudWatch within free usage; no NAT gateway, load balancer or provisioned capacity). A budget alert guards the account. Remember: the API URL is public, so abusive traffic is the main cost risk until authentication is added.

**Teardown**
```
cd infra
npx cdk destroy DocsApiStack  --profile docs-api -c alertEmail=<YOUR_EMAIL>
npx cdk destroy CiBootstrapStack --profile docs-api      # optional: OIDC provider and roles
```
Then check for leftovers: CloudWatch log groups, the `CDKToolkit` stack and its assets bucket (keep or delete), and verify Billing is about USD 0.
