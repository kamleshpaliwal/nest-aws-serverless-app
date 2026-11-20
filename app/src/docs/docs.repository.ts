import { Doc } from './doc.model';

export interface DocsPage {
  items: Doc[];
  nextCursor?: string; // opaque to the client; absent when there are no more pages
}

/**
 * The contract the service depends on. It is an abstract CLASS (not an
 * interface) because interfaces vanish at compile time, and Nest's DI needs
 * something that exists at runtime to use as an injection token.
 */
export abstract class DocsRepository {
  /** Insert a new doc. Must reject if a doc with this id already exists. */
  abstract create(doc: Doc): Promise<Doc>;

  abstract getById(id: string): Promise<Doc | undefined>;

  abstract listByUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<DocsPage>;

  /** Set status to UPLOADED. Idempotent: safe to call twice. */
  abstract markUploaded(id: string): Promise<Doc | undefined>;
}
