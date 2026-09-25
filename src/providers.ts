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
import { PLUGIN_VERSION } from "./types.js"

const USER_AGENT = `opencode-advisor/${PLUGIN_VERSION}`

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
  extraHeaders: Record<string, string> = {},
): Promise<HttpResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`HTTP timeout after ${timeoutMs}ms`)), timeoutMs)
  const onOuterAbort = () => controller.abort(signal.reason)
  if (signal.aborted) onOuterAbort()
  else signal.addEventListener("abort", onOuterAbort, { once: true })
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT, ...extraHeaders, ...headers },
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
    throw new Error(`advisor source not configured: env ${src.apiKeyEnv} is unset`)
  }
  return key.trim()
}

function parseJson(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    throw new Error("advisor provider returned a non-JSON response")
  }
}

/** Origin only — paths and query strings may carry credentials. */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return "[unparseable-url]"
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted")
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Two attempts max, inside ONE wall-clock budget owned by the engine's
 * timeout: the retry only runs when there is provably time left for the
 * backoff plus a second attempt. Error strings carry origin-only URLs and
 * truncated bodies (the engine redacts secrets before surfacing anyway).
 */
const BACKOFF_MS = 1_500

async function callWithRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const start = Date.now()
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = timeoutMs - (Date.now() - start)
    if (remaining <= 0) throw new Error(`advisor provider timed out after ${timeoutMs}ms`)
    let res: HttpResult
    try {
      res = await postJson(url, headers, body, remaining, signal, extraHeaders)
    } catch (err) {
      throw err
    }
    if (res.status >= 200 && res.status < 300) return parseJson(res.body)
    const retryable = res.status === 429 || res.status >= 500
    const detail = `HTTP ${res.status} from ${safeOrigin(url)}: ${res.body.slice(0, 120)}`
    const timeForRetry = Date.now() - start + BACKOFF_MS < timeoutMs
    if (retryable && attempt === 1 && timeForRetry && !signal.aborted) {
      await sleepAbortable(BACKOFF_MS, signal)
      continue
    }
    throw new Error(detail)
  }
  throw new Error("advisor provider failed without a response")
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
async function callAnthropic(
  src: AdvisorSource,
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
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
    extraHeaders,
  )
  const text = textFromAnthropicContent(json.content)
  if (!text) throw new Error("anthropic advisor returned no text blocks")
  return text
}

/** OpenAI-compatible chat completions (OpenAI, DeepSeek, GLM, Ollama, vLLM, gateways…). */
async function callOpenAICompatible(
  src: AdvisorSource,
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
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
    extraHeaders,
  )
  const choices = json.choices
  const message = Array.isArray(choices) && choices[0] && typeof choices[0] === "object" ? (choices[0] as { message?: { content?: unknown } }).message : undefined
  const text = typeof message?.content === "string" ? message.content.trim() : ""
  if (!text) throw new Error("openai-compatible advisor returned no message content")
  return text
}

export function callAdvisorProvider(
  src: AdvisorSource,
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  return src.kind === "anthropic"
    ? callAnthropic(src, prompt, timeoutMs, signal, extraHeaders)
    : callOpenAICompatible(src, prompt, timeoutMs, signal, extraHeaders)
}
