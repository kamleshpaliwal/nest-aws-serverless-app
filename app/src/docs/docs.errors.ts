/** Thrown by a repository when create() finds an existing item with the same id. */
export class DocAlreadyExistsError extends Error {
  constructor(readonly id: string) {
    super(`Doc ${id} already exists`);
    this.name = 'DocAlreadyExistsError';
  }
}

/** Thrown when a pagination cursor cannot be decoded (client sent garbage). */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}
