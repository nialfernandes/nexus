import { describe, expect, it } from "vitest";
import { addressesIn, cleanAddress, mentionsInShowNotes } from "../src/show-notes";

describe("the web addresses in show notes", () => {
  it("are found once each, in order, without the punctuation of the sentence they are in", () => {
    const text = "See https://a.example/one, and (https://b.example/two). Again https://a.example/one! Mail mailto:x@y.z or ftp://c.example/f.";
    expect(addressesIn(text).map((url) => url.href)).toEqual(["https://a.example/one", "https://b.example/two"]);
  });

  it("are found inside markdown links and angle brackets", () => {
    expect(addressesIn("[the book](https://a.example/b) and <https://c.example/d>").map((url) => url.href)).toEqual(["https://a.example/b", "https://c.example/d"]);
  });

  it("lose the words that only say where a visitor came from, and the part after #", () => {
    expect(cleanAddress("https://a.example/p?utm_source=x&id=7&fbclid=z#top")?.href).toBe("https://a.example/p?id=7");
    expect(cleanAddress("not an address")).toBeNull();
    expect(cleanAddress("ftp://a.example/")).toBeNull();
  });
});

describe("what each address is", () => {
  const AMAZON = "https://www.amazon.com/Atomic-Habits-Proven-Build-Break/dp/0735211299?tag=x&ref_=y";

  it("is a book for a bookshop's book page, titled as the show notes say it, with the address of the page without its tracking", () => {
    const [book, ...more] = mentionsInShowNotes(`Atomic Habits by James Clear\n${AMAZON}`, null);
    expect(more).toEqual([]);
    expect(book).toMatchObject({ type: "book", title: "Atomic Habits", url: "https://www.amazon.com/dp/0735211299" });
    // The longer starts of the address's title are names the same book may already have a note under.
    expect(book!.alsoKnownAs).toEqual(["Atomic Habits Proven Build Break", "Atomic Habits Proven Build", "Atomic Habits Proven"]);
  });

  it("is a book titled by the address when the show notes do not say it", () => {
    const [book] = mentionsInShowNotes(`A good read.\n${AMAZON}`, null);
    expect(book).toMatchObject({ type: "book", title: "Atomic Habits Proven Build Break" });
    expect(book!.alsoKnownAs).toContain("Atomic Habits");
  });

  it("does not take a title from the address's own words as if the show notes said them", () => {
    // The address is in the show notes: its words are not the show notes' words.
    const [book] = mentionsInShowNotes(AMAZON, null);
    expect(book!.title).toBe("Atomic Habits Proven Build Break");
  });

  it("is a book for a book site's book page, in either form of its address", () => {
    expect(mentionsInShowNotes("https://www.goodreads.com/book/show/40121378-atomic-habits", null)).toEqual([
      { type: "book", title: "Atomic Habits", url: "https://www.goodreads.com/book/show/40121378" },
    ]);
    expect(mentionsInShowNotes("https://www.goodreads.com/book/show/4991.Fahrenheit_451", null)).toEqual([
      { type: "book", title: "Fahrenheit 451", url: "https://www.goodreads.com/book/show/4991" },
    ]);
  });

  it("is a book for a bookshop of another country", () => {
    expect(mentionsInShowNotes("https://www.amazon.co.uk/Deep-Work/dp/B01AKGUOFE/ref=sr_1_1", null)[0]).toMatchObject({ type: "book", title: "Deep Work", url: "https://www.amazon.co.uk/dp/B01AKGUOFE" });
  });

  it("is a website when a book page's address has no title in it, because a title taken from nowhere would be a guess", () => {
    expect(mentionsInShowNotes("https://www.amazon.com/dp/0735211299", null)).toEqual([{ type: "website", title: "amazon.com dp 0735211299", url: "https://www.amazon.com/dp/0735211299" }]);
    expect(mentionsInShowNotes("https://amzn.to/3xYzAbc", null)).toEqual([{ type: "website", title: "amzn.to 3xYzAbc", url: "https://amzn.to/3xYzAbc" }]);
  });

  it("is a website for any other page, named by its host and the first words of its path", () => {
    expect(mentionsInShowNotes("https://jamesclear.com/atomic-habits?utm_source=x#top", null)).toEqual([
      { type: "website", title: "jamesclear.com atomic habits", url: "https://jamesclear.com/atomic-habits" },
    ]);
    expect(mentionsInShowNotes("https://www.my-site.example/", null)).toEqual([{ type: "website", title: "my-site.example", url: "https://www.my-site.example/" }]);
  });

  it("is a website for a bookshop or book site page that is not a book's", () => {
    expect(mentionsInShowNotes("https://www.goodreads.com/author/show/7569.James_Clear", null)[0]).toMatchObject({ type: "website", title: "goodreads.com author show 7569.James Clear" });
    expect(mentionsInShowNotes("https://www.amazon.com/gp/help/customer/display.html", null)[0]).toMatchObject({ type: "website" });
  });

  it("is nothing for the episode's own page", () => {
    expect(mentionsInShowNotes("https://shows.example.org/habits and https://b.example/", "https://shows.example.org/habits?utm_source=x")).toEqual([
      { type: "website", title: "b.example", url: "https://b.example/" },
    ]);
  });
});
