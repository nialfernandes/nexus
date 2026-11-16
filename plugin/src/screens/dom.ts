// The few helpers the screens build their elements with. Everything a screen shows is put in as text (a text node or an input's value),
// never as markup: a label or a name that a device sent is only ever text, whatever it holds.

type Child = Node | string | null | false | undefined;

export interface Attributes {
  class?: string;
  /** Anything else is set as an attribute, except `on` and `value`. */
  [name: string]: string | number | boolean | Record<string, (event: Event) => void> | undefined;
  on?: Record<string, (event: Event) => void>;
}

/** An element with its attributes (a `true` is written as present, `false` and `undefined` are left out), its listeners and its children (text is put in as a text node). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  const { on, class: className, ...rest } = attributes;
  if (className) element.className = className;
  for (const [name, value] of Object.entries(rest)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const [type, listener] of Object.entries(on ?? {})) element.addEventListener(type, listener);
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

const SVG = "http://www.w3.org/2000/svg";

/** An svg icon from its parts: `paths` are the shapes, each with its own attributes. */
export function icon(size: number, viewBox: string, shapes: Array<{ shape: "path" | "circle"; attributes: Record<string, string> }>): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  for (const { shape, attributes } of shapes) {
    const part = document.createElementNS(SVG, shape);
    for (const [name, value] of Object.entries(attributes)) part.setAttribute(name, value);
    svg.append(part);
  }
  return svg;
}
