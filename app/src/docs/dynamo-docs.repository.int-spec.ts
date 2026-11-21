/**
 * INTEGRATION test: real DynamoDocsRepository against real (local) DynamoDB.
 * Needs the DynamoDB Local container running on :8000. Run with `npm run test:int`.
 * Uses its own throwaway table so it never touches your dev data.
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Doc } from './doc.model';
import { DocAlreadyExistsError, InvalidCursorError } from './docs.errors';
import { DynamoDocsRepository } from './dynamo-docs.repository';

jest.setTimeout(30_000);

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const tableName = `DocsTable-int-${Date.now()}`;

const rawClient = new DynamoDBClient({
  endpoint,
  region: 'ap-south-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

let repo: DynamoDocsRepository;

const makeDoc = (userId: string, createdAt: string, title = 't'): Doc => ({
  id: randomUUID(),
  userId,
  title,
  status: 'PENDING',
  createdAt,
  updatedAt: createdAt,
});

beforeAll(async () => {
  // Same key schema as the real table (and as the CDK table in Phase 6).
  await rawClient.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  await waitUntilTableExists(
    // The waiter's default minDelay is 20s and maxWaitTime must exceed it,
    // so poll quickly: Local is ACTIVE almost immediately.
    { client: rawClient, maxWaitTime: 20, minDelay: 1, maxDelay: 2 },
    { TableName: tableName },
  );

  // Hand-build the repository; only getOrThrow is used from ConfigService.
  const config = { getOrThrow: () => tableName } as unknown as ConfigService;
  repo = new DynamoDocsRepository(docClient, config);
});

afterAll(async () => {
  await rawClient.send(new DeleteTableCommand({ TableName: tableName }));
  rawClient.destroy();
});

describe('DynamoDocsRepository (DynamoDB Local)', () => {
  describe('create / getById', () => {
    it('round-trips a doc and does not leak key attributes', async () => {
      const doc = makeDoc('rt-user', '2026-01-01T00:00:00.000Z');
      await repo.create(doc);

      const found = await repo.getById(doc.id);

      expect(found).toEqual(doc); // toEqual: no PK/SK/GSI1* extras allowed
    });

    it('rejects a duplicate id instead of overwriting (attribute_not_exists)', async () => {
      const doc = makeDoc('dup-user', '2026-01-01T00:00:00.000Z', 'original');
      await repo.create(doc);

      await expect(
        repo.create({ ...doc, title: 'overwrite attempt' }),
      ).rejects.toBeInstanceOf(DocAlreadyExistsError);

      expect((await repo.getById(doc.id))?.title).toBe('original');
    });

    it('returns undefined for a missing id', async () => {
      await expect(repo.getById(randomUUID())).resolves.toBeUndefined();
    });
  });

  describe('listByUser', () => {
    const user = 'page-user';
    const ids: string[] = []; // oldest -> newest

    beforeAll(async () => {
      for (let i = 1; i <= 5; i++) {
        const doc = makeDoc(user, `2026-02-0${i}T00:00:00.000Z`, `doc ${i}`);
        ids.push(doc.id);
        await repo.create(doc);
      }
      // Another user's doc must never appear in page-user's list.
      await repo.create(makeDoc('other-user', '2026-02-09T00:00:00.000Z'));
    });

    it('pages newest-first with an opaque cursor and no empty trailing page', async () => {
      const p1 = await repo.listByUser(user, 2);
      expect(p1.items.map((d) => d.id)).toEqual([ids[4], ids[3]]);
      expect(p1.nextCursor).toBeDefined();

      const p2 = await repo.listByUser(user, 2, p1.nextCursor);
      expect(p2.items.map((d) => d.id)).toEqual([ids[2], ids[1]]);
      expect(p2.nextCursor).toBeDefined();

      const p3 = await repo.listByUser(user, 2, p2.nextCursor);
      expect(p3.items.map((d) => d.id)).toEqual([ids[0]]);
      expect(p3.nextCursor).toBeUndefined();
    });

    it('has no nextCursor when the last page is exactly full (the limit+1 trick)', async () => {
      const all = await repo.listByUser(user, 5);
      expect(all.items).toHaveLength(5);
      expect(all.nextCursor).toBeUndefined();
    });

    it('rejects garbage cursors', async () => {
      await expect(
        repo.listByUser(user, 2, 'not-base64-json'),
      ).rejects.toBeInstanceOf(InvalidCursorError);
    });

    it("rejects a cursor taken from another user's list", async () => {
      const p1 = await repo.listByUser(user, 2);
      await expect(
        repo.listByUser('other-user', 2, p1.nextCursor),
      ).rejects.toBeInstanceOf(InvalidCursorError);
    });
  });

  describe('markUploaded', () => {
    it('sets UPLOADED and is safe to repeat', async () => {
      const doc = makeDoc('up-user', '2026-03-01T00:00:00.000Z');
      await repo.create(doc);

      const first = await repo.markUploaded(doc.id);
      const second = await repo.markUploaded(doc.id);

      expect(first?.status).toBe('UPLOADED');
      expect(second?.status).toBe('UPLOADED');
      expect((await repo.getById(doc.id))?.status).toBe('UPLOADED');
    });

    it('returns undefined and creates nothing for a missing doc', async () => {
      const missing = randomUUID();

      await expect(repo.markUploaded(missing)).resolves.toBeUndefined();
      await expect(repo.getById(missing)).resolves.toBeUndefined(); // no ghost item
    });
  });
});
