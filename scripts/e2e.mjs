#!/usr/bin/env node
// End-to-end test against a DEPLOYED stack. Usage:
//   node scripts/e2e.mjs https://<id>.execute-api.<region>.amazonaws.com
// Needs Node 18+ (built-in fetch). Creates a few docs for a throwaway user.

const base = (process.argv[2] ?? process.env.API_URL ?? '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/e2e.mjs <api-url>');
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
  if (!ok) failures++;
};

async function call(method, path, body) {
  const started = Date.now();
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, ms: Date.now() - started };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// S3 may close a keep-alive connection after a response; reusing it gives ECONNRESET.
// A PUT of the same bytes to the same key is idempotent, so retrying is safe.
async function putWithRetry(url, headers, body, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, { method: 'PUT', headers, body });
    } catch (err) {
      if (i >= attempts) throw err;
      await sleep(300 * i);
    }
  }
}
const user = `e2e-${Date.now()}`;

// 1. health (also shows cold-start latency)
const health = await call('GET', '/health');
check(`GET /health -> 200 (${health.ms} ms)`, health.status === 200 && health.json?.status === 'ok', health.text);

// 2. validation: bad body is rejected before touching the service
const bad = await call('POST', '/docs', { userId: user, title: '', status: 'UPLOADED' });
check('POST /docs invalid body -> 400', bad.status === 400, `${bad.status} ${bad.text}`);

// 3. create
const created = await call('POST', '/docs', { userId: user, title: '  e2e doc  ' });
const doc = created.json;
check('POST /docs -> 201 PENDING, title trimmed', created.status === 201 && doc?.status === 'PENDING' && doc?.title === 'e2e doc', created.text);

// 4. get (and check key attributes do not leak)
const got = await call('GET', `/docs/${doc.id}`);
check('GET /docs/:id -> 200, same doc', got.status === 200 && got.json?.id === doc.id, got.text);
check('GET /docs/:id does not leak PK/SK', !('PK' in (got.json ?? {})) && !('GSI1PK' in (got.json ?? {})), got.text);
check('GET /docs/<unknown uuid> -> 404', (await call('GET', '/docs/3b241101-e2bb-4255-8caf-4136c566a962')).status === 404);
check('GET /docs/not-a-uuid -> 400', (await call('GET', '/docs/not-a-uuid')).status === 400);

// 5. presigned URL
const badType = await call('POST', `/docs/${doc.id}/upload-url`, { contentType: 'text/html' });
check('upload-url with disallowed content type -> 400', badType.status === 400, badType.text);

const up = await call('POST', `/docs/${doc.id}/upload-url`, { contentType: 'text/plain' });
check('POST /docs/:id/upload-url -> 200 with url', up.status === 200 && up.json?.url?.includes('X-Amz-Signature'), up.text);

// 6. upload the file straight to S3 (it never passes through Lambda)
const wrongType = await putWithRetry(up.json.url, { 'content-type': 'image/png' }, 'hello');
check('PUT with WRONG Content-Type -> 403 (signature mismatch)', wrongType.status === 403, String(wrongType.status));

const put = await putWithRetry(up.json.url, { 'content-type': 'text/plain' }, 'hello from e2e');
check('PUT to presigned URL -> 200', put.status === 200, `${put.status} ${await put.text()}`);

// 7. S3 event -> Lambda #2 -> status UPLOADED (asynchronous: poll)
let status = 'PENDING';
for (let i = 0; i < 15 && status !== 'UPLOADED'; i++) {
  await sleep(1000);
  status = (await call('GET', `/docs/${doc.id}`)).json?.status;
}
check('status becomes UPLOADED via the S3 event (<=15 s)', status === 'UPLOADED', `still ${status}`);

// 8. pagination: 2 more docs, then walk the list 2 at a time
await call('POST', '/docs', { userId: user, title: 'second' });
await call('POST', '/docs', { userId: user, title: 'third' });
const seen = [];
let cursor;
for (let page = 0; page < 5; page++) {
  const q = `/users/${user}/docs?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const res = await call('GET', q);
  seen.push(...(res.json?.items ?? []).map((d) => d.title));
  cursor = res.json?.nextCursor;
  if (!cursor) break;
}
check('list paginates newest-first: [third, second, e2e doc]', JSON.stringify(seen) === JSON.stringify(['third', 'second', 'e2e doc']), JSON.stringify(seen));
check('garbage cursor -> 400', (await call('GET', `/users/${user}/docs?cursor=garbage`)).status === 400);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
