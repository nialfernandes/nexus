// A refusal: a plain sentence and the HTTP status that goes with it. The store and the readers throw one, and the
// route table turns it into `{ error }`. `details` are extra JSON fields that go beside `error` (a refused save says
// which version the note is at). They hold numbers and names Nexus chose, never anything a caller sent.

export class Refusal extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 410 | 413 | 429 | 503,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}
