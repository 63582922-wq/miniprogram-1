const { test } = require("node:test");
const assert = require("node:assert/strict");
const { harness } = require("./cloud-harness.cjs");

function loadSpeech(env) {
  const client = class {};
  const h = harness();
  const main = h.load("speech", {
    env,
    modules: {
      "tencentcloud-sdk-nodejs": { asr: { v20190614: { Client: client } } }
    }
  });
  return { h, main };
}

test("speech diagnose recognizes Tencent console SecretId/SecretKey casing without exposing values", async () => {
  const { main } = loadSpeech({ SecretId: "id-value", SecretKey: "key-value" });
  const response = await main({ action: "diagnose" });
  assert.equal(response.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.data.config)), {
    hasSpeechSecretId: true,
    hasSpeechSecretKey: true,
    region: "ap-guangzhou"
  });
  assert.equal(JSON.stringify(response).includes("id-value"), false);
  assert.equal(JSON.stringify(response).includes("key-value"), false);
});

test("speech diagnose retains documented uppercase variable names", async () => {
  const { main } = loadSpeech({ SPEECH_SECRET_ID: "id-value", SPEECH_SECRET_KEY: "key-value" });
  const response = await main({ action: "diagnose" });
  assert.equal(response.success, true);
  assert.equal(response.data.config.hasSpeechSecretId, true);
  assert.equal(response.data.config.hasSpeechSecretKey, true);
});

test("speech diagnose reports missing credentials without leaking partial configuration", async () => {
  const { main } = loadSpeech({ SecretId: "id-value" });
  const response = await main({ action: "diagnose" });
  assert.equal(response.success, true);
  assert.equal(response.data.config.hasSpeechSecretId, true);
  assert.equal(response.data.config.hasSpeechSecretKey, false);
  assert.equal(JSON.stringify(response).includes("id-value"), false);
});
