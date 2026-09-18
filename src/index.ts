/**
 * OpenCode plugin entry for Huawei Cloud CodeArts (snap-access InferHub API,
 * SDK-HMAC-SHA256 signed) — dual-format default export per
 * docs/build/plugins/migrate-v1 ("Support V1 and V2 from one package"):
 *
 *   - V1 hosts call `server()` (hooks: config / provider / auth / tool)
 *   - V2 hosts call `setup(ctx)` (provider / integration / tool transforms,
 *     plus a session `http.request` signing hook)
 *
 * The V2 host validates `id` + `setup` and ignores unknown fields; the V1
 * host reads `server`. Layout mirrors opencode-glm-vistatus: `v1/`, `v2/`,
 * shared logic in `utils/`.
 */

import type { PluginModule } from "@opencode-ai/plugin";
import { server } from "./v1/index.js";
import { setup } from "./v2/index.js";
import type { V2Context } from "./v2/types.js";

export { VISION_TOOL_ID, DEFAULT_VISION_MODEL } from "./utils/constants.js";

const mod: PluginModule & {
  setup: (context: V2Context) => Promise<(() => void) | void>;
} = {
  id: "opencode-codearts-provider",
  server,
  setup,
};

export default mod;
