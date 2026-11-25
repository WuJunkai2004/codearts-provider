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
  /** Host plugin-RPC domain (≥ v2.0.25): register methods other plugins
   * (TUI included) can call over the server's /api/rpc route. */
  readonly rpc?: {
    readonly register?: (
      definition: {
        readonly id: string;
        readonly methods: Record<
          string,
          { readonly input: unknown; readonly output: unknown }
        >;
        readonly events: Record<string, unknown>;
      },
      handlers: Record<
        string,
        (
          input: unknown,
          context: { readonly signal: AbortSignal },
        ) => Promise<unknown>
      >,
    ) => Promise<unknown>;
  };
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
    readonly hook: {
      (
        name: "http.request",
        callback: (event: SessionHttpRequestEvent) => Promise<void> | void,
        options?: { readonly providerID?: string },
      ): Promise<unknown>;
      (
        name: "http.response",
        callback: (event: SessionHttpResponseEvent) => Promise<void> | void,
        options?: { readonly providerID?: string },
      ): Promise<unknown>;
      (
        name: "retry",
        callback: (event: SessionRetryEvent) => Promise<void> | void,
        options?: { readonly providerID?: string },
      ): Promise<unknown>;
    };
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
  /** Generic per-tool input: each add() infers its own execute input shape. */
  add<T>(tool: {
    readonly name: string;
    readonly description: string;
    readonly input: Record<string, unknown>;
    readonly execute: (
      input: T,
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

/** Response counterpart (host ≥ 2026-08, sst/opencode #40327): `response`
 * is mutable — replace it to rewrite the exchange's reply. */
export interface SessionHttpResponseEvent {
  readonly sessionID: string;
  readonly agent?: string;
  readonly model: { readonly providerID: string; readonly id: string };
  readonly kind?: "primary" | "compaction" | "title" | "generate";
  readonly request: Request;
  response: Response;
}

/** Retry-policy hook (docs/build/plugins/server → "Retry policy"): runs
 * after the host classified a provider failure and proposed its policy,
 * before any retry is scheduled. `decision` is mutable — setting it makes a
 * terminal failure retryable or vetoes a proposed retry; the host's built-in
 * maximum attempt count still bounds forced retries. `attempt` is the
 * physical attempt under consideration (initial request = 1). */
export interface SessionRetryEvent {
  readonly sessionID: string;
  readonly agent?: string;
  readonly model: { readonly providerID: string; readonly id: string };
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly status?: number;
  };
  readonly attempt: number;
  decision: { retry: false } | { retry: true; delay: number };
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
