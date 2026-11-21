import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DYNAMO_DOC_CLIENT } from '../dynamo/dynamo-client.provider';
import { Doc } from './doc.model';
import { DocAlreadyExistsError, InvalidCursorError } from './docs.errors';
import { DocsPage, DocsRepository } from './docs.repository';

// What is physically stored: the Doc plus the four key attributes.
type DocItem = Doc & { PK: string; SK: string; GSI1PK: string; GSI1SK: string };
type Key = Pick<DocItem, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK'>;

const GSI1 = 'GSI1';
const docKey = (id: string) => ({ PK: `DOC#${id}`, SK: 'METADATA' });

const isConditionFailure = (e: unknown) =>
  e instanceof Error && e.name === 'ConditionalCheckFailedException';

@Injectable()
export class DynamoDocsRepository extends DocsRepository {
  private readonly table: string;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly client: DynamoDBDocumentClient,
    config: ConfigService,
  ) {
    super();
    this.table = config.getOrThrow<string>('TABLE_NAME');
  }

  // A1: create. The condition makes this an "insert, never overwrite".
  async create(doc: Doc): Promise<Doc> {
    const item: DocItem = {
      ...docKey(doc.id),
      GSI1PK: `USER#${doc.userId}`,
      GSI1SK: `DOC#${doc.createdAt}`,
      ...doc,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (e) {
      if (isConditionFailure(e)) throw new DocAlreadyExistsError(doc.id);
      throw e;
    }
    return doc;
  }

  // A2: get by id. GetItem by full primary key = cheapest, fastest read.
  async getById(id: string): Promise<Doc | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: docKey(id),
        ConsistentRead: true, // read-your-own-write right after create; costs 1 RCU instead of 0.5 for a <=4KB item
      }),
    );
    return result.Item ? this.toDoc(result.Item as DocItem) : undefined;
  }

  // A3: list a user's docs newest-first, paginated, via GSI1.
  async listByUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<DocsPage> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: GSI1,
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `USER#${userId}` },
        ScanIndexForward: false, // descending by GSI1SK = newest first
        Limit: limit + 1, // read ONE extra item to learn whether another page exists
        ExclusiveStartKey: cursor ? this.decodeCursor(cursor, userId) : undefined,
      }),
    );

    const rows = (result.Items ?? []) as DocItem[];
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return {
      items: page.map((row) => this.toDoc(row)),
      nextCursor: hasMore ? this.encodeCursor(page[page.length - 1]) : undefined,
    };
  }

  // A4: mark uploaded. Returns undefined if the doc does not exist.
  async markUploaded(id: string): Promise<Doc | undefined> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: docKey(id),
          // "status" is a DynamoDB reserved word, so it must be aliased as #status.
          UpdateExpression: 'SET #status = :uploaded, updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK)', // never create a ghost item
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':uploaded': 'UPLOADED',
            ':now': new Date().toISOString(),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return this.toDoc(result.Attributes as DocItem);
    } catch (e) {
      if (isConditionFailure(e)) return undefined;
      throw e;
    }
  }

  // Allow-list mapping: key attributes (PK, SK, GSI1*) never leak into the API.
  private toDoc(item: Doc): Doc {
    return {
      id: item.id,
      userId: item.userId,
      title: item.title,
      description: item.description,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  // The cursor is LastEvaluatedKey, base64url-encoded so clients treat it as opaque.
  private encodeCursor(item: DocItem): string {
    const key: Key = {
      PK: item.PK,
      SK: item.SK,
      GSI1PK: item.GSI1PK,
      GSI1SK: item.GSI1SK,
    };
    return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
  }

  // Cursors are untrusted input: validate shape AND that they belong to this user.
  private decodeCursor(cursor: string, userId: string): Key {
    try {
      const key = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as Partial<Key>;
      const ok =
        typeof key.PK === 'string' &&
        typeof key.SK === 'string' &&
        typeof key.GSI1PK === 'string' &&
        typeof key.GSI1SK === 'string' &&
        key.GSI1PK === `USER#${userId}`;
      if (!ok) throw new InvalidCursorError();
      return key as Key;
    } catch {
      throw new InvalidCursorError();
    }
  }
}
