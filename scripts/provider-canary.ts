const envText = await Bun.file(".env").text().catch(() => "");
const bootstrapKey = envText.match(/^BOOTSTRAP_PROXY_API_KEY=(.+)$/m)?.[1]?.trim();
const apiKey = Bun.env.CARTETHYIA_CANARY_API_KEY ?? Bun.env.BOOTSTRAP_PROXY_API_KEY ?? bootstrapKey;
const model = Bun.env.CARTETHYIA_CANARY_MODEL ?? "opencodeft/mimo-v2.5-free";
const url = Bun.env.CARTETHYIA_CANARY_URL ?? "http://127.0.0.1:12800/v1/chat/completions";
if (!apiKey) throw new Error("Set CARTETHYIA_CANARY_API_KEY or BOOTSTRAP_PROXY_API_KEY to run the real provider canary");

const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": apiKey },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: canary-ok" }], max_tokens: 16 }),
  signal: AbortSignal.timeout(30_000),
});
const body = await response.text();
if (!response.ok) throw new Error(`provider canary failed with HTTP ${response.status}`);
if (!body.toLowerCase().includes("canary-ok")) throw new Error("provider canary response did not contain the expected marker");
console.log(`provider canary passed: ${model}`);
