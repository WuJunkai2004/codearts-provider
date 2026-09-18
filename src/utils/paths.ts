import { isAbsolute, join } from "node:path";

/** Resolves a user-supplied image path against the session's project directory. */
export function resolvePath(directory: string, p: string): string {
  return isAbsolute(p) ? p : join(directory || process.cwd(), p);
}
