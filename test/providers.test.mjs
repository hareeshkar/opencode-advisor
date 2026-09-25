import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createServer } from "node:http"
import { callAdvisorProvider } from "../dist/opencode-advisor.js"

process.env.TEST_ADV_KEY = "test-key-value"

// Modes flip canned routes into failure shapes for retry/error tests.
let flakyOnce = false
let always429 = false
let badJson = false
let emptyContent = false

const server = createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" })
    res.end(typeof obj === "string" ? obj : JSON.stringify(obj))
  }
  const url = req.url ?? ""
  if (url.endsWith("/messages")) {
    return send(200, { content: [{ type: "text", text: "ANTHROPIC_ADVICE" }, { type: "thinking", thinking: "dropped" }] })
  }
  if (url.endsWith("/v1/chat/completions")) {
    if (always429) return send(429, { error: "slow down" })
    if (flakyOnce) {
      flakyOnce = false
      return send(429, { error: "slow down" })
    }
    if (badJson) return send(200, "this is not json{")
    if (emptyContent) return send(200, { choices: [{ message: {} }] })
    return send(200, { choices: [{ message: { content: "OAI_ADVICE" } }] })
  }
  return send(404, { error: "nope" })
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const PORT = server.address().port
after(() => server.close())

const sig = new AbortController().signal
const oai = (baseURL) => ({ kind: "openai-compatible", baseURL, apiKeyEnv: "TEST_ADV_KEY", model: "m" })
const BARE = `http://127.0.0.1:${PORT}`

test("openai-compatible extraction returns message content", async () => {
  assert.equal(await callAdvisorProvider(oai(BARE), "hi", 5000, sig), "OAI_ADVICE")
})

test("anthropic extraction joins text blocks, bare and versioned baseURLs", async () => {
  const bare = { kind: "anthropic", baseURL: BARE, apiKeyEnv: "TEST_ADV_KEY", model: "m" }
  assert.equal(await callAdvisorProvider(bare, "hi", 5000, sig), "ANTHROPIC_ADVICE")
  const versioned = { kind: "anthropic", baseURL: `${BARE}/v1`, apiKeyEnv: "TEST_ADV_KEY", model: "m" }
  assert.equal(await callAdvisorProvider(versioned, "hi", 5000, sig), "ANTHROPIC_ADVICE")
})

test("429 retries once within budget and recovers", async () => {
  flakyOnce = true
  assert.equal(await callAdvisorProvider(oai(BARE), "hi", 20000, sig), "OAI_ADVICE")
})

test("persistent 429 surfaces origin-only error, no path/query leak", async () => {
  always429 = true
  try {
    // Path-ful base with a query secret still routes (suffix join), and the
    // resulting error must carry neither the path nor the secret.
    const src = oai(`${BARE}/custom?api_key=SUPERSECRET`)
    await assert.rejects(callAdvisorProvider(src, "hi", 8000, sig), (err) => {
      assert.ok(err.message.includes("429"), "status preserved")
      assert.ok(!err.message.includes("SUPERSECRET"), "query secret never in message")
      assert.ok(!err.message.includes("custom"), "path dropped, origin only")
      assert.ok(err.message.includes(`http://127.0.0.1:${PORT}`), "origin retained for debugging")
      return true
    })
  } finally {
    always429 = false
  }
})

test("non-JSON body and empty content raise without dumping payloads", async () => {
  badJson = true
  try {
    await assert.rejects(callAdvisorProvider(oai(BARE), "hi", 5000, sig), /non-JSON/)
  } finally {
    badJson = false
  }
  emptyContent = true
  try {
    await assert.rejects(callAdvisorProvider(oai(BARE), "hi", 5000, sig), /no message content/)
  } finally {
    emptyContent = false
  }
})

test("missing key env fails fast with the env name", async () => {
  const src = { kind: "anthropic", baseURL: "http://127.0.0.1:9", apiKeyEnv: "DEFINITELY_UNSET_XYZ", model: "m" }
  await assert.rejects(callAdvisorProvider(src, "hi", 2000, sig), /DEFINITELY_UNSET_XYZ/)
})

test("connection refused fails fast, no retry storm", async () => {
  const slow = { kind: "anthropic", baseURL: "http://127.0.0.1:9", apiKeyEnv: "TEST_ADV_KEY", model: "m" }
  const t0 = Date.now()
  await assert.rejects(callAdvisorProvider(slow, "hi", 800, sig))
  assert.ok(Date.now() - t0 < 5000, "fails fast on connection refused")
})
