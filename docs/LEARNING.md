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
