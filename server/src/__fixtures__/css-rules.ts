// A CSS parser small enough to trust, for the tests next door.
//
// Why parse rather than grep. A `*/` inside a comment body reads correctly in the source text, so every
// text-matching assertion passes, while the browser closes the comment early, fuses the leftover prose onto the
// following selector, and throws the whole rule away. Nothing that compares source text can see that. Only something
// that strips comments the way a parser does, then reads the rules that survive, can: assert on what the machine
// executes.
//
// It has no dependency, so the test suite needs no CSS toolchain to run.
//
// It handles what the stylesheets in public/ contain and nothing more: comments, quoted
// strings, parenthesised values, at-rules with and without blocks, and nested
// blocks. It is not a CSS engine and should never grow into one.

export interface CssRule {
  /** The prelude as written, whitespace collapsed. May carry several
   *  comma-separated selectors. */
  selector: string
  /** Property -> value, last declaration winning, as the cascade does. */
  declarations: Map<string, string>
}

/** Drop comment bodies the way a parser does: the FIRST `*​/` closes, whatever
 *  the author meant. This is the whole point of the file. */
export function stripComments(css: string): string {
  let out = ''
  let i = 0
  let quote = ''
  while (i < css.length) {
    const c = css[i]
    if (quote) {
      out += c
      if (c === '\\') { out += css[i + 1] ?? ''; i += 2; continue }
      if (c === quote) quote = ''
      i += 1
      continue
    }
    if (c === '"' || c === "'") { quote = c; out += c; i += 1; continue }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      // An unterminated comment swallows the rest of the stylesheet, which is
      // also what a browser does.
      if (end === -1) return out
      // Replaced by a space, not by nothing, so `a/* x */b` cannot fuse.
      out += ' '
      i = end + 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>()
  let depth = 0
  let quote = ''
  let current = ''
  const flush = () => {
    const decl = current.trim()
    current = ''
    if (!decl) return
    const colon = decl.indexOf(':')
    if (colon === -1) return
    map.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim())
  }
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (quote) {
      current += c
      if (c === '\\') { current += body[i + 1] ?? ''; i += 1; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") { quote = c; current += c; continue }
    if (c === '(') depth += 1
    if (c === ')') depth -= 1
    // A semicolon inside `clamp(18px, 3.5vw, 22px)` is not a separator; a
    // semicolon inside a nested block belongs to that block, which the caller
    // has already handed us without.
    if (c === ';' && depth === 0) { flush(); continue }
    current += c
  }
  flush()
  return map
}

/** Every style rule in the sheet, at any nesting depth, in source order.
 *  At-rule preludes (`@media …`, `@font-face`) are not rules and are not
 *  returned; their contents are. */
export function parseRules(css: string): CssRule[] {
  const source = stripComments(css)
  const rules: CssRule[] = []

  const walk = (text: string): void => {
    let prelude = ''
    let quote = ''
    let i = 0
    while (i < text.length) {
      const c = text[i]
      if (quote) {
        prelude += c
        if (c === '\\') { prelude += text[i + 1] ?? ''; i += 2; continue }
        if (c === quote) quote = ''
        i += 1
        continue
      }
      if (c === '"' || c === "'") { quote = c; prelude += c; i += 1; continue }
      if (c === ';') { prelude = ''; i += 1; continue }   // at-rule with no block
      if (c === '}') { prelude = ''; i += 1; continue }   // stray close
      if (c === '{') {
        let depth = 1
        let j = i + 1
        let inner = ''
        let q = ''
        while (j < text.length && depth > 0) {
          const d = text[j]
          if (q) {
            if (d === '\\') { inner += d + (text[j + 1] ?? ''); j += 2; continue }
            if (d === q) q = ''
          } else if (d === '"' || d === "'") {
            q = d
          } else if (d === '{') {
            depth += 1
          } else if (d === '}') {
            depth -= 1
            if (depth === 0) break
          }
          inner += d
          j += 1
        }
        const selector = prelude.trim().replace(/\s+/g, ' ')
        if (selector.startsWith('@')) {
          // Conditional group rules hold rules; @font-face and friends hold
          // declarations and are not style rules, so neither branch records
          // the at-rule itself.
          if (/^@(media|supports|layer|container|scope)\b/i.test(selector)) walk(inner)
        } else if (selector) {
          rules.push({ selector, declarations: declarations(inner) })
        }
        prelude = ''
        i = j + 1
        continue
      }
      prelude += c
      i += 1
    }
  }

  walk(source)
  return rules
}

/** The rule for exactly this selector, or undefined. A comma-separated
 *  prelude counts if any of its parts matches, because that is what it means.
 *  Later rules win, matching the cascade for equal specificity. */
export function ruleFor(css: string | CssRule[], selector: string): CssRule | undefined {
  const rules = typeof css === 'string' ? parseRules(css) : css
  const want = selector.trim().replace(/\s+/g, ' ')
  let found: CssRule | undefined
  for (const rule of rules) {
    if (rule.selector.split(',').some((part) => part.trim().replace(/\s+/g, ' ') === want)) {
      found = found
        ? { selector: found.selector, declarations: new Map([...found.declarations, ...rule.declarations]) }
        : rule
    }
  }
  return found
}
