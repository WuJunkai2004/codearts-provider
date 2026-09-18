import type { PluginOptions } from "@opencode-ai/plugin";

/**
 * Doc-shaped subset of the V2 plugin context used by this plugin
 * (docs/build/plugins + docs/build/plugins/migrate-v1). Domains are optional
 * so a host without one skips that part instead of failing the plugin. No
 * `@opencode/plugin` runtime import — the V2 host injects everything.
 */
export interface V2Context {
  readonly options: PluginOptions;
  /** Where this plugin instance loaded (tool path resolution base). */
  readonly location?: { readonly directory?: string };
  readonly provider?: {
    readonly transform: (
      cb: (editor: ProviderEditor) => void,
    ) => Promise<unknown>;
    readonly reload?: () => Promise<void>;
  };
  readonly integration?: {
    readonly transform: (
      cb: (editor: IntegrationEditor) => void,
    ) => Promise<unknown>;
    readonly connection?: {
      readonly active?: (
        integrationID: string,
      ) => Promise<ConnectionInfo | undefined>;
      readonly resolve?: (
        connection: ConnectionInfo,
      ) => Promise<CredentialValue | undefined>;
    };
  };
  readonly tool?: {
    readonly transform: (cb: (editor: ToolEditor) => void) => Promise<unknown>;
  };
  readonly session?: {
    readonly hook: (
      name: "http.request",
      callback: (event: SessionHttpRequestEvent) => Promise<void> | void,
      options?: { readonly providerID?: string },
    ) => Promise<unknown>;
  };
}

/** docs/build/plugins/effect → ProviderEditor: `add` contributes a source
 * definition ({ info, models }), `update` mutates settings, `models.set`
 * replaces the source inventory. */
export interface ProviderEditor {
  add?(input: {
    readonly info: Record<string, unknown>;
    readonly models: readonly Record<string, unknown>[];
    readonly sourceConnection?: unknown;
  }): void;
  update?(providerID: string, update: (provider: any) => void): void;
  readonly models?: {
    readonly set: (
      providerID: string,
      models: readonly Record<string, unknown>[],
    ) => void;
  };
}

export interface IntegrationRef {
  readonly id: string;
  name?: string;
}

export interface IntegrationEditor {
  update?(id: string, update: (integration: IntegrationRef) => void): void;
  readonly method?: {
    readonly update: (input: {
      readonly integrationID: string;
      readonly method: {
        readonly type: "key";
        readonly label?: string;
        readonly form?: readonly Record<string, unknown>[];
      };
    }) => void;
  };
}

export interface ToolEditor {
  add(tool: {
    readonly name: string;
    readonly description: string;
    readonly input: Record<string, unknown>;
    readonly execute: (
      input: { image?: string; image_url?: string; prompt?: string },
      context?: { readonly sessionID?: string },
    ) => Promise<{ content: string }>;
  }): void;
}

/** Native HTTP exchange for one provider model call (docs/build/plugins —
 * session hooks). `request` is mutable: replace it to rewrite body/headers. */
export interface SessionHttpRequestEvent {
  readonly sessionID: string;
  readonly agent?: string;
  readonly model: { readonly providerID: string; readonly id: string };
  readonly kind?: "primary" | "compaction" | "title" | "generate";
  request: Request;
}

export interface ConnectionInfo {
  readonly id?: string;
  readonly [key: string]: unknown;
}

/** V2 credential shape (`Credential.Value`, key method): key = SK,
 * metadata.ak = AK — same storage layout the V1 /connect flow wrote. */
export interface CredentialValue {
  readonly type?: string;
  readonly key?: string;
  readonly metadata?: Record<string, unknown>;
}
