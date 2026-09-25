# OpenCode Plugin SDK — Exact TypeScript API Surface Reference

Extracted verbatim from the extracted npm tarballs under `research/api-types/`.
Every signature below is copied (not paraphrased) from the cited `.d.ts`.

**Sources**

| Alias | Package | Path |
|---|---|---|
| V2 plugin (promise) | `@opencode/plugin@2.0.16` | `research/api-types/opencode-plugin-2.0.16/dist/promise/*.d.ts` |
| V2 plugin (effect) | `@opencode/plugin@2.0.16` | `research/api-types/opencode-plugin-2.0.16/dist/effect/*.d.ts` |
| V2 plugin (tui) | `@opencode/plugin@2.0.16` | `research/api-types/opencode-plugin-2.0.16/dist/tui/*.d.ts` |
| V2 client | `@opencode/client@2.0.16` | `research/api-types/opencode-client-2.0.16/dist/promise/*.d.ts` |
| Schema | `@opencode/schema@2.0.16` | `research/api-types/opencode-schema-2.0.16/dist/*.d.ts` |
| AI runtime | `@opencode/ai@2.0.16` | `research/api-types/opencode-ai-2.0.16/dist/**/*.d.ts` |
| V1 plugin | `@opencode-ai/plugin@1.18.32` | `research/api-types/opencode-ai-plugin-1.18.32/dist/*.d.ts` |
| OpenAPI | opencode server | `research/docs-scrape/v2/openapi.json` (OpenAPI 3.1.0, `opencode HttpApi 0.0.1`) |

---

## 1. V2 PLUGIN CONTEXT MAP

Source: `opencode-plugin-2.0.16/dist/promise/plugin.d.ts`

```ts
export interface Context {
    readonly app: App;
    readonly location: Location.Info;
    readonly options: PluginOptions;
    readonly agent: AgentDomain;
    readonly aisdk: AISDKDomain;
    readonly command: CommandDomain;
    readonly event: EventDomain;
    readonly experimental: {
        readonly terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read">;
    };
    readonly integration: IntegrationDomain;
    readonly mcp: MCPDomain;
    readonly model: ModelDomain;
    readonly generate: GenerateApi;
    readonly permission: PermissionDomain;
    readonly plugin: Pick<PluginApi, "list">;
    readonly provider: ProviderDomain;
    readonly reference: ReferenceDomain;
    readonly rpc: RpcDomain;
    readonly session: SessionDomain;
    readonly shell: ShellDomain;
    readonly skill: SkillDomain;
    readonly storage: StorageDomain;
    readonly tool: ToolDomain;
    readonly vcs: VcsDomain;
    readonly websearch: WebSearchDomain;
    readonly worktree: WorktreeDomain;
}

export type Cleanup = () => Promise<void> | void;
export interface Plugin {
    readonly id: string;
    readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
}
export declare function define(plugin: Plugin): Plugin;
```

**Registration primitives** — `promise/registration.d.ts`:

```ts
export interface Registration {
    readonly dispose: () => Promise<void>;
}
export interface ModelHookOptions {
    /** Limits the hook to one provider. Unscoped hooks apply to every provider. */
    readonly providerID?: string;
}
export type Hooks<Spec> = <Name extends keyof Spec>(name: Name, callback: (input: Spec[Name]) => Promise<void> | void) => Promise<Registration>;
export type ModelHooks<Spec> = <Name extends keyof Spec>(name: Name, callback: (input: Spec[Name]) => Promise<void> | void, options?: Spec[Name] extends {
    readonly model: unknown;
} ? ModelHookOptions : never) => Promise<Registration>;
export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>;
```

Every domain returns a `Promise<Registration>`; all registrations must be `dispose()`d (or scope-bound) on plugin unload.

### 1.1 `app` / `location` / `options`

- `promise/plugin.d.ts` + `dist/app.d.ts`: `App` = `{ readonly name: string; readonly version: string; readonly channel: string; }`
- `location: Location.Info` (`opencode-schema-2.0.16/dist/location.d.ts`) — effect `Schema.Class`:
  `directory: AbsolutePath` (branded), `workspaceID?: Workspace.ID`, `project: { id: Project.ID; directory: AbsolutePath; canonical: AbsolutePath }`
- `options: PluginOptions` (`dist/options.d.ts`) = `Readonly<Record<string, any>>`

### 1.2 `agent` — `promise/agent.d.ts`

```ts
export interface AgentEditor {
    list(): readonly DeepMutable<Agent.Info>[];
    get(id: string): DeepMutable<Agent.Info> | undefined;
    default(id: string | undefined): void;
    update(id: string, update: (agent: DeepMutable<Agent.Info>) => void): void;
    remove(id: string): void;
}
export interface AgentDomain extends AgentApi {
    readonly transform: Transform<AgentEditor>;
    readonly reload: () => Promise<void>;
}
```

### 1.3 `aisdk` — `promise/aisdk.d.ts` (FULL, undocumented)

```ts
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { Model } from "@opencode/schema/model";
import type { ModelHooks } from "./registration.js";
export interface AISDKHooks {
    sdk: {
        readonly model: Model.Info;
        readonly package: string;
        readonly options: Record<string, any>;
        sdk?: any;
    };
    language: {
        readonly model: Model.Info;
        readonly sdk: any;
        readonly options: Record<string, any>;
        language?: LanguageModelV3;
    };
}
export interface AISDKDomain {
    readonly hook: ModelHooks<AISDKHooks>;
}
```

Notes:
- Two hook names: `"sdk"` and `"language"`. Both are **mutable at `sdk?` / `language?`** — assign to replace the provider SDK instance or the `LanguageModelV3` model.
- Because these are `ModelHooks`, both accept an optional third arg `{ providerID?: string }` to scope the hook to one provider.
- Because each spec member has a `readonly model: Model.Info` key, the conditional `ModelHookOptions` branch resolves to `never | { providerID?: string }` → the options parameter **is** accepted.
- Identical shape in `dist/effect/aisdk.d.ts` (same `AISDKHooks`, callback returns `Effect<void, never>` under `effect/registration.d.ts`).

### 1.4 `command` — `promise/command.d.ts`

```ts
export interface CommandInvocation {
    readonly sessionID: Session.ID;
    readonly prompt: PromptInput.Prompt;
    readonly delivery: SessionInbox.Delivery;   // "steer" | "queue"
}
export interface CommandDefinition {
    readonly name: string;
    readonly description?: string;
    readonly execute: (input: CommandInvocation) => Promise<void>;
}
export interface CommandEditor {
    add(definition: CommandDefinition): void;
}
export interface CommandDomain extends Pick<CommandApi, "list"> {
    readonly transform: Transform<CommandEditor>;
    readonly reload: () => Promise<void>;
}
```

### 1.5 `event` — `promise/event.d.ts`

```ts
export interface EventDomain extends Pick<EventApi, "subscribe"> {
}
```

### 1.6 `experimental.terminal` — `promise/plugin.d.ts`

`Pick<OpenCodeClient["experimental"]["persistentPty"], "read">`, i.e. exactly:

```ts
read: (input: ExperimentalPersistentPtyReadInput, requestOptions?: OpenCode.RequestOptions) => Promise<PersistentPtyReadResult | null>;
```

with (`opencode-client-2.0.16/dist/promise/generated/types.d.ts`):

```ts
export type ExperimentalPersistentPtyReadInput = {
    readonly sessionID: string;      // via indexed access on { readonly sessionID: string }
    readonly lines?: number;         // via indexed access, optional
};
export type PersistentPtyReadResult = {
    ptyID: string;
    title: string;
    cwd: string;
    foregroundProcess: string | null;
    screen: { text: string; cols: number; rows: number; cursor: { x: number; y: number } };
};
```

(The indexed-access indirection in the generated types is shown expanded.)

### 1.7 `integration` — `promise/integration.d.ts`

```ts
type IntegrationRef = { id: string; name: string };
export interface IntegrationOAuthMethod {
    readonly id: string; readonly type: "oauth"; readonly label: string; readonly form?: Form.Fields;
}
export interface IntegrationCommandMethod {
    readonly id: string; readonly type: "command"; readonly label: string; readonly command: ReadonlyArray<string>;
}
export interface IntegrationKeyMethod { readonly type: "key"; readonly label?: string; readonly form?: Form.Fields; }
export interface IntegrationEnvMethod { readonly type: "env"; readonly names: ReadonlyArray<string>; }
export type IntegrationMethod = IntegrationOAuthMethod | IntegrationCommandMethod | IntegrationKeyMethod | IntegrationEnvMethod;

export type IntegrationOAuthAuthorization = {
    readonly url: string;
    readonly instructions: string;
    readonly expiresAt?: number;
} & ({
    readonly mode: "auto";
    readonly callback: Promise<Credential.OAuth>;
} | {
    readonly mode: "code";
    readonly callback: (code: string) => Promise<Credential.OAuth>;
});

export type IntegrationOAuthMethodRegistration = {
    readonly integrationID: string;
    readonly method: IntegrationOAuthMethod;
    readonly authorize: (answer: Form.Answer) => Promise<IntegrationOAuthAuthorization>;
    readonly refresh?: (credential: Credential.OAuth) => Promise<Credential.OAuth>;
    readonly label?: (credential: Credential.OAuth) => string | undefined;
};
export type IntegrationMethodRegistration = IntegrationOAuthMethodRegistration | {
    readonly integrationID: string; readonly method: IntegrationCommandMethod;
} | {
    readonly integrationID: string; readonly method: IntegrationKeyMethod;
} | {
    readonly integrationID: string; readonly method: IntegrationEnvMethod;
};

export interface IntegrationEditor {
    list(): readonly IntegrationRef[];
    get(id: string): IntegrationRef | undefined;
    update(id: string, update: (integration: IntegrationRef) => void): void;
    remove(id: string): void;
    readonly method: {
        list(integrationID: string): readonly IntegrationMethod[];
        update(input: IntegrationMethodRegistration): void;
        remove(integrationID: string, method: IntegrationMethod): void;
    };
}
export interface IntegrationDomain extends Omit<IntegrationApi, "wellknown"> {
    readonly transform: Transform<IntegrationEditor>;
    readonly reload: () => Promise<void>;
    readonly connection: {
        readonly active: (integrationID: string) => Promise<ConnectionInfo | undefined>;
        readonly resolve: (connection: ConnectionInfo) => Promise<Credential.Value | undefined>;
    };
}
```

### 1.8 `mcp` — `promise/mcp.d.ts`

```ts
export interface MCPEditor {
    list(): readonly [string, DeepMutable<Mcp.ServerConfig>][];
    get(name: string): DeepMutable<Mcp.ServerConfig> | undefined;
    set(name: string, config: Mcp.ServerConfig): void;
    update(name: string, update: (config: DeepMutable<Mcp.ServerConfig>) => void): void;
    remove(name: string): void;
}
export interface MCPDomain extends Pick<McpApi, "list"> {
    readonly transform: Transform<MCPEditor>;
    readonly reload: () => Promise<void>;
}
```

### 1.9 `model` — `promise/model.d.ts`

```ts
export interface ModelEditor {
    /** Candidates from available providers, including models disabled by earlier transforms. */
    list(providerID?: string): readonly DeepMutable<Model.Info>[];
    get(providerID: string, modelID: string): DeepMutable<Model.Info> | undefined;
    /** Edits raw model overrides; cannot create an unavailable provider. */
    update(providerID: string, modelID: string, update: (model: DeepMutable<Model.Info>) => void): void;
    remove(providerID: string, modelID: string): void;
    readonly default: {
        get(): { providerID: string; modelID: string } | undefined;
        set(providerID: string, modelID: string): void;
    };
    /** Immutable provider inputs, including inactive templates, before model transforms. */
    readonly provider: {
        list(): readonly ProviderRecord[];
        get(providerID: string): ProviderRecord | undefined;
    };
}
export interface ModelDomain extends ModelApi {
    readonly transform: Transform<ModelEditor>;
    readonly reload: () => Promise<void>;
}
```

### 1.10 `generate` — `Client["generate"]` (`opencode-client-2.0.16/dist/promise/api.d.ts`)

```ts
export type GenerateApi = Client["generate"];
```

expanded from `promise/client.d.ts`:

```ts
generate: {
    text: (input: GenerateTextInput, requestOptions?: OpenCode.RequestOptions) => Promise<{ text: string }>;
};
```

See §4 for `GenerateTextInput`.

### 1.11 `permission` — `promise/permission.d.ts`

```ts
export interface PermissionEvaluation {
    readonly sessionID: Session.ID;
    readonly agent?: Agent.ID;
    readonly action: string;
    readonly resources: ReadonlyArray<string>;
    readonly metadata?: Record<string, unknown>;
    readonly source?: Permission.Source;
    effect: Permission.Effect;      // mutable — the hook's output
    message?: string;               // mutable
}
export interface PermissionHooks {
    readonly evaluate: PermissionEvaluation;
}
export type PermissionDomain = Pick<PermissionApi, "list" | "get" | "reply"> & {
    readonly hook: Hooks<PermissionHooks>;
};
```

(`PermissionApi` also exposes `request.list`, `saved.list`, `saved.remove`, `create` — those are **not** on the domain, only `list`/`get`/`reply`.)

### 1.12 `plugin` — `Pick<PluginApi, "list">`

```ts
plugin: {
    list: (input?: PluginListInput, requestOptions?: RequestOptions) => Promise<PluginListOutput>;
}
```

(`PluginApi` also has `check`, `update` — not exposed on `ctx.plugin`.)

### 1.13 `provider` — `promise/provider.d.ts`

```ts
/** Provider metadata and immutable source definitions, including inactive providers. */
export interface ProviderRecord {
    readonly provider: Provider.Info;
    readonly models: ReadonlyMap<string, Model.Info>;
    readonly sourceConnection?: ConnectionInfo;
}
export interface ProviderEditor {
    list(): readonly ProviderRecord[];
    get(providerID: string): ProviderRecord | undefined;
    /** A discovered account-specific inventory can be bound to the connection that produced it. */
    add(input: { info: Provider.Info; models: readonly Model.Info[]; sourceConnection?: ConnectionInfo }): void;
    update(providerID: string, update: (provider: DeepMutable<Provider.Info>) => void): void;
    remove(providerID: string): void;
    readonly models: {
        set(providerID: string, models: readonly Model.Info[]): void;
        /** Updates an owned copy of a source definition. */
        update(providerID: string, modelID: string, update: (model: DeepMutable<Model.Info>) => void): void;
        remove(providerID: string, modelID: string): void;
    };
}
export interface ProviderDomain extends ProviderApi {
    readonly transform: Transform<ProviderEditor>;
    readonly reload: () => Promise<void>;
}
```

### 1.14 `reference` — `promise/reference.d.ts`

```ts
export interface ReferenceEditor {
    add(name: string, source: ReferenceLocalSource | ReferenceGitSource): void;
    remove(name: string): void;
    list(): readonly (readonly [string, ReferenceLocalSource | ReferenceGitSource])[];
    get(name: string): ReferenceLocalSource | ReferenceGitSource | undefined;
}
export interface ReferenceDomain extends ReferenceApi {
    readonly transform: Transform<ReferenceEditor>;
    readonly reload: () => Promise<void>;
}
```

### 1.15 `rpc` — `promise/rpc.d.ts`

```ts
export interface RpcCallContext<M extends Rpc.Method> {
    readonly signal: AbortSignal;
    readonly error: Rpc.ErrorFactory<M>;
}
export type RpcHandlers<D extends Rpc.PortableDefinition> = {
    readonly [Name in keyof D["methods"]]: (input: Rpc.Output<D["methods"][Name]["input"]>, context: RpcCallContext<D["methods"][Name]>) => Promise<Rpc.HandlerOutput<D["methods"][Name]["output"]> | Rpc.HandlerError<D["methods"][Name]>>;
};
export interface RpcRegistration<D extends Rpc.PortableDefinition> extends Registration {
    readonly events: {
        readonly emit: (...args: Rpc.EventInput<D>) => Promise<void>;
    };
}
export interface RpcDomain extends RpcApi<Pick<RpcCallOptions, "signal"> & {
    readonly location?: never;
    readonly headers?: never;
}> {
    readonly register: <const D extends Rpc.PortableDefinition>(definition: D, handlers: RpcHandlers<NoInfer<D>>) => Promise<RpcRegistration<D>>;
}
```

RPC handlers can throw via `context.error` factory; `registration.events.emit(...)` pushes plugin-defined events.

### 1.16 `session` — `promise/session.d.ts` (see §2 for hooks)

```ts
export type SessionDomain = Pick<SessionApi, "create" | "get" | "switchAgent" | "switchModel" | "prompt" | "generate" | "command" | "synthetic" | "interrupt" | "update" | "move" | "wait" | "context"> & {
    readonly hook: ModelHooks<SessionHooks>;
};
```

Note: `session.hook` is a `ModelHooks<...>`, so every session hook call takes an optional third argument `{ providerID?: string }`.

### 1.17 `shell` — `promise/shell.d.ts`

```ts
export interface ShellCreateBefore {
    command: string;
    cwd: string;
    timeout: number;
    shell: string;
    env: Record<string, string | undefined>;
}
export interface ShellHooks {
    readonly "create.before": ShellCreateBefore;
}
export interface ShellDomain {
    readonly hook: Hooks<ShellHooks>;
}
```

(All five fields are mutable; the hook returns `Promise<void> | void` and cannot cancel.)

### 1.18 `skill` — `promise/skill.d.ts`

```ts
export interface SkillEditor {
    list(): readonly DeepMutable<Skill.Info>[];
    get(id: string): DeepMutable<Skill.Info> | undefined;
    add(skill: Skill.Info): void;
    update(id: string, update: (skill: DeepMutable<Skill.Info>) => void): void;
    remove(id: string): void;
}
export interface SkillDomain extends SkillApi {
    readonly transform: Transform<SkillEditor>;
    readonly reload: () => Promise<void>;
}
```

### 1.19 `storage` — `promise/storage.d.ts` (see §7)

### 1.20 `tool` — `promise/tool.d.ts` (see §3)

### 1.21 `vcs` — `promise/vcs.d.ts`

```ts
export interface VcsScope {
    readonly directory: string;
    readonly worktree: string;
    readonly canonical: string;
    readonly store?: string;
}
export interface VcsBranchesInput extends VcsScope { readonly search?: string; readonly limit?: number; }
export interface VcsDiffInput extends VcsScope {
    readonly mode: Vcs.Mode;
    readonly base?: string;
    readonly context: number;
    readonly maxOutputBytes: number;
}
export interface VcsDefinition {
    readonly id: string;
    readonly name: string;
    readonly info: (input: VcsScope, context: { readonly signal: AbortSignal }) => Promise<Vcs.Info>;
    readonly base?: (input: VcsScope, context: { readonly signal: AbortSignal }) => Promise<Vcs.Base | null>;
    readonly branches: (input: VcsBranchesInput, context: { readonly signal: AbortSignal }) => Promise<Vcs.BranchList>;
    readonly status: (input: VcsScope, context: { readonly signal: AbortSignal }) => Promise<readonly Vcs.FileStatus[]>;
    readonly diff: (input: VcsDiffInput, context: { readonly signal: AbortSignal }) => Promise<readonly FileDiff.Info[]>;
}
export interface VcsDomain extends VcsApi {
    readonly transform: Transform<VcsEditor>;
    readonly reload: () => Promise<void>;
}
export interface VcsEditor {
    add(definition: VcsDefinition): void;
    readonly default: { get(): string | undefined; set(selection: string): void; };
}
```

### 1.22 `websearch` — `promise/websearch.d.ts`

```ts
export interface WebSearchDefinition {
    readonly id: string;
    readonly name: string;
    readonly execute: (input: WebSearch.ProviderInput, context: { readonly signal: AbortSignal }) => Promise<readonly WebSearch.Result[]>;
}
export interface WebSearchDomain extends WebSearchApi {
    readonly transform: Transform<WebSearchEditor>;
    readonly reload: () => Promise<void>;
}
export interface WebSearchEditor {
    add(definition: WebSearchDefinition): void;
    readonly default: { get(): string | false | undefined; set(selection: string | false): void; };
}
```

### 1.23 `worktree` — `promise/worktree.d.ts` + `dist/worktree.d.ts`

```ts
export interface WorktreeCreateInput {
    readonly sourceDirectory: string;
    /** Suggested destination after naming and collision handling. Strategies may return a different directory. */
    readonly directory: string;
    /** Starting ref, not the name of a new branch. Reject unsupported refs rather than ignoring them. */
    readonly branch?: string;
}
export interface WorktreeRemoveInput { readonly directory: string; readonly force: boolean; }
export interface WorktreeResult {
    /** Actual directory created by the strategy, used for inventory and startup commands. */
    readonly directory: string;
}
export interface WorktreeEntry extends WorktreeResult { readonly type: "root" | "worktree"; }

export interface WorktreeDefinition {
    readonly id: string;
    readonly create: (input: WorktreeCreateInput, context: { readonly signal: AbortSignal }) => Promise<WorktreeResult>;
    readonly remove: (input: WorktreeRemoveInput, context: { readonly signal: AbortSignal }) => Promise<void>;
    readonly list: (sourceDirectory: string, context: { readonly signal: AbortSignal }) => Promise<readonly WorktreeEntry[]>;
}
export interface WorktreeEditor {
    /** Registers an implementation and selects it as the default. Later active registrations win. */
    add(definition: WorktreeDefinition): void;
}
export interface WorktreeDomain extends WorktreeApi {
    readonly transform: Transform<WorktreeEditor>;
    readonly reload: () => Promise<void>;
}
```

### 1.24 Entry points / variants

- **promise**: `dist/promise/index.d.ts` → `export * as Plugin from "./plugin.js"` plus re-exported schema namespaces (`Agent`, `Command`, `Connection`, `Credential`, `Integration`, `Location`, `Mcp`, `Model`, `PersistentPty`, `Provider`, `Reference`, `Rpc`, `Skill`, `Vcs`, `WebSearch`, `Worktree`) and `PluginOptions`, `StorageEntry`, `StorageScanOptions`, `StorageScanResult`.
- **effect**: `dist/effect/index.d.ts` — same shape; `Transform<Input> = (callback) => Effect<Registration, never, Scope.Scope>` (`effect/registration.d.ts`).
- **tui**: `dist/tui/plugin.d.ts` — `interface Definition { readonly id: string; readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void; }`, `declare function define(plugin: Definition): Definition`, `Context` from `dist/tui/context.d.ts` (`options`, `location`, `app`, `renderer`, `client`, `data`, `attention`, `theme`, `themeMode`, `markdown`, `keymap`, `storage`, `ui`).
- **adapter**: `dist/promise/adapter.d.ts` — `export declare function fromPromise(plugin: Plugin): import("../effect/plugin.js").Plugin<Scope.Scope>;`

---

## 2. V2 SESSION HOOKS TABLE

Source: `opencode-plugin-2.0.16/dist/promise/session.d.ts` (`export interface SessionHooks`, registered via `ctx.session.hook(name, cb, options?)`).

Shared payload types:

```ts
export interface SessionPrompt {
    readonly sessionID: Session.ID;
    readonly messageID: SessionMessage.ID;
    prompt: Types.DeepMutable<PromptInput.Prompt>;
    metadata?: Record<string, unknown>;
    delivery: SessionInbox.Delivery;
}
/** Request overrides. Typed keys are generation settings; any other key is a provider option. */
export type SessionRequestOptions = Types.DeepMutable<GenerationOptionsFields> & Record<string, unknown>;
export interface SessionRequest {
    readonly sessionID: Session.ID;
    readonly model: Model.Ref;
    system: Array<SystemPart>;
    messages: Array<Message>;
    options: SessionRequestOptions;
}
export interface SessionContext extends SessionRequest {
    readonly agent: Agent.ID;
    tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>;
}
export interface SessionCompactionResult {
    summary: string;
    providerState?: SessionMessage.ProviderState;
    metadata?: Record<string, unknown>;
    tokens?: TokenUsage.Info;
}
export interface SessionCompaction extends SessionContext {
    /** Set to use this compaction and skip the model request. */
    result?: SessionCompactionResult;
}
export interface SessionGenerate extends SessionContext {
}
export interface SessionTitle extends SessionRequest {
    /** Set to use this title and skip the model request. */
    result?: string;
}
export type SessionRequestKind = "primary" | "compaction" | "title" | "generate";
export type SessionRetryDecision = { retry: false } | { retry: true; delay: number };
```

| # | Hook name | Payload type | Readonly fields | Mutable (hook output) fields |
|---|---|---|---|---|
| 1 | `prompt` | `SessionPrompt` | `sessionID`, `messageID` | `prompt`, `metadata?`, `delivery` |
| 2 | `context` | `SessionContext` | `sessionID`, `model`, `agent` | `system`, `messages`, `options`, `tools` |
| 3 | `compaction` | `SessionCompaction` | `sessionID`, `model`, `agent` | `system`, `messages`, `options`, `tools`, `result?` (set to skip model request) |
| 4 | `generate` | `SessionGenerate` | `sessionID`, `model`, `agent` | `system`, `messages`, `options`, `tools` |
| 5 | `title` | `SessionTitle` | `sessionID`, `model` | `system`, `messages`, `options`, `result?` (set to skip model request) |
| 6 | `model.request` | `SessionModelRequest` | `sessionID`, `agent`, `model`, `kind` | `baseURL?`, `headers` |
| 7 | `http.request` | `SessionHttpRequest` | `sessionID`, `agent`, `model`, `kind`, `request` | *(none — immutable `Request`)* |
| 8 | `http.response` | `SessionHttpResponse` | `sessionID`, `agent`, `model`, `kind`, `request` | `response` |
| 9 | `experimental.ws.handshake` | `SessionWebSocketHandshake` | `sessionID`, `agent`, `model`, `kind` | `url`, `headers` (change reopens socket) |
| 10 | `experimental.ws.send` | `SessionWebSocketSend` | `sessionID`, `agent`, `model`, `kind` | `frame` (replacement sent verbatim) |
| 11 | `experimental.ws.receive` | `SessionWebSocketReceive` | `sessionID`, `agent`, `model`, `kind` | `frame` (replacement handed to driver verbatim) |
| 12 | `retry` | `SessionRetry` | `sessionID`, `agent`, `model`, `error`, `attempt` | `decision` (`{retry:false}` \| `{retry:true; delay:number}`) |

Exact `SessionHooks` block:

```ts
export interface SessionHooks {
    readonly prompt: SessionPrompt;
    readonly context: SessionContext;
    readonly compaction: SessionCompaction;
    readonly generate: SessionGenerate;
    readonly title: SessionTitle;
    readonly "model.request": SessionModelRequest;
    readonly "http.request": SessionHttpRequest;
    readonly "http.response": SessionHttpResponse;
    readonly "experimental.ws.handshake": SessionWebSocketHandshake;
    readonly "experimental.ws.send": SessionWebSocketSend;
    readonly "experimental.ws.receive": SessionWebSocketReceive;
    readonly retry: SessionRetry;
}
```

Doc comments copied verbatim:
- `SessionRequestKind`: "Why a Session request is being made. Auxiliary requests share the Session's hook identity but need to be told apart from the agent loop."
- `SessionWebSocketHandshake`: "Connection a WebSocket-backed request opens or reuses. Runs once per model call before the Session's socket is selected; changing `url` or `headers` reopens the socket. Experimental."
- `SessionWebSocketSend`: "Outbound frame about to be written to the Session's socket, after the provider driver has built it. Replacing `frame` sends the replacement verbatim; the driver still tracks state from the provider's replies, so a rewrite that changes protocol meaning is on the plugin. Experimental."
- `SessionWebSocketReceive`: "Inbound frame read from the Session's socket, before the provider driver observes it. Replacing `frame` hands the replacement to the driver verbatim. Experimental."

---

## 3. V2 TOOL API

Sources: `opencode-plugin-2.0.16/dist/promise/tool.d.ts`, `opencode-schema-2.0.16/dist/tool.d.ts`.

### 3.1 `Tool.Context` (schema) and `ToolContext` (plugin)

```ts
// opencode-schema-2.0.16/dist/tool.d.ts
export type Metadata = Readonly<Record<string, any>>;
export declare const CallID: Schema.brand<Schema.String, "Tool.CallID">;
export type CallID = typeof CallID.Type;
export interface Context {
    readonly sessionID: Session.ID;
    readonly agent: Agent.ID;
    readonly messageID: SessionMessage.ID;
    readonly id: CallID;
    readonly progress: (update: Metadata) => Effect.Effect<void>;
}
export interface Namespace {
    readonly name: string;
    readonly description: string;
}
```

```ts
// opencode-plugin-2.0.16/dist/promise/tool.d.ts — Effect progress replaced by Promise
export interface ToolContext extends Omit<Tool.Context, "progress"> {
    readonly signal: AbortSignal;
    readonly progress: (update: Tool.Metadata) => Promise<void>;
}
```

So the promise-plugin `ToolContext` fields are exactly: **`sessionID`, `agent`, `messageID`, `id`, `signal`, `progress`**. There is **no** `directory` / `worktree` / `ask()` on the V2 tool context (those were V1-only).

### 3.2 `Tool.Options` (schema)

```ts
interface BaseOptions {
    readonly namespace?: string;
    readonly permission?: string;
}
export type Options = BaseOptions & ({
    readonly codemode?: true;
    readonly pinned?: boolean;
} | {
    readonly codemode: boolean;
    readonly pinned?: never;
});
```

Reading: `namespace` and `permission` are always available. If `codemode` is **omitted**, `pinned?: boolean` is allowed; if `codemode` is given as an explicit `boolean`, `pinned` must be `never` (i.e. not set) — the two variants are mutually exclusive by type.

### 3.3 `Tool.Info` / `Tool.Result` (schema)

```ts
export type ValueSchema<A = unknown> = Schema.Codec<A, any> | StandardSchemaV1<any, A> | JsonSchema.JsonSchema;
export interface Result<Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined> {
    readonly output?: OutputValue<Output>;
    readonly content?: string | ReadonlyArray<Content>;
    readonly metadata?: Metadata;
}
export type Info<Input extends ValueSchema<any> = ValueSchema<any>, Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined> = {
    readonly name: string;
    readonly input: Input;
    readonly description: string;
    readonly execute: (input: InputValue<Input>, context: Context) => Effect.Effect<Result<Output>, Error>;
    readonly output?: Output;
    readonly options?: Options;
};
export declare class Error extends Schema.Class<Error, Schema.TaggedStruct<"Tool.Error", {
    readonly message: Schema.String;
    readonly error: Schema.optional<Schema.Defect>;
    readonly metadata: Schema.optional<Schema.$Record<Schema.String, Schema.Unknown>>;
}>, import("effect/Cause").YieldableError> {}
export type Content = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string };
```

### 3.4 Promise-plugin `Info` + `ToolEditor` ops

```ts
// opencode-plugin-2.0.16/dist/promise/tool.d.ts
export type Info<...> = Omit<Tool.Info<Input, Output>, "execute"> & {
    readonly execute: (input: Parameters<Tool.Info<Input, Output>["execute"]>[0], context: ToolContext) => Promise<Tool.Result<Output>>;
};

export interface ToolEditor {
    list(): readonly (Info & { readonly id: string })[];
    get(id: string): (Info & { readonly id: string }) | undefined;
    namespace(namespace: Tool.Namespace): void;
    add<Input extends Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any> | undefined>(tool: Info<Input, Output>): void;
    /** Updates an existing tool; missing IDs are ignored. */
    update(id: string, update: (tool: Types.Mutable<Info>) => void): void;
    remove(id: string): void;
}
```

Ops: **`list`, `get`, `namespace`, `add`, `update`, `remove`**.

### 3.5 `ToolHooks` — exact shapes (NOT exported; passed to `ctx.tool.hook`)

```ts
interface ToolHooks {
    readonly "execute.before": {
        tool: string;
        readonly sessionID: Session.ID;
        readonly agent: Agent.ID;
        readonly messageID: SessionMessage.ID;
        readonly id: Tool.CallID;
        input: unknown;
    };
    readonly "execute.after": {
        readonly tool: string;
        readonly sessionID: Session.ID;
        readonly agent: Agent.ID;
        readonly messageID: SessionMessage.ID;
        readonly id: Tool.CallID;
        readonly input: unknown;
    } & ({
        readonly status: "completed";
        result: Tool.Result;
    } | {
        readonly status: "error";
        error: Tool.Error;
    });
}
```

`execute.before`: mutable `tool` (rename) and `input` (mutate args); everything else readonly.
`execute.after`: only `input` is a mutable copy plus the discriminated `status` payload — `result` (on `completed`) and `error` (on `error`) are **mutable**, so a plugin can rewrite or replace the tool result/error.

### 3.6 `ToolDomain`

```ts
export interface ToolDomain {
    readonly transform: Transform<ToolEditor>;
    readonly reload: () => Promise<void>;
    /** Currently registered tools, after every transform, keyed by effective name. */
    readonly list: () => Promise<readonly (Info & { readonly id: string })[]>;
    readonly hook: Hooks<ToolHooks>;
}
```

Re-exported from the plugin package: `export { CallID, Error } from "@opencode/schema/tool"; export type { Metadata, Options, Result } from "@opencode/schema/tool";`

---

## 4. GENERATE API — `GenerateTextInput` expanded

Sources: `opencode-client-2.0.16/dist/promise/generated/types.d.ts:7067`, `:354`, `promise/client.d.ts`, `promise/api.d.ts`, `research/docs-scrape/v2/openapi.json`.

### 4.1 Raw declaration (verbatim)

```ts
export type GenerateTextInput = {
    readonly prompt: {
        readonly prompt: string;
        readonly model?: {
            readonly id: string;
            readonly providerID: string;
            readonly variant?: string;
        } | null;
    }["prompt"];
    readonly model?: {
        readonly prompt: string;
        readonly model?: {
            readonly id: string;
            readonly providerID: string;
            readonly variant?: string;
        } | null;
    }["model"];
};
export type GenerateTextOutput = GenerateTextResponse["data"];
export type GenerateTextResponse = {
    data: {
        text: string;
    };
};
```

### 4.2 Fully expanded (what you actually write)

The generator emits each field as an indexed access into an inline object literal (a flattened body/query-parameter idiom). Resolving `T["prompt"]` and `T["model"]`:

```ts
export type GenerateTextInput = {
    readonly prompt: string;                                   // REQUIRED
    readonly model?: {                                         // OPTIONAL, defaults to
        readonly id: string;                                   //   base config default model
        readonly providerID: string;
        readonly variant?: string;
    } | null;
};
// → Promise<{ text: string }>
```

`model` is exactly `Model.Ref` from the OpenAPI spec:

```jsonc
"Model.Ref": { "type":"object",
  "properties": { "id": {"type":"string"}, "providerID": {"type":"string"}, "variant": {"type":"string"} },
  "required": ["id","providerID"], "additionalProperties": false }
```

### 4.3 There are NO `options` / `system` fields

The server operation is `POST /api/experimental/generate` → `operationId: experimental.generate.text`, tag `generate`, `"security": []`, body schema:

```jsonc
{ "type":"object",
  "properties": { "prompt": {"type":"string"},
                  "model": { "anyOf": [ {"$ref":"#/components/schemas/Model.Ref"}, {"type":"null"} ] } },
  "required": ["prompt"], "additionalProperties": false }
```

Description: *"Run one stateless model generation using the server's base configuration and return the assistant text. Uses the base configuration's default model when none is specified."*

There is **no** `temperature`, `maxTokens`, `system`, `messages`, `tools`, or provider-options parameter on `generate.text`. Sampling overrides are only available on session-scoped generation.

### 4.4 The session-scoped sibling (for contrast)

```ts
export type SessionGenerateInput = {
    readonly sessionID: string;   // indexed access resolved
    readonly prompt: string;      // indexed access resolved
};
```

OpenAPI `POST /api/session/{sessionID}/generate` → `session.generate`, tag `session`, body = `{ "prompt": string }` only, required; description: *"Generate transient text from the current session context without mutating session history."* → `SessionGenerateResponse` = `{ data: { text: string } }`.

On the client both are typed identically: `Promise<{ text: string }>`.

### 4.5 Where sampling options DO live

`SessionRequestOptions` (`promise/session.d.ts`) = `Types.DeepMutable<GenerationOptionsFields> & Record<string, unknown>`, and `GenerationOptionsFields` (`opencode-ai-2.0.16/dist/schema/options.d.ts:42`):

```ts
export type GenerationOptionsFields = {
    readonly maxTokens?: number;
    readonly temperature?: number;
    readonly topP?: number;
    readonly topK?: number;
    readonly frequencyPenalty?: number;
    readonly presencePenalty?: number;
    readonly seed?: number;
    readonly stop?: ReadonlyArray<string>;
};
```

i.e. mutate `options` inside a `session.hook("generate" | "context" | "compaction" | "title", ...)` callback; anything not a typed key is passed through as a provider option.

---

## 5. V1 HOOKS TABLE

Source: `opencode-ai-plugin-1.18.32/dist/index.d.ts` (lines 173–322).

### 5.1 `PluginInput` and `PluginModule`

```ts
export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;
    project: Project;
    directory: string;
    worktree: string;
    experimental_workspace: {
        register(type: string, adapter: WorkspaceAdapter): void;
    };
    serverUrl: URL;
    $: BunShell;
};
export type PluginOptions = Record<string, unknown>;
export type Config = Omit<SDKConfig, "plugin"> & {
    plugin?: Array<string | [string, PluginOptions]>;
};
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
export type PluginModule = {
    id?: string;
    server: Plugin;
    tui?: never;
};
```

> ⚠️ `tui?: never` — a V1 `PluginModule` **cannot** carry a TUI plugin. The TUI half is a *separate* module type (`dist/tui.d.ts:506`): `export type TuiPluginModule = { id?: string; tui: TuiPlugin; server?: never; }` with `TuiPlugin = (api: TuiPluginApi, options: PluginOptions | undefined, meta: TuiPluginMeta) => Promise<void>`. `server` and `tui` are mutually exclusive by type.

### 5.2 Full `Hooks` interface (verbatim, every member)

```ts
export interface Hooks {
    dispose?: () => Promise<void>;
    event?: (input: { event: Event }) => Promise<void>;
    config?: (input: Config) => Promise<void>;
    tool?: { [key: string]: ToolDefinition };
    auth?: AuthHook;
    provider?: ProviderHook;

    /** Called when a new message is received */
    "chat.message"?: (input: {
        sessionID: string;
        agent?: string;
        model?: { providerID: string; modelID: string };
        messageID?: string;
        variant?: string;
    }, output: { message: UserMessage; parts: Part[] }) => Promise<void>;

    /** Modify parameters sent to LLM */
    "chat.params"?: (input: {
        sessionID: string;
        agent: string;
        model: Model;
        provider: ProviderContext;
        message: UserMessage;
    }, output: {
        temperature: number;
        topP: number;
        topK: number;
        maxOutputTokens: number | undefined;
        options: Record<string, any>;
    }) => Promise<void>;

    "chat.headers"?: (input: {
        sessionID: string;
        agent: string;
        model: Model;
        provider: ProviderContext;
        message: UserMessage;
    }, output: { headers: Record<string, string> }) => Promise<void>;

    "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>;

    "command.execute.before"?: (input: {
        command: string;
        sessionID: string;
        arguments: string;
    }, output: { parts: Part[] }) => Promise<void>;

    "tool.execute.before"?: (input: {
        tool: string;
        sessionID: string;
        callID: string;
    }, output: { args: any }) => Promise<void>;

    "shell.env"?: (input: {
        cwd: string;
        sessionID?: string;
        callID?: string;
    }, output: { env: Record<string, string> }) => Promise<void>;

    "tool.execute.after"?: (input: {
        tool: string;
        sessionID: string;
        callID: string;
        args: any;
    }, output: {
        title: string;
        output: string;
        metadata: any;
    }) => Promise<void>;

    "experimental.chat.messages.transform"?: (input: {}, output: {
        messages: { info: Message; parts: Part[] }[];
    }) => Promise<void>;

    "experimental.chat.system.transform"?: (input: {
        sessionID?: string;
        model: Model;
    }, output: { system: string[] }) => Promise<void>;

    "experimental.provider.small_model"?: (input: {
        provider: ProviderV2;
    }, output: { model?: ModelV2 }) => Promise<void>;

    /**
     * Called before session compaction starts. Allows plugins to customize
     * the compaction prompt.
     *
     * - `context`: Additional context strings appended to the default prompt
     * - `prompt`: If set, replaces the default compaction prompt entirely
     */
    "experimental.session.compacting"?: (input: {
        sessionID: string;
    }, output: { context: string[]; prompt?: string }) => Promise<void>;

    /**
     * Called after compaction succeeds and before a synthetic user
     * auto-continue message is added.
     *
     * - `enabled`: Defaults to `true`. Set to `false` to skip the synthetic
     *   user "continue" turn.
     */
    "experimental.compaction.autocontinue"?: (input: {
        sessionID: string;
        agent: string;
        model: Model;
        provider: ProviderContext;
        message: UserMessage;
        overflow: boolean;
    }, output: { enabled: boolean }) => Promise<void>;

    "experimental.text.complete"?: (input: {
        sessionID: string;
        messageID: string;
        partID: string;
    }, output: { text: string }) => Promise<void>;

    /** Modify tool definitions (description and parameters) sent to LLM */
    "tool.definition"?: (input: {
        toolID: string;
    }, output: { description: string; parameters: any }) => Promise<void>;
}
```

**Count: 21 members** — 20 async hooks + the `tool` tool-map field.

### 5.3 Supporting V1 types

```ts
export type ProviderContext = {
    source: "env" | "config" | "custom" | "api";
    info: Provider;
    options: Record<string, any>;
};

export type ProviderHook = {
    id: string;
    models?: (provider: ProviderV2, ctx: ProviderHookContext) => Promise<Record<string, ModelV2>>;
};
export type ProviderHookContext = { auth?: Auth };

export type AuthHook = {
    provider: string;
    loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>;
    methods: ({ type: "oauth"; label: string; prompts?: Prompt[]; authorize(inputs?): Promise<AuthOAuthResult> }
            | { type: "api";    label: string; prompts?: Prompt[]; authorize?(inputs?): Promise<{type:"success";key:string;provider?:string;metadata?:Record<string,string>} | {type:"failed"}> })[];
};
// Prompt = { type:"text"; key; message; placeholder?; validate?; condition? (deprecated); when?: Rule }
//        | { type:"select"; key; message; options: {label;value;hint?}[]; condition? (deprecated); when?: Rule }
type Rule = { key: string; op: "eq" | "neq"; value: string };

export type AuthOAuthResult = { url: string; instructions: string } & (
  { method: "auto"; callback(): Promise<Success> } |
  { method: "code"; callback(code: string): Promise<Success> });
// Success = { type:"success"; provider?: string } & ( {refresh;access;expires;accountId?;enterpriseUrl?} | {key;metadata?} ) | { type:"failed" }
/** @deprecated Use AuthOAuthResult instead. */
export type AuthOuathResult = AuthOAuthResult;
```

V1 tool helper (`dist/tool.d.ts`):

```ts
export type ToolContext = {
    sessionID: string; messageID: string; agent: string;
    /** Current project directory for this session. Prefer this over process.cwd() ... */
    directory: string;
    /** Project worktree root for this session. */
    worktree: string;
    abort: AbortSignal;
    metadata(input: { title?: string; metadata?: { [key: string]: any } }): void;
    ask(input: AskInput): Promise<void>;
};
type AskInput = { permission: string; patterns: string[]; always: string[]; metadata: { [key: string]: any } };
export type ToolResult = string | { title?: string; output: string; metadata?: { [key:string]: any }; attachments?: ToolAttachment[] };
export declare function tool<Args extends z.ZodRawShape>(input: {
    description: string;
    args: Args;
    execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>;
}): { description: string; args: Args; execute(...): Promise<ToolResult> };
export type ToolDefinition = ReturnType<typeof tool>;
```

---

## 6. V1 ↔ V2 MIGRATION CROSSWALK

Sources: `opencode-ai-plugin-1.18.32/dist/index.d.ts` → `opencode-plugin-2.0.16/dist/promise/*.d.ts`.

| V1 hook / field | V2 destination | Notes |
|---|---|---|
| `chat.message` | `ctx.session.hook("prompt", cb)` | V2 payload = `SessionPrompt`; mutate `prompt` (deep-mutable `PromptInput.Prompt`), `metadata`, `delivery`. V1's `parts` array and `variant` have no V2 equivalent here. |
| `chat.params` | `ctx.session.hook("generate" \| "context" \| "compaction" \| "title", cb)` → mutate `options` | `options: SessionRequestOptions = DeepMutable<GenerationOptionsFields> & Record<string, unknown>` covers `temperature/topP/topK/maxTokens/frequencyPenalty/presencePenalty/seed/stop` + arbitrary provider options. `maxOutputTokens` → `maxTokens`. |
| `chat.headers` | `ctx.session.hook("model.request", cb)` → mutate `headers` (and `baseURL?`) | Also `ctx.session.hook("http.request")` for the built `Request`. |
| `permission.ask` | `ctx.permission.hook("evaluate", cb)` | V1 writes `output.status: "ask"\|"deny"\|"allow"`; V2 writes `effect: Permission.Effect` + `message?` on `PermissionEvaluation`. |
| `command.execute.before` | **no direct equivalent** | V2 has only `ctx.command.transform(editor => editor.add(def))` + `ctx.command.transform` editor ops. Closest interception point is `ctx.session.hook("prompt")` (delivery is `"steer" \| "queue"`). |
| `tool.execute.before` | `ctx.tool.hook("execute.before", cb)` | Same keys `tool/sessionID/agent/messageID/id`; V2 adds `agent` and `messageID`, drops `callID` (now `id: Tool.CallID`). Mutate `input` instead of `args`. |
| `tool.execute.after` | `ctx.tool.hook("execute.after", cb)` | V2 payload is a discriminated union `status: "completed" \| "error"` with mutable `result: Tool.Result` / `error: Tool.Error` instead of flat `{title, output, metadata}`. |
| `shell.env` | `ctx.shell.hook("create.before", cb)` → mutate `env` | V2 payload adds mutable `command`, `cwd`, `timeout`, `shell`; `sessionID`/`callID` are **not** exposed. |
| `tool.definition` | `ctx.tool.transform(editor => editor.update(id, t => { ... }))` | Descriptions/parameters now changed through the editor (`DeepMutable`/`Types.Mutable<Info>`), not a per-request hook. |
| `tool` (tool map) | `ctx.tool.transform(editor => editor.add(info))` | V1 zod `args` → V2 `input: ValueSchema` (`Schema.Codec` \| StandardSchemaV1 \| `JsonSchema`). V1 `execute(args, ctx): Promise<ToolResult>` → V2 `execute(input, ctx): Promise<Tool.Result>`. |
| `experimental.chat.messages.transform` | `ctx.session.hook("context", cb)` → mutate `messages` | `messages: Array<Message>` (typed `Message` from `@opencode/ai`, not `{info, parts}[]`). Same mutation surface is also on `generate`/`compaction`/`title`. |
| `experimental.chat.system.transform` | `ctx.session.hook("context", cb)` → mutate `system` | `system: Array<SystemPart>` instead of `string[]`. `sessionID` → readonly `sessionID`; `model` → readonly `model: Model.Ref`. |
| `experimental.provider.small_model` | **no direct equivalent** | Closest: `ctx.model.transform` / `ctx.provider.transform`, or `ctx.session.hook("title")` for the title-generation model. |
| `experimental.session.compacting` | `ctx.session.hook("compaction", cb)` | V1 mutates `context[]`/`prompt?`; V2 mutates `system`/`messages`/`options`, or sets `result?: SessionCompactionResult` to **skip the model request** (stronger: full short-circuit). |
| `experimental.compaction.autocontinue` | **no direct equivalent** | No post-compaction gate in V2. |
| `experimental.text.complete` | **no direct equivalent** | No per-part text gate in V2 session hooks. |
| `event` | `ctx.event.subscribe(...)` | `EventDomain extends Pick<EventApi, "subscribe">` → `subscribe(options?: {signal?, onActivity?}): AsyncIterable<V2Event>`. |
| `config` | **no direct equivalent** | No `config` domain on V2 `Context`. Server op `experimental.config.update` exists but is not wired to plugins; use `model`/`provider`/`agent` transforms instead. |
| `auth` | `ctx.integration.transform(e => e.method.update(reg))` | V1 `AuthHook.methods[]` (`oauth`/`api`) → V2 `IntegrationMethodRegistration` (`oauth`/`key`/`env`/`command`); V1 `authorize(): AuthOAuthResult` → V2 `authorize(answer): Promise<IntegrationOAuthAuthorization>`; V1 `loader` → `ctx.integration.connection.resolve/connection.active`. |
| `provider` | `ctx.provider.transform(e => e.add({info, models, sourceConnection}))` | V1 `ProviderHook.models(provider) → Record<string, ModelV2>` → V2 `ProviderEditor.add` / `.models.set/update/remove`. |
| `dispose` | `setup` return value: `Cleanup = () => Promise<void> \| void` | Or per-registration `Registration.dispose()` from every `hook`/`transform` call. |
| `PluginInput.client` / `serverUrl` | `ctx.rpc`, `ctx.event`, plus each domain's `*Api` surface | No raw HTTP client is handed to V2 plugins. |
| `PluginInput.$` (BunShell) | `ctx.shell.hook("create.before")` (intercept) — no shell *executor* | V2 plugins don't run shell commands; they decorate them. |
| `PluginInput.experimental_workspace` | `ctx.worktree.transform(e => e.add(WorktreeDefinition))` | `create/remove/list` strategy replaces the workspace adapter. |
| `PluginModule { id?, server, tui? }` | `Plugin { id, setup(context) }` via `Plugin.define` | `tui?: never` in V1 — TUI half was `TuiPluginModule { tui; server?: never }`; in V2 it is a separate entry (`@opencode/plugin/tui`, `Definition { id, setup(context) }`). |

---

## 7. STORAGE & EVENT DOMAINS

### 7.1 `ctx.storage` — `opencode-plugin-2.0.16/dist/promise/storage.d.ts` (+ `dist/storage.d.ts`)

```ts
import type { Schema } from "effect";
import type { StorageScanOptions, StorageScanResult } from "../storage.js";
export interface StorageDomain {
    readonly get: (key: string) => Promise<Schema.Json | undefined>;
    readonly set: (key: string, value: Schema.Json) => Promise<void>;
    readonly remove: (key: string) => Promise<void>;
    readonly scan: (options: StorageScanOptions) => Promise<StorageScanResult>;
}
```

```ts
// opencode-plugin-2.0.16/dist/storage.d.ts
export interface StorageEntry {
    readonly key: string;
    readonly value: Schema.Json;
}
export interface StorageScanOptions {
    readonly prefix: string;
    readonly after?: string;
    readonly limit?: number;
}
export interface StorageScanResult {
    readonly entries: readonly StorageEntry[];
    readonly next?: string;
}
```

All four are async; values are `Schema.Json` (effect). `scan` is keyset-paginated: pass `prefix`, optional `after` cursor and `limit`, follow `next`.

(The TUI plugin context has a **different**, Solid-store-based storage — `dist/tui/context.d.ts`: `store<Value extends object>(key, {initial}): readonly [Store<Value>, (draft) => Promise<void>]` durable across reloads, and `memory<Value>(key, {initial}): readonly [Store<Value>, (draft) => void]` in-memory.)

### 7.2 `ctx.event.subscribe` — `opencode-plugin-2.0.16/dist/promise/event.d.ts` → `opencode-client-2.0.16/dist/promise/client.d.ts` + `shared-events.d.ts`

```ts
// promise/event.d.ts
export interface EventDomain extends Pick<EventApi, "subscribe"> {}

// promise/client.d.ts
event: {
    subscribe(options?: SharedEvents.SubscribeOptions): AsyncIterable<import("./index.js").V2Event>;
};

// shared-events.d.ts
export type SubscribeOptions = {
    readonly signal?: AbortSignal;
    /** Reports transport activity on the shared stream, including keepalive frames that carry no event. */
    readonly onActivity?: () => void;
};
export type EventSubscribeOutput = V2Event;   // generated/types.d.ts:7824
```

Transport: HTTP `GET /api/event` (`operationId: event.subscribe`, tag `event`), `200` content type `text/event-stream` (SSE). Backed by `make<A extends {readonly type: string}>(connect) => { subscribe(options?): AsyncIterable<A> }`.

---

## 8. OPENAPI ENDPOINT INDEX

Source: `research/docs-scrape/v2/openapi.json` — OpenAPI **3.1.0**, `info.title = "opencode HttpApi"`, `info.version = "0.0.1"`.

**Totals: 136 operations across 29 tags / 113 paths.**

**Auth:** `security: []` (global), `components.securitySchemes` is **empty**, and every operation declares `security: []` — there is **no security scheme in the spec at all**. The only credentials-ish headers are optional `x-opencode-ticket` on `pty.connect.token` / `persistentPty.connectToken` (a PTY handoff ticket, not API auth). `UnauthorizedErrorEncoded` (401) is still declared on many operations, so auth is enforced outside the spec (local bind/origin check), not by a documented scheme.

**SSE (2):** `GET /api/event` (`event.subscribe`) and `GET /api/experimental/session/{sessionID}/log` (`session.log`), both `200 → text/event-stream`.
**WebSocket:** none in the spec (no `ws`/`socket` paths). PTY/shell streaming is ticket-gated HTTP `connect` endpoints (`pty.connect`, `persistentPty.connect`, `shell.output`).

### agent (2)
```
GET    /api/agent/{agentID}        agent.get
GET    /api/agent                  agent.list
```
### command (1)
```
GET    /api/command                command.list
```
### config (3)
```
GET    /api/config                 config.get
GET    /api/config/shell           config.shells
PATCH  /api/experimental/config    experimental.config.update
```
### credential (3)
```
POST    /api/credential/{credentialID}/activate   credential.activate
DELETE  /api/credential/{credentialID}            credential.remove
PATCH   /api/credential/{credentialID}            credential.update
```
### debug (2)
```
DELETE  /api/debug/location        debug.location.evict
GET     /api/debug/location        debug.location.list
```
### event (1)
```
GET     /api/event                 event.subscribe            [SSE]
```
### filesystem (4)
```
POST    /api/experimental/fs/write experimental.fs.write
GET     /api/fs/find               fs.find
GET     /api/fs/list               fs.list
GET     /api/fs/read/*             fs.read
```
### form (1)
```
GET     /api/form                  form.list
```
### generate (1)
```
POST    /api/experimental/generate experimental.generate.text
```
### integration (11)
```
POST    /api/experimental/integration/wellknown                     experimental.integration.wellknown.add
DELETE  /api/integration/{integrationID}/connect/command/{attemptID} integration.command.cancel
POST    /api/integration/{integrationID}/connect/command            integration.command.connect
GET     /api/integration/{integrationID}/connect/command/{attemptID} integration.command.status
POST    /api/integration/{integrationID}/connect/key                integration.connect.key
GET     /api/integration/{integrationID}                            integration.get
GET     /api/integration                                            integration.list
DELETE  /api/integration/{integrationID}/connect/oauth/{attemptID}  integration.oauth.cancel
POST    /api/integration/{integrationID}/connect/oauth/{attemptID}/complete integration.oauth.complete
POST    /api/integration/{integrationID}/connect/oauth              integration.oauth.connect
GET     /api/integration/{integrationID}/connect/oauth/{attemptID}  integration.oauth.status
```
### location (2)
```
GET     /api/location               location.get
POST    /api/location/reload        location.reload
```
### mcp (6)
```
PUT     /api/experimental/mcp/{server}                experimental.mcp.add
POST    /api/experimental/mcp/{server}/connect        experimental.mcp.connect
POST    /api/experimental/mcp/{server}/disconnect     experimental.mcp.disconnect
DELETE  /api/experimental/mcp/{server}                experimental.mcp.remove
GET     /api/mcp                                      mcp.list
GET     /api/mcp/resource                             mcp.resource.catalog
```
### migration (1)
```
GET     /api/experimental/migration/v1  experimental.migration.v1.status
```
### model (2)
```
GET     /api/model/default          model.default
GET     /api/model                  model.list
```
### permission (7)
```
GET     /api/permission/request                      permission.request.list
GET     /api/permission/saved                        permission.saved.list
DELETE  /api/permission/saved/{id}                   permission.saved.remove
POST    /api/session/{sessionID}/permission          session.permission.create
GET     /api/session/{sessionID}/permission/{requestID} session.permission.get
GET     /api/session/{sessionID}/permission          session.permission.list
POST    /api/session/{sessionID}/permission/{requestID}/reply  session.permission.reply
```
### persistentPty (11)
```
GET     /api/experimental/persistent-pty/{ptyID}/connect          persistentPty.connect
POST    /api/experimental/persistent-pty/{ptyID}/connect-token    server.experimental.persistentPty.connectToken
POST    /api/experimental/session/{sessionID}/terminal            server.experimental.persistentPty.create
GET     /api/experimental/persistent-pty/{ptyID}                  server.experimental.persistentPty.get
POST    /api/experimental/persistent-pty/handoff                  server.experimental.persistentPty.handoff
GET     /api/experimental/session/{sessionID}/terminal            server.experimental.persistentPty.list
GET     /api/experimental/session/{sessionID}/terminal/read       server.experimental.persistentPty.read
DELETE  /api/experimental/persistent-pty/{ptyID}                  server.experimental.persistentPty.remove
POST    /api/experimental/persistent-pty/shutdown                 server.experimental.persistentPty.shutdown
GET     /api/experimental/persistent-pty/{ptyID}/snapshot         server.experimental.persistentPty.snapshot
PUT     /api/experimental/persistent-pty/{ptyID}                  server.experimental.persistentPty.update
```
### plugin (3)
```
POST    /api/plugin/check           plugin.check
GET     /api/plugin                 plugin.list
POST    /api/plugin/update          plugin.update
```
### project (2)
```
GET     /api/project                project.list
PATCH   /api/project/{projectID}    project.update
```
### provider (2)
```
GET     /api/provider/{providerID}  provider.get
GET     /api/provider               provider.list
```
### pty (7)
```
GET     /api/pty/{ptyID}/connect            pty.connect
POST    /api/pty/{ptyID}/connect-token      pty.connect.token   [header: x-opencode-ticket]
POST    /api/pty                            pty.create
GET     /api/pty/{ptyID}                    pty.get
GET     /api/pty                            pty.list
DELETE  /api/pty/{ptyID}                    pty.remove
PUT     /api/pty/{ptyID}                    pty.update
```
### reference (1)
```
GET     /api/reference             reference.list
```
### rpc (1)
```
POST    /api/rpc/{rpcID}/{method}  rpc.call
```
### server (1)
```
GET     /api/info                  server.info
```
### session (44)
```
GET     /api/experimental/session/{sessionID}/export              experimental.session.export
POST    /api/experimental/session/import                          experimental.session.import
GET     /api/experimental/session/{sessionID}/instructions/entries experimental.session.instructions.entry.list
PUT     /api/experimental/session/{sessionID}/instructions/entries/{key} experimental.session.instructions.entry.put
DELETE  /api/experimental/session/{sessionID}/instructions/entries/{key} experimental.session.instructions.entry.remove
POST    /api/experimental/session/{sessionID}/skill                experimental.session.skill
GET     /api/experimental/session/stats                            experimental.session.stats
POST    /api/experimental/session/{sessionID}/wait                  experimental.session.wait
GET     /api/session/active                                        session.active
POST    /api/session/{sessionID}/background                        session.background
POST    /api/session/{sessionID}/command                           session.command
POST    /api/session/{sessionID}/compact                           session.compact
GET     /api/session/{sessionID}/context                           session.context
POST    /api/session                                               session.create
GET     /api/session/{sessionID}/diff                              session.diff
PUT     /api/session/{sessionID}/environment                       session.environment
POST    /api/session/{sessionID}/fork                              session.fork
DELETE  /api/session/{sessionID}/form/{formID}                     session.form.cancel
POST    /api/session/{sessionID}/form                              session.form.create
GET     /api/session/{sessionID}/form/{formID}                     session.form.get
GET     /api/session/{sessionID}/form                              session.form.list
POST    /api/session/{sessionID}/form/{formID}/reply               session.form.reply
POST    /api/session/{sessionID}/generate                          session.generate
GET     /api/session/{sessionID}                                   session.get
DELETE  /api/session/{sessionID}/inbox/{inboxID}                   session.inbox.cancel
GET     /api/session/{sessionID}/inbox                             session.inbox.list
PATCH   /api/session/{sessionID}/inbox/{inboxID}                   session.inbox.update
POST    /api/session/{sessionID}/interrupt                         session.interrupt
GET     /api/session                                               session.list
GET     /api/experimental/session/{sessionID}/log                  session.log                [SSE]
GET     /api/session/{sessionID}/message/{messageID}               session.message.get
GET     /api/session/{sessionID}/message                           session.message.list
POST    /api/session/{sessionID}/move                              session.move
POST    /api/session/{sessionID}/prompt                            session.prompt
DELETE  /api/session/{sessionID}                                   session.remove
DELETE  /api/session/{sessionID}/revert                            session.revert.clear
POST    /api/session/{sessionID}/revert/commit                     session.revert.commit
POST    /api/session/{sessionID}/revert/stage                      session.revert.stage
POST    /api/session/{sessionID}/shell                             session.shell
POST    /api/session/{sessionID}/agent                             session.switchAgent
POST    /api/session/{sessionID}/model                             session.switchModel
POST    /api/session/{sessionID}/synthetic                         session.synthetic
PATCH   /api/session/{sessionID}                                   session.update
POST    /api/session/{sessionID}/view                              session.view
```
### shell (5)
```
POST    /api/shell                    shell.create
GET     /api/shell/{id}               shell.get
GET     /api/shell                    shell.list
GET     /api/shell/{id}/output        shell.output
DELETE  /api/shell/{id}               shell.remove
```
### skill (1)
```
GET     /api/skill                    skill.list
```
### vcs (5)
```
GET     /api/vcs/base                 vcs.base
GET     /api/vcs/branch               vcs.branch.list
GET     /api/vcs/diff                 vcs.diff
GET     /api/vcs                      vcs.get
GET     /api/vcs/status               vcs.status
```
### websearch (2)
```
GET     /api/websearch/provider       websearch.providers
POST    /api/websearch                websearch.query
```
### worktree (4)
```
POST    /api/worktree                 worktree.create
GET     /api/worktree                 worktree.list
POST    /api/worktree/refresh         worktree.refresh
DELETE  /api/worktree                 worktree.remove
```

### Tag distribution

| Tag | ops | Tag | ops | Tag | ops |
|---|---:|---|---:|---|---:|
| session | 44 | shell | 5 | event | 1 |
| integration | 11 | model | 2 | filesystem | 4 |
| persistentPty | 11 | provider | 2 | debug | 2 |
| permission | 7 | agent | 2 | websearch | 2 |
| pty | 7 | worktree | 2 | location | 2 |
| mcp | 6 | config | 3 | project | 2 |
| vcs | 5 | credential | 3 | plugin | 3 |
| | | | | command / form / generate / migration / reference / rpc / server / skill | 1 each |

(29 tags total; `persistentPty` operationIds are oddly prefixed `server.experimental.*` while their tag is `persistentPty`.)

---

## Appendix — extra findings worth carrying into the advisor

- `@opencode-ai/plugin@1.18.32` **also ships V2 subpath exports**: `./v2/promise` and `./v2/effect`, exposing a *different, smaller* `PluginContext`:
  ```ts
  // research/api-types/opencode-ai-plugin-1.18.32/dist/v2/promise/context.d.ts
  export interface PluginContext {
      readonly options: PluginOptions;
      readonly agent: AgentHooks & Reload;
      readonly aisdk: AISDKHooks;
      readonly catalog: CatalogHooks & Reload;
      readonly command: CommandHooks & Reload;
      readonly integration: IntegrationHooks & Reload;
      readonly plugin: PluginDomain;
      readonly reference: ReferenceHooks & Reload;
      readonly skill: SkillHooks & Reload;
  }
  ```
  This is **not** the same as `@opencode/plugin`'s 24-domain `Context`. Do not conflate them.
- `DeepMutable<A>` (`promise/types.d.ts`) recurses through functions *without* changing them, unwraps `ReadonlyMap`→`Map` and `ReadonlyArray`→array, and strips `readonly`; function-valued members stay functions.
- Every mutating domain exposes `reload: () => Promise<void>` after a `transform`, and `Registration.dispose` to undo.
- `Tool.Options` `codemode`/`pinned` exclusivity (see §3.2) means you cannot pin a tool and explicitly set `codemode: false` in the same `options` object.
