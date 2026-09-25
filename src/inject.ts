/**
 * Native request-body system injection.
 *
 * PROVEN CONTEXT: on OpenCode v2.0.16, mutations to the `context` hook's
 * `event.system` array are NOT delivered to the provider request (verified
 * with an in-band canary token that never appeared). The working channel is
 * the native `http.request` hook — the same one that successfully attaches
 * provider routing headers — so transient guidance is injected by rewriting
 * the outgoing JSON body.
 *
 * Protocol detection (decision tree, first match wins):
 *   1. `instructions` present or `input` array   → OpenAI Responses
 *   2. `system` present (string | blocks | null) → Anthropic Messages
 *   3. `messages` with a system-role entry       → chat-completions family
 *   4. `messages` only, with `max_tokens`        → Anthropic Messages
 *   5. `messages` only, without `max_tokens`     → chat-completions family
 *
 * Every injection is idempotent per body: if the marker text is already
 * present, the body is returned unchanged (hosts retry requests; rewrites
 * must never stack).
 */

export interface InjectionResult {
  body: string
  format: "anthropic" | "responses" | "chat"
}

/** Prefix that makes injections idempotent and identifiable in the body. */
export const INJECTION_SENTINEL = "<<advisor-plugin>>"

/** Tool names advertised in a request body (chat tools[].function.name or
 *  anthropic tools[].name). Used by compliance diagnostics to settle whether
 *  the advisor tool was actually offered to the model. */
export function extractToolNames(bodyText: string): string[] {
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>
    const tools = body.tools
    if (!Array.isArray(tools)) return []
    const names: string[] = []
    for (const t of tools) {
      if (t === null || typeof t !== "object") continue
      const rec = t as Record<string, unknown>
      const fn = rec.function as Record<string, unknown> | undefined
      const name = typeof fn?.name === "string" ? fn.name : typeof rec.name === "string" ? rec.name : ""
      if (name !== "") names.push(name)
    }
    return names
  } catch {
    return []
  }
}

export function replaceSystemInBody(
  bodyText: string,
  texts: readonly string[],
  marker: string,
): InjectionResult | undefined {
  if (texts.length === 0) return undefined
  if (bodyText.includes(marker)) return undefined // already injected — idempotent
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const body = parsed as Record<string, unknown>
  const block = `${marker}\n${texts.join("\n\n")}`

  // 1) OpenAI Responses
  if ("instructions" in body || Array.isArray(body.input)) {
    const ins = body.instructions
    body.instructions = typeof ins === "string" && ins !== "" ? `${ins}\n\n${block}` : block
    return { body: JSON.stringify(body), format: "responses" }
  }

  // 2) Anthropic with an explicit system field
  if ("system" in body) {
    const sys = body.system
    if (typeof sys === "string") body.system = sys === "" ? block : `${sys}\n\n${block}`
    else if (Array.isArray(sys)) body.system = [...sys, { type: "text", text: block }]
    else body.system = [{ type: "text", text: block }]
    return { body: JSON.stringify(body), format: "anthropic" }
  }

  // 3-5) messages-based bodies
  if (Array.isArray(body.messages)) {
    const messages = body.messages as Array<Record<string, unknown>>
    const sysIdx = messages.findIndex((m) => m !== null && typeof m === "object" && m.role === "system")
    if (sysIdx >= 0) {
      // Append as a TRAILING system message: mid-system injections get
      // diluted in long transcripts (observed compliance failure), while a
      // late instruction is the most salient safe channel.
      messages.push({ role: "system", content: block })
      return { body: JSON.stringify(body), format: "chat" }
    }
    const looksAnthropic = "max_tokens" in body
    if (looksAnthropic) {
      body.system = [{ type: "text", text: block }]
      return { body: JSON.stringify(body), format: "anthropic" }
    }
    messages.unshift({ role: "system", content: block })
    return { body: JSON.stringify(body), format: "chat" }
  }

  return undefined
}
