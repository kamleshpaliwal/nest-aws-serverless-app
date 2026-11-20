import { Injectable } from '@nestjs/common';
import { Doc } from './doc.model';
import { DocAlreadyExistsError, InvalidCursorError } from './docs.errors';
import { DocsPage, DocsRepository } from './docs.repository';

/**
 * Temporary repository backed by a Map, so we can run and curl the API before
 * DynamoDB exists. Replaced by a DynamoDB implementation in Phase 3.
 * Data is lost on restart (and on every Lambda cold start), by design.
 */
@Injectable()
export class InMemoryDocsRepository extends DocsRepository {
  private readonly docs = new Map<string, Doc>();

  async create(doc: Doc): Promise<Doc> {
    if (this.docs.has(doc.id)) throw new DocAlreadyExistsError(doc.id);
    this.docs.set(doc.id, doc);
    return doc;
  }

  async getById(id: string): Promise<Doc | undefined> {
    return this.docs.get(id);
  }

  async listByUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<DocsPage> {
    // Sort key mimics GSI1SK: createdAt, with id as a tie-breaker. Newest first.
    const sortKey = (d: Doc) => `${d.createdAt}#${d.id}`;
    const after = cursor ? this.decodeCursor(cursor) : undefined;

    const matches = [...this.docs.values()]
      .filter((d) => d.userId === userId)
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
      .filter((d) => (after === undefined ? true : sortKey(d) < after));

    const items = matches.slice(0, limit);
    const hasMore = matches.length > limit;
    return {
      items,
      nextCursor: hasMore
        ? this.encodeCursor(sortKey(items[items.length - 1]))
        : undefined,
    };
  }

  async markUploaded(id: string): Promise<Doc | undefined> {
    const doc = this.docs.get(id);
    if (!doc) return undefined;
    if (doc.status === 'UPLOADED') return doc; // idempotent: second call is a no-op
    const updated: Doc = {
      ...doc,
      status: 'UPLOADED',
      updatedAt: new Date().toISOString(),
    };
    this.docs.set(id, updated);
    return updated;
  }

  private encodeCursor(key: string): string {
    return Buffer.from(key, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): string {
    const key = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!key.includes('#')) throw new InvalidCursorError();
    return key;
  }
}
