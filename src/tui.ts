/**
 * opencode-advisor — CLI/TUI plugin (native /advisor-settings menu).
 *
 * Registered as a sibling `tui.js` next to the server bundle; the CLI
 * resolves it by filename convention from the plugin directory. Provides:
 *
 *   /advisor-settings → native settings menu, built on the proven sequential
 *   dialog primitives (select / alert / confirm / prompt):
 *
 *     Advisor Settings
 *     ─────────────────────────────
 *     Advisor model — glm-5.3 · high
 *     Preset — Balanced (recommended)
 *     Mode — Review
 *     Limits — 3 consults/task · 90s
 *     ─────────────────────────────
 *     Save changes / Reset all settings… / Cancel
 *
 *   The menu is an EDITOR for the config files (the source of truth): it
 *   loads through the server RPC on open (never stale), accumulates changes
 *   in a draft, and writes atomically on Save. Cancel discards. `Inherit`
 *   removes a key instead of freezing a value.
 *
 * The server plugin suppresses its executor-based settings flow once this
 * plugin claims the UI (storage key tui:claimed), so there is exactly one
 * /advisor-settings entry in the slash list.
 *
 * Runtime import of @opencode/plugin/tui is resolved by OpenCode itself
 * (documented behavior); the bundle keeps it external.
 */

import { Plugin } from "@opencode/plugin/tui"
import { CONFIG_OUTPUT_SCHEMA, CONFIG_SET_INPUT_SCHEMA, runSettingsFlow } from "./settings.js"
import type { AdvisorSettingsView, SettingsModelInfo, SettingsPorts } from "./settings.js"

const emptyIn = { type: "object", properties: {}, additionalProperties: false } as const

/** Identical schemas to the server's registration so the typed client
 *  serializes calls into the server's {input: …} envelope. */
const AdvisorRpc = {
  id: "opencode-advisor",
  methods: {
    get: { input: emptyIn, output: CONFIG_OUTPUT_SCHEMA },
    set: { input: CONFIG_SET_INPUT_SCHEMA, output: CONFIG_OUTPUT_SCHEMA },
    reset: {
      input: { type: "object", properties: { scope: { type: "string" } }, additionalProperties: false },
      output: CONFIG_OUTPUT_SCHEMA,
    },
    "claim": {
      input: emptyIn,
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    },
  },
  events: {},
} as const

type ModelLike = {
  providerID: string
  modelID: string
  name?: string
  variants?: ReadonlyArray<{ id: string }>
}

export default Plugin.define({
  id: "opencode-advisor.tui",
  async setup(context: any) {
    const rpc = context.client.rpc(AdvisorRpc)

    /** RPC responses arrive wrapped as { output } — unwrap defensively. */
    const unwrap = <T,>(res: unknown): T => {
      const out = (res as { output?: unknown })?.output
      return (out ?? res) as T
    }

    const location = context.location ?? context.data.location.default()

    /** The live OpenCode model catalog — same source the model picker uses. */
    const models = async (): Promise<SettingsModelInfo[]> => {
      try {
        await context.data.location.model.sync(location)
      } catch {
        /* cached list may still be usable */
      }
      const list = context.data.location.model.list(location) ?? []
      return (list as ModelLike[])
        .filter((m) => m.providerID !== "" && m.modelID !== "")
        .map((m) => ({
          providerID: m.providerID,
          id: m.modelID,
          ...(m.name ? { name: m.name } : {}),
          variants: Array.isArray(m.variants) ? m.variants.map((v) => v.id).filter((id) => id !== "") : [],
        }))
    }

    const ports: SettingsPorts = {
      load: async () => unwrap<AdvisorSettingsView>(await rpc.get({})),
      save: async (doc) => unwrap<AdvisorSettingsView>(await rpc.set({ doc })),
      select: (request) => context.ui.dialog.select(request),
      alert: (options) => context.ui.dialog.alert(options),
      confirm: (options) =>
        context.ui.dialog.confirm({
          title: options.title,
          message: options.message,
          label: { confirm: options.confirmLabel, cancel: options.cancelLabel },
        }),
      prompt: (options) => context.ui.dialog.prompt(options),
      toast: (message, variant) => context.ui.toast.show({ message, variant }),
      models,
    }

    const runSettings = async (): Promise<void> => {
      try {
        await runSettingsFlow(ports)
      } catch (err) {
        context.ui.toast.show({
          message: `Advisor settings failed: ${err instanceof Error ? err.message : String(err)}`,
          variant: "error",
        })
      }
    }

    // Keymap registration needs the app's Keymap provider mounted, which is
    // only true inside a rendered slot (documented pattern). The UI claim is
    // sent only after the layer registers successfully, so a failed TUI
    // setup never suppresses the server-side settings flow.
    let claimed = false
    const claim = async (): Promise<void> => {
      if (claimed) return
      claimed = true
      try {
        await rpc.claim({})
      } catch {
        /* older server — executor flow remains available */
      }
    }

    context.ui.slot({
      append: "app",
      render: () => {
        try {
          context.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "opencode-advisor.settings",
                title: "Advisor settings",
                group: "Advisor",
                slash: { name: "advisor-settings" },
                run: runSettings,
              },
            ],
            bindings: [],
          }))
          void claim()
        } catch {
          /* provider not mounted yet — the slot re-renders */
        }
        return null
      },
    })

    return () => {}
  },
})
