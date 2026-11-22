import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ConfigService } from '@nestjs/config';
import type { S3Event, S3Handler } from 'aws-lambda';
import { DocsRepository } from './docs/docs.repository';
import { DynamoDocsRepository } from './docs/dynamo-docs.repository';

// Keys are minted by UploadsService as "uploads/<docId>"; anything else is not ours.
const KEY_PATTERN = /^uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** S3 event keys are URL-encoded and use "+" for spaces. */
export function docIdFromKey(rawKey: string): string | undefined {
  const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  return KEY_PATTERN.exec(key)?.[1];
}

const log = (level: string, message: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, message, ...extra }));

export function createHandler(repo: Pick<DocsRepository, 'markUploaded'>): S3Handler {
  return async (event: S3Event) => {
    for (const record of event.Records) {
      if (!record.eventName.startsWith('ObjectCreated:')) continue;

      const docId = docIdFromKey(record.s3.object.key);
      if (!docId) {
        log('warn', 'Ignoring object with unexpected key', { key: record.s3.object.key });
        continue;
      }

      // Unexpected errors propagate -> Lambda retries the event (async: 2 retries, then DLQ).
      const doc = await repo.markUploaded(docId);

      if (!doc) {
        // Doc does not exist: retrying can never fix this, so don't throw.
        log('warn', 'Upload for unknown doc', { docId });
        continue;
      }
      log('info', 'Doc marked UPLOADED', { docId, status: doc.status });
    }
  };
}

/** INIT-phase wiring: built once per execution environment, reused while warm. */
function buildRepository(): DocsRepository {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  // The repository only calls getOrThrow(); a tiny env-backed stand-in avoids booting Nest.
  const env = {
    getOrThrow: (name: string) => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} is required`);
      return value;
    },
  };
  return new DynamoDocsRepository(client, env as unknown as ConfigService);
}

let cached: S3Handler | undefined;

/**
 * Configured in CDK as "upload-handler.handler".
 * Exactly (event, context): a 3rd `callback` parameter makes the Node.js 24 runtime reject it.
 */
export const handler: S3Handler = async (event, context) => {
  cached ??= createHandler(buildRepository());
  await cached(event, context, () => undefined);
};
