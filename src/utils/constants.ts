import { isAbsolute, join } from "node:path";

/** Provider id in opencode's provider registry (/connect, config.provider). */
export const PROVIDER_ID = "codearts";

/** Placeholder model injected when no credentials exist yet. It never routes
 * to the gateway — its name carries the connect hint instead. */
export const HINT_MODEL_ID = "connect-required";

/** Name of the tool exposed to the LLM when the vision tool is enabled. */
export const VISION_TOOL_ID = "codearts_vision";

/** Default multimodal model used by the vision tool (routing alias). */
export const DEFAULT_VISION_MODEL = "Qwen3-VL-235B";

export const getEnv = (name: string): string | undefined => process.env[name];

/** Resolves a user-supplied image path against the session's project directory. */
export function resolvePath(directory: string, p: string): string {
  return isAbsolute(p) ? p : join(directory || process.cwd(), p);
}
