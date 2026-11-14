// A refusal: a plain sentence and the HTTP status that goes with it. The store and the readers throw one, and the
// route table turns it into `{ error }`.

export class Refusal extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 410 | 413 | 429 | 503, message: string) {
    super(message);
  }
}
