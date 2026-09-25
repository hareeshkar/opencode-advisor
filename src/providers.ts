/**
 * Direct advisor HTTP clients (V1 adapter / standalone use).
 *
 * The V2 adapter does NOT use this file — it routes through the host's
 * provider registry (`ctx.generate.text`), inheriting the user's configured
 * credentials, proxies and catalog. These clients exist because V1 has no
 * equivalent primitive and because a provider-agnostic plugin must not
 * depend on any single vendor SDK.
 *
 * Wire formats: Anthropic Messages API and OpenAI-compatible chat
 * completions — the two shapes that cover effectively every provider
 * (including DeepSeek, GLM, Llama serving, Ollama, vLLM, gateways…).
 */

import type { AdvisorSource } from "./types.js"

const USER_AGENT = "opencode-advisor/0.1.0"

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "")
  return `${b}${path}`
}

interface HttpResult {
  status: number
  body: string
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<HttpResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`HTTP timeout after ${timeoutMs}ms`)), timeoutMs)
  const onOuterAbort = () => controller.abort(signal.reason)
  if (signal.aborted) onOuterAbort()
  else signal.addEventListener("abort", onOuterAbort, { once: true })
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT, ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    return { status: res.status, body: text }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onOuterAbort)
  }
}

function requireKey(src: AdvisorSource): string {
  const key = process.env[src.apiKeyEnv]
  if (!key || key.trim() === "") {
    throw new Error(`advisor source not configured: env ${src.apiKeyEnv} is unset (set it to use ${src.kind} at ${src.baseURL})`)
  }
  return key.trim()
}

function parseJson(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    throw new Error(`advisor provider returned non-JSON (HTTP body: ${body.slice(0, 200)})`)
  }
}

async function callWithRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: HttpResult
    try {
      res = await postJson(url, headers, body, timeoutMs, signal)
    } catch (err) {
      lastErr = err
      throw err
    }
    if (res.status >= 200 && res.status < 300) return parseJson(res.body)
    const retryable = res.status === 429 || res.status >= 500
    const detail = `HTTP ${res.status} from ${url}: ${res.body.slice(0, 300)}`
    if (retryable && attempt === 1) {
      await new Promise((r) => setTimeout(r, 1_500))
      continue
    }
    throw new Error(detail)
  }
  throw new Error(`advisor provider failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}

function textFromAnthropicContent(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .filter((b): b is { type: string; text?: unknown } => typeof b === "object" && b !== null)
    .filter((b) => b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n")
    .trim()
}

/** Anthropic Messages API. max_tokens ≥1024 is the documented advisor-tool minimum. */
async function callAnthropic(src: AdvisorSource, prompt: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const key = requireKey(src)
  const url = /\/v\d+$/.test(src.baseURL.replace(/\/+$/, "")) ? joinUrl(src.baseURL, "/messages") : joinUrl(src.baseURL, "/v1/messages")
  const headers: Record<string, string> = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    ...src.extraHeaders,
  }
  const json = await callWithRetry(
    url,
    headers,
    { model: src.model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] },
    timeoutMs,
    signal,
  )
  const text = textFromAnthropicContent(json.content)
  if (!text) throw new Error(`anthropic advisor returned no text blocks: ${JSON.stringify(json).slice(0, 200)}`)
  return text
}

/** OpenAI-compatible chat completions (OpenAI, DeepSeek, GLM, Ollama, vLLM, gateways…). */
async function callOpenAICompatible(src: AdvisorSource, prompt: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const key = requireKey(src)
  const base = src.baseURL.replace(/\/+$/, "")
  const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    ...src.extraHeaders,
  }
  const json = await callWithRetry(
    url,
    headers,
    { model: src.model, messages: [{ role: "user", content: prompt }], max_tokens: 768 },
    timeoutMs,
    signal,
  )
  const choices = json.choices
  const message = Array.isArray(choices) && choices[0] && typeof choices[0] === "object" ? (choices[0] as { message?: { content?: unknown } }).message : undefined
  const text = typeof message?.content === "string" ? message.content.trim() : ""
  if (!text) throw new Error(`openai-compatible advisor returned no message content: ${JSON.stringify(json).slice(0, 200)}`)
  return text
}

export function callAdvisorProvider(src: AdvisorSource, prompt: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  return src.kind === "anthropic" ? callAnthropic(src, prompt, timeoutMs, signal) : callOpenAICompatible(src, prompt, timeoutMs, signal)
}
