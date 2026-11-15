// The first source of mentions, found by a script and no model: every web address in a note's show notes. An address in a bookshop's
// or a book site's book pages is a book; any other is a website.

import type { Mention } from "./mention";
import { cutAtWord, titleFromSlug, titleKey } from "./titles";

/** A web address in text: up to a space, a bracket, a quote or an angle. */
const ADDRESS = /https?:\/\/[^\s<>"'`()[\]]+/gi;

/** What a sentence puts after an address and the address does not own. */
const TRAILING = /[.,;:!?*_’”]+$/;

/** Query words that only say where a visitor came from. They are not part of what the page is. */
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|igshid|ref|ref_|tag|linkcode|th|psc)$/i;

/** The most words of a web address's path that name a website. */
const PATH_WORDS = 4;

/** The address as it is kept: no tracking words, no part after `#`. Null for anything that is not a web address. */
export function cleanAddress(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.replace(TRAILING, ""));
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  return url;
}

/** Every web address in the text, once each, in the order they first appear. */
export function addressesIn(text: string): URL[] {
  const found = new Map<string, URL>();
  for (const [raw] of text.matchAll(ADDRESS)) {
    const url = cleanAddress(raw);
    if (url !== null && !found.has(url.href)) found.set(url.href, url);
  }
  return [...found.values()];
}

const bareHost = (url: URL): string => url.hostname.toLowerCase().replace(/^www\./, "");

const isBookshop = (host: string): boolean => /(^|\.)amazon\.[a-z.]{2,}$/.test(host) || host === "amzn.to" || host === "amzn.com" || host === "a.co";
const isBookSite = (host: string): boolean => host === "goodreads.com" || host.endsWith(".goodreads.com");

/** The name of a website as a note's title: its host, and the first words of its path. */
function websiteTitle(url: URL): string {
  const words = url.pathname
    .split("/")
    .filter((step) => step !== "")
    .slice(0, PATH_WORDS)
    .map((step) => {
      try {
        return decodeURIComponent(step);
      } catch {
        return step;
      }
    });
  return [bareHost(url), ...words.map((word) => word.replace(/[-_+]+/g, " "))].join(" ");
}

/** A book page's title and where it is, from the address alone: a title in the address (`/Atomic-Habits-An-Easy/dp/0735211299`, `/book/show/40121378-atomic-habits`). */
function bookFrom(url: URL): { title: string | null; address: string } | null {
  const host = bareHost(url);
  if (isBookshop(host)) {
    const product = /^\/(?:([^/]+)\/)?(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url.pathname);
    if (product === null) return null;
    const slug = product[1];
    return { title: slug === undefined || slug.toLowerCase() === "gp" ? null : titleFromSlug(slug), address: `${url.protocol}//${url.host}/dp/${product[2]}` };
  }
  if (isBookSite(host)) {
    const book = /^\/book\/show\/(\d+)(?:[-.]([^/?#]+))?/.exec(url.pathname);
    if (book === null) return null;
    return { title: book[2] === undefined ? null : titleFromSlug(book[2]), address: `${url.protocol}//${url.host}/book/show/${book[1]}` };
  }
  return null;
}

/** True when `phrase` is in `text` as whole words, ignoring case and punctuation. */
function sayIn(textKey: string, phrase: string): boolean {
  const key = titleKey(phrase);
  return key !== "" && ` ${textKey} `.includes(` ${key} `);
}

/**
 * A title read from an address runs on into the book's subtitle, which a person speaking leaves out. The show notes usually write the
 * title as people say it, so the longest start of the address's title that the show notes also say (two words or more) is the title.
 * The shorter starts of it are kept as other names the book may already have a note under.
 */
function bookTitle(addressTitle: string, showNotes: string): { title: string; alsoKnownAs: string[] } {
  const words = addressTitle.split(" ");
  const starts: string[] = [];
  for (let count = words.length; count >= 2; count--) starts.push(words.slice(0, count).join(" "));
  // The addresses are left out: a title read from one would find itself there.
  const notes = titleKey(showNotes.replace(ADDRESS, " "));
  const said = starts.find((start) => sayIn(notes, start));
  const title = said ?? addressTitle;
  return { title, alsoKnownAs: starts.filter((start) => start !== title) };
}

/** What one address is: a book when a bookshop or book site names one, a website otherwise. Null for an address with nothing to name it by. */
function mentionFrom(url: URL, showNotes: string): Mention | null {
  const book = bookFrom(url);
  if (book !== null && book.title !== null && titleKey(book.title) !== "") {
    const { title, alsoKnownAs } = bookTitle(book.title, showNotes);
    return { type: "book", title, url: book.address, ...(alsoKnownAs.length > 0 ? { alsoKnownAs } : {}) };
  }
  // A book page whose address has no title in it is kept as the website it is: a title taken from nowhere would be a guess.
  const title = cutAtWord(websiteTitle(url), 100);
  if (titleKey(title) === "") return null;
  const clean = new URL(url.href);
  return { type: "website", title, url: clean.href };
}

/** Every address in the show notes, as a mention. `ownPage` is the episode's own page, which the episode does not mention. */
export function mentionsInShowNotes(showNotes: string, ownPage: string | null): Mention[] {
  const own = ownPage === null ? null : cleanAddress(ownPage)?.href ?? null;
  const mentions: Mention[] = [];
  for (const url of addressesIn(showNotes)) {
    if (own !== null && url.href === own) continue;
    const mention = mentionFrom(url, showNotes);
    if (mention !== null) mentions.push(mention);
  }
  return mentions;
}
