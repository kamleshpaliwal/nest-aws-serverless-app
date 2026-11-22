# STAR stories from the Docs API project

How to use this file: read a story, say it out loud in about two minutes, then cover the **Follow-ups** and answer them from memory.

**Be upfront about the context.** These come from a **personal project** I built to learn AWS serverless end to end (NestJS on Lambda, DynamoDB, S3, CDK, GitHub Actions with OIDC). Do not present it as an employer's production system. Opening line that works: *"On a personal project where I built a serverless API from an empty AWS account to automated deployment, ..."*

**Facts to quote (all real):** HTTP API → Lambda (NestJS, Node 24) → DynamoDB single table; S3 presigned uploads and an S3-event Lambda with a dead-letter queue; 17 unit tests, 9 integration tests against DynamoDB Local, a 14-check end-to-end script; two CDK stacks; deploys take about 80 seconds; the API bundle is about 5.6 MB; cold start about 1.7 s vs about 0.3 s warm.

| # | Story | Good for questions like |
|---|---|---|
| 1 | A runtime upgrade broke production | "Tell me about an outage or incident you handled" |
| 2 | The CI role that would not authenticate | "Tell me about a hard debugging problem" |
| 3 | The security gap my own test found | "Tell me about a time you caught a risk early" |
| 4 | Designing for duplicate events and failure | "Tell me about a design decision and its trade-offs" |
| 5 | "Works on my machine" three times | "Tell me about improving reliability or process" |
| + | Two short bonus stories | Cost-aware decisions, preventing data loss |

---

## Story 1: A runtime upgrade broke production

**Situation.** My CI pipeline had just started deploying automatically on every merge to `main`. In the same change I moved the Lambda runtime from Node 22 to Node 24 so that local, CI and production all used the same version.

**Task.** The deploy finished "successfully", but the post-deploy end-to-end test went red: almost every request returned a bare `{"message":"Internal Server Error"}`. I needed to find the cause and restore service.

**Action.**
- I noticed the body was API Gateway's generic error, not my NestJS error format (which includes `statusCode` and a path), so the application code was never reached. The failure was at the Lambda runtime level.
- A CloudWatch alarm on API Gateway 5xx had already emailed me (state `OK -> ALARM`, about 5 minutes after the failures began).
- I read the function's logs and found `Runtime.CallbackHandlerDeprecated`: the Node 24 runtime refuses handlers that declare a third `callback` parameter, and mine did.
- I changed both handlers to `async (event, context)`, added a unit test asserting `handler.length <= 2` as a regression guard, and shipped the fix through the same pipeline (branch, PR, `cdk diff`, merge, deploy, e2e).

**Result.** Service was restored by the next deploy and the end-to-end test went green (all 14 checks). The failure was caught within about a minute by the smoke test and within about five minutes by the alarm; nothing about it was visible to unit tests, because the code never ran.

**What I learned / would change.** Runtime upgrades change contracts, so test on the real runtime. In a real system I would not deploy to all traffic at once: I would use a staging stack or a canary with automatic rollback on the alarm, and I would shorten the alarm period to one minute and add a recovery notification.

**Follow-ups**
- *Why did Lambda's own `Errors` metric not catch this kind of problem for normal failures?* It only counts unhandled failures. My exception filter turns application errors into HTTP 500 responses from a successful invocation, so I alarm on API Gateway 5xx.
- *What is a canary deployment?* Shift a small share of traffic to the new version (Lambda alias + CodeDeploy), watch alarms, and roll back automatically if they fire.
- *Roll back or fix forward?* Roll back first when users are affected, then diagnose. Here nobody was using it, so I fixed forward.

---

## Story 2: The CI role that would not authenticate

**Situation.** I set up GitHub Actions to deploy to AWS using OIDC, so no AWS keys are stored anywhere. The first pull request run failed at the credentials step with `Not authorized to perform sts:AssumeRoleWithWebIdentity`.

**Task.** Find out why AWS rejected a token from my own repository, even though the IAM trust policy looked correct when I read it.

**Action.**
- I read the deployed trust policy from the synthesized CloudFormation template: provider, audience `sts.amazonaws.com` and subject `repo:<owner>/<repo>:pull_request` all looked right. Re-running the job could not help, since the input was unchanged.
- STS deliberately does not say which condition failed, so I needed the other side of the comparison: the token's real claims. I added a temporary step using `actions/github-script` that requests an ID token and prints only the decoded payload (never the raw token).
- The `sub` claim was `repo:<owner>@<owner-id>/<repo>@<repo-id>:pull_request`: GitHub now embeds immutable numeric IDs. My policy assumed the older name-only format.
- I updated the CDK trust policy for both roles (pull-request and `main`), redeployed the CI stack, re-ran the job, then removed the debug step.

**Result.** The role was assumed on the next run, and the pipeline has been keyless since. The numeric IDs are actually better: they prevent "repo-jacking", where someone re-registers a renamed or deleted repository name and matches a name-only trust policy.

**What I learned.** When a system hides detail on purpose, make the other side observable instead of guessing; and the trust policy's `sub` condition is the real security boundary, because GitHub's signing keys are shared by every repository.

**Follow-ups**
- *How does AWS trust the token?* GitHub signs each run's JWT with its private key; STS verifies the signature using the public keys published at the issuer's JWKS URL, then checks the role's conditions (`aud`, `sub`). Registering the provider only records issuer and audience, no keys.
- *Why two roles?* Pull requests get a read-only role that can only run `cdk diff`; only the `main` branch can deploy. A PR can never deploy.
- *What if you omitted the `sub` condition?* Any GitHub repository's token would be accepted.

---

## Story 3: The security gap my own test found

**Situation.** The API hands out presigned S3 upload URLs. I had told the S3 SDK the file's `Content-Type` and assumed the URL therefore only accepted that type.

**Task.** Verify that assumption end to end instead of trusting it, because a URL for `text/plain` that also accepts HTML is a stored-XSS risk.

**Action.**
- My end-to-end script includes a negative test: upload with the wrong `Content-Type` and expect `403`.
- It got `200`. The AWS SDK v3 presigner does not sign `Content-Type` unless asked, so S3 had nothing to compare.
- I confirmed in the installed package that `getSignedUrl` accepts `signableHeaders`, set `new Set(['content-type'])`, redeployed, and the same test returned `403 SignatureDoesNotMatch`. I also allow-listed content types in the request DTO.

**Result.** The guarantee "this URL only accepts this type" became real and is now enforced by a test that runs after every deploy.

**What I learned.** Test the negative path of every security property, and verify library behavior in the installed version instead of from memory (I had stated the wrong behavior with confidence before the test proved otherwise). A presigned PUT also cannot limit file size: for that I would use a presigned POST with `content-length-range` or validate in the S3-event handler.

**Follow-ups**
- *Why does the URL carry permissions?* It's a SigV4 signature made with the signer's credentials; anyone holding it can perform that one operation until it expires, so keep expiry short (5 minutes) and scope the signer's role (`PutObject` on `uploads/*` only).
- *How long is the URL really valid?* The shorter of `expiresIn` and the signing credentials' remaining lifetime (Lambda role credentials are temporary).
- *Large files?* Multipart upload with a presigned URL per part.

---

## Story 4: Designing for duplicate events and failure

**Situation.** Uploads go straight from the client to S3, and an S3 event invokes a second Lambda that marks the document `UPLOADED`. S3 event delivery is at-least-once, and Lambda retries failed asynchronous invocations.

**Task.** Make that status update correct even when events are duplicated, retried or arrive out of order, and make sure permanently failing events are never silently lost.

**Action.**
- Modeled DynamoDB from access patterns first (get by id, list by user newest-first, mark uploaded, create), giving `PK=DOC#<id>`, `SK=METADATA` and a GSI on `USER#<id>` with `DOC#<createdAt>`.
- Made every write conditional: create uses `attribute_not_exists(PK)` (never overwrite), the status update uses `attribute_exists(PK)` (never create a ghost record) and setting the same status twice is harmless.
- The handler's error policy is deliberate: an unknown document is logged and not thrown (a retry cannot fix it); anything unexpected is thrown so Lambda retries twice and then sends the event to a dead-letter queue, which has its own CloudWatch alarm.
- The upload key is derived server-side (`uploads/<docId>`), so nothing the client sends can point an upload at another document.
- Integration tests run against DynamoDB Local and cover duplicate create, idempotent update, missing documents and the pagination cursor.

**Result.** Duplicates and retries are safe by construction; failures surface through the DLQ alarm instead of disappearing; and the whole path is checked by a post-deploy end-to-end test that waits for the asynchronous status change.

**Trade-offs I accepted.** A single table is efficient but rigid: new access patterns can mean re-modeling. A GSI is eventually consistent and doubles write cost. The cursor is an encoded DynamoDB key, so I validate it as untrusted input (shape and ownership), and I read one extra item (`Limit + 1`) to avoid returning a cursor to an empty page.

**Follow-ups**
- *What if one user's data grows huge?* A hot partition on `GSI1PK`; mitigate by write-sharding the key and merging reads.
- *Why not offset pagination?* DynamoDB has no OFFSET; skipping still reads and bills the skipped items. Keyset (cursor) pagination only.
- *Capacity math?* One strongly consistent read of up to 4 KB = 1 RCU (half for eventual); a 1 KB write = 1 WCU; round up.

---

## Story 5: "Works on my machine", three times

**Situation.** Three separate problems all shared one cause: my laptop and the clean CI environment differed, and I only learned it when CI ran.

**Task.** Make builds reproducible, so that a green local run means a green pipeline.

**Action.**
- **Wrong folder install:** an `npm install` ran in the repository root, so dependencies were missing from the real `package.json`. Node's module resolution walks up folders, so everything still worked locally. A confusing "Missing script" error and a `../node_modules` path in a stack trace gave it away; I reinstalled in the right folder.
- **Node version drift:** my laptop ran Node 24 while the pipeline used 22, and Jest failed to load NestJS's ESM-only packages. I pinned one version everywhere: `.nvmrc`, an `engines` field, `setup-node` and the Lambda runtime.
- **Undeclared tool:** CDK bundles with esbuild from the `app/` folder, but I had declared esbuild only under `infra/`. A fresh checkout failed with `npx --no-install esbuild`; I declared it where it runs.
- Pipeline design that surfaces these early: `npm ci` (lockfile-exact), lint, unit tests and `cdk diff` on every pull request.

**Result.** The pipeline now reproduces my environment: tests, bundling, diff and deploy run from a clean checkout, and each of those failures became a permanent guard (version pins, declared dependencies, a regression test).

**What I learned.** Declare every tool where it runs, pin the runtime in dev, CI and production, and treat "it only fails in CI" as information about a hidden assumption.

**Follow-ups**
- *`npm ci` vs `npm install`?* `ci` installs exactly from the lockfile, never modifies it and fails if it disagrees with `package.json`.
- *Why bundle Lambda code?* One tree-shaken file starts faster than a large `node_modules`. esbuild does not emit decorator metadata, so NestJS needs `tsc` first (I compile with `tsc`, then bundle the JavaScript).

---

## Bonus 1: A cost-aware decision (short)

**Situation/Action.** Setting up secure access, the textbook answer is IAM Identity Center. Enabling it displayed a warning: creating the required AWS Organization would upgrade my free-plan account to pay-as-you-go and expire my free credits immediately. I stopped, used an IAM user with MFA and short-lived `aws login` sessions instead, and set a budget alert.

**Result and lesson.** I kept the credits and still avoided long-lived access keys. Real organizations should use Identity Center; the point is to read the warning, weigh the trade-off and be able to state both options.

## Bonus 2: Preventing data loss from a "harmless" rename (short)

**Situation/Action.** To learn how CloudFormation identity works, I renamed the DynamoDB table's construct ID in a throwaway change and ran only `cdk diff`. It showed the old table destroyed and a new empty one created (CDK derives the logical ID from the construct path), plus changes to the Lambdas' environment variables and IAM policies.

**Result and lesson.** On a real table that is silent data loss. Defenses: `RemovalPolicy.RETAIN` and deletion protection, point-in-time recovery, separating stateful resources into their own stack, pinning logical IDs, and reading every line of `cdk diff` in the pull request (my pipeline posts it on every PR).

---

## Quick reference: numbers and phrases

- 5xx alarm fired about 5 minutes after failures began; the post-deploy smoke test caught it in about a minute.
- Detection could be faster: a 1-minute period with a 2-of-3 evaluation rule; add a recovery notification.
- Alarms: API Gateway 5xx, S3-handler errors, DLQ depth.
- Presigned URL expiry: 5 minutes; API role can only `PutObject` under `uploads/`.
- OIDC: roles trusted by repository IDs and branch; pull requests get read-only, `main` can deploy.
- If asked about metrics you do not have (traffic, users): say so. It is a learning project; talk about the design, failures and trade-offs instead.
