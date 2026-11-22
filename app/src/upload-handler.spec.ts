import type { Context, S3Event } from 'aws-lambda';
import { Doc } from './docs/doc.model';
import { createHandler, docIdFromKey } from './upload-handler';

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';

const eventFor = (key: string, eventName = 'ObjectCreated:Put'): S3Event =>
  ({ Records: [{ eventName, s3: { object: { key } } }] }) as unknown as S3Event;

const run = (handler: ReturnType<typeof createHandler>, event: S3Event) =>
  handler(event, {} as Context, () => undefined);

describe('docIdFromKey', () => {
  it('extracts the doc id from uploads/<uuid>', () => {
    expect(docIdFromKey(`uploads/${ID}`)).toBe(ID);
  });

  it('decodes URL-encoded keys (S3 events encode them)', () => {
    expect(docIdFromKey(`uploads%2F${ID}`)).toBe(ID);
  });

  it.each(['other/x', 'uploads/not-a-uuid', `uploads/${ID}/extra`, ''])(
    'returns undefined for %p',
    (key) => expect(docIdFromKey(key)).toBeUndefined(),
  );
});

describe('upload handler', () => {
  const doc = { id: ID, status: 'UPLOADED' } as Doc;
  let markUploaded: jest.Mock;
  let handler: ReturnType<typeof createHandler>;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined); // keep test output quiet
    markUploaded = jest.fn().mockResolvedValue(doc);
    handler = createHandler({ markUploaded });
  });

  afterEach(() => jest.restoreAllMocks());

  it('marks the doc UPLOADED', async () => {
    await run(handler, eventFor(`uploads/${ID}`));
    expect(markUploaded).toHaveBeenCalledWith(ID);
  });

  it('is safe when the same event is delivered twice', async () => {
    await run(handler, eventFor(`uploads/${ID}`));
    await run(handler, eventFor(`uploads/${ID}`));
    expect(markUploaded).toHaveBeenCalledTimes(2); // repo update is idempotent; no error either time
  });

  it('ignores keys that are not ours and non-create events', async () => {
    await run(handler, eventFor('somewhere/else'));
    await run(handler, eventFor(`uploads/${ID}`, 'ObjectRemoved:Delete'));
    expect(markUploaded).not.toHaveBeenCalled();
  });

  it('does not throw for an unknown doc (retrying cannot help)', async () => {
    markUploaded.mockResolvedValue(undefined);
    await expect(run(handler, eventFor(`uploads/${ID}`))).resolves.toBeUndefined();
  });

  it('rethrows unexpected errors so Lambda retries the event', async () => {
    markUploaded.mockRejectedValue(new Error('DynamoDB throttled'));
    await expect(run(handler, eventFor(`uploads/${ID}`))).rejects.toThrow('DynamoDB throttled');
  });
});
