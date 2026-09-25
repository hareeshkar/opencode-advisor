/**
 * opencode-advisor — CLI/TUI plugin (native settings picker).
 *
 * Registered as a sibling `tui.js` next to the server bundle; the CLI
 * resolves it by filename convention from the plugin directory. Provides:
 *
 *   /advisor-settings  → native dialog.select picker (like /models):
 *                        advisor model from the live catalog (current first),
 *                        then variant/thinking effort, saved via the server
 *                        plugin's RPC (immediate, no restart, no tokens).
 *
 * The server plugin suppresses its executor-based settings flow once this
 * plugin claims the UI (storage key tui:claimed), so there is exactly one
 * /advisor-settings entry in the slash list.
 *
 * Runtime import of @opencode/plugin/tui is resolved by OpenCode itself
 * (documented behavior); the bundle keeps it external.
 */

import { Plugin } from "@opencode/plugin/tui"

/** Same portable definition the server registered — identical schemas so the
 *  typed client serializes calls into the server's {input: ...} envelope. */
const refOut = {
  type: "object",
  properties: { providerID: { type: "string" }, id: { type: "string" }, variant: { type: "string" } },
  required: ["providerID", "id"],
  additionalProperties: false,
} as const

const emptyIn = { type: "object", properties: {}, additionalProperties: false } as const

const AdvisorRpc = {
  id: "opencode-advisor",
  methods: {
    get: {
      input: emptyIn,
      output: {
        type: "object",
        properties: {
          providerID: { type: "string" },
          id: { type: "string" },
          variant: { type: "string" },
          source: { type: "string" },
        },
        required: ["providerID", "id", "source"],
        additionalProperties: false,
      },
    },
    set: {
      input: {
        type: "object",
        properties: { providerID: { type: "string" }, id: { type: "string" }, variant: { type: "string" } },
        required: ["providerID", "id"],
        additionalProperties: false,
      },
      output: refOut,
    },
    reset: { input: emptyIn, output: refOut },
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

    // Claim the settings UI (single slash entry) — best effort.
    try {
      await rpc.claim({})
    } catch {
      /* older server or RPC unavailable — the server flow still works */
    }

    const location = context.location ?? context.data.location.default()

    const loadModels = async (): Promise<ModelLike[]> => {
      try {
        await context.data.location.model.sync(location)
      } catch {
        /* cached list may still be usable */
      }
      const models = context.data.location.model.list(location) ?? []
      return (models as ModelLike[]).filter((m) => m.providerID !== "" && m.modelID !== "")
    }

    const currentRef = async (): Promise<{ providerID: string; id: string; variant?: string } | null> => {
      try {
        const res = await rpc.get({})
        const ref = (res as { output?: { providerID?: string; id?: string; variant?: string } })?.output ?? (res as any)
        if (ref && typeof ref.providerID === "string" && typeof ref.id === "string" && ref.providerID !== "") {
          return { providerID: ref.providerID, id: ref.id, ...(typeof ref.variant === "string" ? { variant: ref.variant } : {}) }
        }
      } catch {
        /* unconfigured or older server */
      }
      return null
    }

    const runSettings = async (): Promise<void> => {
      const models = await loadModels()
      if (models.length === 0) {
        context.ui.toast.show({ message: "No models available to choose from.", variant: "error" })
        return
      }
      const current = await currentRef()
      const currentKey = current ? `${current.providerID}/${current.id}` : ""
      const byKey = new Map(models.map((m) => [`${m.providerID}/${m.modelID}`, m]))

      const options = models.map((m) => ({
        title: `${m.providerID}/${m.modelID}`,
        value: `${m.providerID}/${m.modelID}`,
        description: m.name ?? "",
        category: currentKey === `${m.providerID}/${m.modelID}` ? "Current" : "Models",
      }))
      options.unshift({
        title: "Reset to opencode.json default",
        value: "__reset__",
        description: "Clears the saved pick and returns to the declarative advisor option",
        category: "Actions",
      })

      const chosen = await context.ui.dialog.select({
        title: "Advisor model",
        current: currentKey,
        options,
      })
      if (chosen === undefined || chosen === null) return

      if (chosen === "__reset__") {
        try {
          await rpc.reset({})
          context.ui.toast.show({ message: "Advisor override cleared (using opencode.json default).", variant: "success" })
        } catch {
          context.ui.toast.show({ message: "Could not clear the advisor override.", variant: "error" })
        }
        return
      }

      const model = byKey.get(chosen)
      if (!model) return
      const variants = Array.isArray(model.variants) ? model.variants.map((v) => v.id).filter((v) => v !== "") : []
      let variant: string | undefined
      if (variants.length > 0) {
        const variantOptions = [
          { title: "default", value: "", description: "Model default thinking effort" },
          ...variants.map((v) => ({ title: v, value: v })),
        ]
        const picked = await context.ui.dialog.select({
          title: `Variant for ${chosen}`,
          current: current && `${current.providerID}/${current.id}` === chosen ? current.variant ?? "" : "",
          options: variantOptions,
        })
        if (picked === undefined || picked === null) return
        variant = picked === "" ? undefined : picked
      }

      try {
        const res = await rpc.set({
          providerID: model.providerID,
          id: model.modelID,
          ...(variant ? { variant } : {}),
        })
        const out = (res as { output?: { providerID?: string; id?: string; variant?: string } })?.output ?? (res as any)
        const label = `${out?.providerID ?? model.providerID}/${out?.id ?? model.modelID}${out?.variant ? `#${out.variant}` : ""}`
        context.ui.toast.show({ message: `Advisor set to ${label} — applies to the next consultation.`, variant: "success" })
      } catch {
        context.ui.toast.show({ message: "Failed to save the advisor choice.", variant: "error" })
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
