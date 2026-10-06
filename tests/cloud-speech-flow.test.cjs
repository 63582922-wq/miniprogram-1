const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSpeech({ asrClient, downloadFile, openId = "qa-user", env = {} }) {
  const calls = { downloads: [], asr: [] };
  const cloud = {
    DYNAMIC_CURRENT_ENV: "qa",
    init() {},
    getWXContext: () => ({ OPENID: openId }),
    downloadFile: async (args) => {
      calls.downloads.push(args);
      return { fileContent: Buffer.from("synthetic-audio") };
    }
  };
  if (downloadFile) cloud.downloadFile = downloadFile(calls);

  class AsrClient {
    constructor(config) {
      calls.config = config;
      Object.assign(this, asrClient(calls));
    }
  }

  const filename = path.resolve(__dirname, "../cloudfunctions/speech/index.js");
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    require: (name) => name === "wx-server-sdk"
      ? cloud
      : name === "tencentcloud-sdk-nodejs"
        ? { asr: { v20190614: { Client: AsrClient } } }
        : require(name),
    module,
    exports: module.exports,
    process: { env },
    Buffer,
    URL,
    Date,
    setTimeout: (callback) => { queueMicrotask(callback); return 0; },
    clearTimeout
  }, { filename });

  return { main: module.exports.main, calls };
}

const validFile = "cloud://qa.bucket/speech-input/user/qa-user/voice.mp3";
const credentials = { SPEECH_SECRET_ID: "test-id", SPEECH_SECRET_KEY: "test-key" };

test("speech rejects another user's audio before downloading it", async () => {
  const { main, calls } = loadSpeech({
    env: credentials,
    asrClient: () => ({ SentenceRecognition: async () => assert.fail("ASR must not run") })
  });

  const result = await main({ action: "transcribe", payload: { fileID: "cloud://qa.bucket/speech-input/user/other-user/voice.mp3", duration: 1200 } });

  assert.equal(result.success, false);
  assert.equal(result.error.code, "SpeechFileForbidden");
  assert.equal(calls.downloads.length, 0);
});

test("speech accepts only a flat file in the exact speech-input namespace", async () => {
  const invalidFiles = [
    "cloud://qa.bucket/archive/speech-input/user/qa-user/voice.mp3",
    "cloud://qa.bucket/inspection-audio/user/qa-user/voice.mp3",
    "cloud://qa.bucket/speech-input/user/qa-user/nested/voice.mp3",
    "cloud://qa.bucket/speech-input/user/qa-user/../other-user/voice.mp3"
  ];

  for (const fileID of invalidFiles) {
    const { main, calls } = loadSpeech({
      env: credentials,
      asrClient: () => ({ SentenceRecognition: async () => assert.fail("ASR must not run") })
    });
    const result = await main({ action: "transcribe", payload: { fileID, duration: 1200 } });
    assert.equal(result.success, false, fileID);
    assert.equal(result.error.code, "SpeechFileForbidden", fileID);
    assert.equal(calls.downloads.length, 0, fileID);
  }
});

test("speech sends a short owned recording to sentence recognition and returns text", async () => {
  const { main, calls } = loadSpeech({
    env: credentials,
    asrClient: () => ({
      SentenceRecognition: async (request) => {
        calls.asr.push({ method: "sentence", request });
        return { Result: "客厅木饰面收口需要补胶", RequestId: "req-short" };
      }
    })
  });

  const result = await main({ action: "transcribe", payload: { fileID: validFile, duration: 1800, language: "zh_CN" } });

  assert.equal(result.success, true);
  assert.equal(result.data.text, "客厅木饰面收口需要补胶");
  assert.equal(result.data.mode, "sentence");
  assert.equal(result.data.requestId, "req-short");
  assert.equal(calls.downloads.length, 1);
  assert.equal(calls.asr[0].request.VoiceFormat, "mp3");
  assert.equal(calls.asr[0].request.DataLen, Buffer.byteLength("synthetic-audio"));
  assert.equal(calls.config.credential.secretId, credentials.SPEECH_SECRET_ID);
  assert.equal(calls.config.credential.secretKey, credentials.SPEECH_SECRET_KEY);
});

test("speech falls back to async task polling when sentence recognition fails", async () => {
  const { main, calls } = loadSpeech({
    env: credentials,
    asrClient: () => ({
      SentenceRecognition: async (request) => {
        calls.asr.push({ method: "sentence", request });
        throw Object.assign(new Error("sentence API unavailable"), { code: "InternalError" });
      },
      CreateRecTask: async (request) => {
        calls.asr.push({ method: "create", request });
        return { Data: { TaskId: 73 }, RequestId: "req-create" };
      },
      DescribeTaskStatus: async (request) => {
        calls.asr.push({ method: "poll", request });
        return { Data: { Status: 2, Result: "责任方需复核门套收口" }, RequestId: "req-poll" };
      }
    })
  });

  const result = await main({ action: "transcribe", payload: { fileID: validFile, duration: 3500, language: "zh_CN" } });

  assert.equal(result.success, true);
  assert.equal(result.data.text, "责任方需复核门套收口");
  assert.equal(result.data.mode, "task");
  assert.equal(result.data.requestId, "req-poll");
  assert.deepEqual(calls.asr.map((call) => call.method), ["sentence", "create", "poll"]);
  assert.equal(calls.asr[1].request.DataLen, Buffer.byteLength("synthetic-audio"));
  assert.equal(calls.asr[2].request.TaskId, 73);
});
