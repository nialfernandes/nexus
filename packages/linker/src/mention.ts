// What a mention is: one thing a note talks about, as the show notes' links and the model both give it.

export const MENTION_TYPES = ["book", "website", "quote", "person"] as const;

export type MentionType = (typeof MENTION_TYPES)[number];

export interface Mention {
  type: MentionType;
  /** The book's, website's or person's name, or the words of the quote. */
  title: string;
  /** Who wrote the book or said the quote. */
  author?: string;
  /** Where the thing is on the web. */
  url?: string;
  /**
   * Other titles the thing may already have a note under. A book named by a shop's web address has a title with its subtitle run
   * on (`Atomic-Habits-An-Easy-Proven-Way`): its first words, found as a note of their own, are the same book.
   */
  alsoKnownAs?: string[];
}
