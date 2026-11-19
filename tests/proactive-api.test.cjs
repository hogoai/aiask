const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const ts = require("typescript");
const previousLoader = require.extensions[".ts"];
require.extensions[".ts"] = (module, path) => module._compile(ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, path);
const configPath = require.resolve("../src/lib/supabase/config.ts");
require.cache[configPath] = { id: configPath, loaded: true, exports: { isSupabaseConfigured: () => true } };
const authPath = require.resolve("../src/lib/supabase/server.ts");
require.cache[authPath] = { id: authPath, loaded: true, exports: { createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: { id: "verified-b" } }, error: null }) },
  from: () => assert.fail("An account mismatch must be rejected before all conversation writes"),
}) } };
const adapterPath = require.resolve("../src/lib/ai/openai.ts");
require.cache[adapterPath] = { id: adapterPath, loaded: true, exports: { runPartnerWithOpenAI: () => assert.fail("No model call for a stale account") } };
const { POST } = require("../src/app/api/ai/run/route.ts");
if (previousLoader) require.extensions[".ts"] = previousLoader;
else delete require.extensions[".ts"];

async function run(body) { return POST(new Request("http://localhost/api/ai/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); }
test("Coach handoff rejects a changed account before any history or model operation", async () => {
  const result = await run({ partnerRole: "guide", userMessage: "Help with this reviewed task", expectedUserId: "verified-a", locale: "en" });
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error.code, "account_changed");
});
test("Coach rejects invalid expected-account values without accepting them as identity", async () => {
  const result = await run({ partnerRole: "guide", userMessage: "Help with this reviewed task", expectedUserId: { id: "verified-b" }, locale: "en" });
  assert.equal(result.status, 400);
});
