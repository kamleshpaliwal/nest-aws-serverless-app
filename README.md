# Docs API

A serverless document API: users create document records and upload files for them. Built end to end on AWS, from an empty account to automated, keyless deployment.

**NestJS (TypeScript) on Lambda · API Gateway HTTP API · DynamoDB (single table) · S3 presigned uploads · S3-event Lambda · AWS CDK · GitHub Actions with OIDC · CloudWatch alarms**

> The full build story, with **what, why and how** for every stage and the incidents we hit along the way, is in [`docs/PROJECT_GUIDE.md`](docs/PROJECT_GUIDE.md).

## Architecture

```
 Client ──HTTPS──► API Gateway (HTTP API)
                        │ sync
                        ▼
                  Lambda "ApiFunction" (NestJS)
                    │              │
        Get/Put/Query│              │ presign (local SigV4 signing)
                    ▼              ▼
              DynamoDB        presigned PUT URL ──► Client ──PUT file──► S3 (private bucket)
                    ▲                                                       │ ObjectCreated
                    │ UpdateItem status=UPLOADED                            ▼ async, at-least-once
                    └─────────────────────────────── Lambda "UploadedFunction" ──failed──► SQS DLQ

 CloudWatch (logs, metrics, alarms) ──► SNS ──► email

 git push ─► GitHub Actions ─(OIDC token)─► AWS STS ─► temporary credentials ─► cdk deploy
```

Files never pass through Lambda: the API hands out a short-lived presigned URL, the client uploads straight to S3, and an S3 event marks the document `UPLOADED`.

## API

| Method and path | Purpose |
|---|---|
| `GET /health` | Liveness check |
| `POST /docs` | Create a doc (status `PENDING`); validated body |
| `GET /docs/:id` | Fetch a doc |
| `GET /users/:userId/docs?limit=&cursor=` | Newest-first list with cursor pagination (DynamoDB GSI) |
| `POST /docs/:id/upload-url` | Presigned S3 PUT URL (content type is signed and allow-listed) |

## Design highlights

- **Single-table DynamoDB** designed from access patterns: `PK=DOC#<id>`, `SK=METADATA`, `GSI1PK=USER#<id>`, `GSI1SK=DOC#<createdAt>`. Conditional writes (`attribute_not_exists`) prevent overwrites; pagination uses `Limit + 1` and a validated, opaque cursor.
- **Idempotent, event-driven upload completion:** S3 delivers events at least once, so the handler is a conditional update with a dead-letter queue behind it.
- **Least-privilege IAM through CDK grants:** the API role can only `GetItem/PutItem/Query` and `PutObject` under `uploads/`; the S3 handler can only `UpdateItem`.
- **Keyless CI/CD:** GitHub Actions assumes AWS roles with OIDC. Pull requests get a read-only role (`cdk diff`); only the `main` branch can deploy, then a post-deploy end-to-end test runs.
- **Alarms on what users experience:** API Gateway 5xx (Lambda's own `Errors` metric misses handled HTTP 500s), async handler errors and dead-letter-queue depth.

## Repository layout

```
app/                  NestJS application (src/, unit + integration tests, tsconfig.lambda.json)
infra/                AWS CDK: DocsApiStack (the system) and CiBootstrapStack (GitHub OIDC provider + roles)
scripts/e2e.mjs       14-check end-to-end test against a deployed stack
.github/workflows/    pr.yml (checks + cdk diff) and deploy.yml (deploy + e2e on main)
docs/PROJECT_GUIDE.md Complete 0-to-100 guide
```

## Run it locally

Prerequisites: **Node 24** (`nvm use`, see `.nvmrc`) and Docker.

```bash
docker run -d --name dynamodb-local -p 8000:8000 amazon/dynamodb-local
cd app && npm ci
npm test                 # unit tests (no Docker needed)
npm run test:int         # integration tests against DynamoDB Local
```

For the dev server, copy `app/.env.example` to `app/.env`, create the table (see the guide, section 5) and run `npm run start:dev`.

## Deploy to your own AWS account

Prerequisites: an AWS account, AWS CLI v2 with a profile (`aws login --profile docs-api`), Node 24.

1. In `infra/bin/infra.ts`, set your **account id and region** in `env`.
2. One-time per account and region: `cd infra && npm ci && npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION> --profile docs-api`
3. Install the app dependencies: `cd ../app && npm ci`
4. Deploy: `cd ../infra && npx cdk deploy DocsApiStack --profile docs-api -c alertEmail=<YOUR_EMAIL>`
5. Verify: `node ../scripts/e2e.mjs <ApiUrl from the stack outputs>`

Always pass `-c alertEmail=...` to `cdk diff` and `cdk deploy`; without it the SNS subscription is removed.

**CI/CD setup (once):** deploy `CiBootstrapStack` by hand, put your repo's OIDC subject in its trust policies (it contains immutable numeric ids; the guide shows how to read it), set the role ARNs in the workflow files, and add a repository variable `ALERT_EMAIL`.

## Cost and teardown

Idle cost is about zero: everything is pay-per-use, with no NAT gateway, load balancer or provisioned capacity. Add authentication before sharing the API URL publicly (see the security section of the guide).

```bash
cd infra && npx cdk destroy DocsApiStack --profile docs-api -c alertEmail=<YOUR_EMAIL>
```
