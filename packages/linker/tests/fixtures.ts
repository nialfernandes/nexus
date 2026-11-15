// A transcript note as the writer of transcript notes makes it: front matter, then `## Description`, `## Links` (one address a line)
// and `## Transcript`, each paragraph of which starts with the time it begins. The writer lives in another repository and cannot be
// imported here, so this builds the same shape; the job reads only the parts named above.

export interface Episode {
  title: string;
  source?: string;
  /** The page of the episode itself, which the episode does not mention. */
  link?: string;
  description?: string;
  links?: string[];
  /** The paragraphs of speech, in order. */
  spoken: string[];
}

export function transcriptNote(episode: Episode): string {
  const front = ["---", "kind: podcast", `source: ${JSON.stringify(episode.source ?? "A Show")}`, `title: ${JSON.stringify(episode.title)}`, "published: 2026-11-10"];
  if (episode.link !== undefined) front.push(`link: ${JSON.stringify(episode.link)}`);
  front.push("tags:", "  - transcript", "---");
  const sections = [front.join("\n")];
  if (episode.description !== undefined) sections.push(`## Description\n\n${episode.description}`);
  if (episode.links !== undefined && episode.links.length > 0) sections.push(`## Links\n\n${episode.links.map((link) => `- ${link}`).join("\n")}`);
  const paragraphs = episode.spoken.map((text, at) => `[${Math.floor((at * 40) / 60)}:${String((at * 40) % 60).padStart(2, "0")}] ${text}`);
  sections.push(`## Transcript\n\n${paragraphs.join("\n\n")}`);
  return `${sections.join("\n\n")}\n`;
}

/** The note's path in the folder of transcript notes. */
export const hushPath = (name: string): string => `Hush/2026_11_10 - A Show - ${name}.md`;
