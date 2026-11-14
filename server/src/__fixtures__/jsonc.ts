// Reads a wrangler.jsonc as committed. Nexus's configs carry only
// whole-line `//` comments and block comments, never a comment after a value
// on the same line, so stripping those two shapes leaves plain JSON. A line
// comment trailing a value would survive this and fail JSON.parse loudly,
// which is the failure we want rather than a silently misread config.
export function parseJsonc<T = unknown>(text: string): T {
  const json = text
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(json) as T;
}
