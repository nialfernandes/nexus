// Reading the environment: each setting a command needs, or a plain message naming the ones that are missing.

import { Stop, type Io } from "./io";

/** The values of the named variables, all of them present and not blank, or a Stop that names the ones that are not. */
export function need<K extends string>(io: Io, names: readonly K[]): Record<K, string> {
  const found: Partial<Record<K, string>> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = io.env[name]?.trim();
    if (value === undefined || value === "") missing.push(name);
    else found[name] = value;
  }
  if (missing.length > 0) throw new Stop(`Set ${missing.join(", ")} in the environment first (see the package's README).`);
  return found as Record<K, string>;
}
