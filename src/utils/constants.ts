/** Provider id in opencode's provider registry (/connect, config.provider). */
export const PROVIDER_ID = "codearts";

/** Placeholder model injected when no credentials exist yet. It never routes
 * to the gateway — its name carries the connect hint instead. */
export const HINT_MODEL_ID = "connect-required";

/** opengw gateway: IDE-exclusive model discovery endpoint. Uses the same
 * AK/SK signing as snap-access. Inference for these models goes through
 * snap-access with a `maas_type: benefit` header (see signer.ts). */
export const OPENGW_HOST = "opengw.developer.huaweicloud.com";
export const OPENGW_BASE = `https://${OPENGW_HOST}`;

export const getEnv = (name: string): string | undefined => process.env[name];
