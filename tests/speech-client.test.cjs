const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSpeechService({ uploadUserFile, callCloud }) {
  const filename = path.resolve(__dirname, "../miniprogram/services/speech.js");
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module,
    exports: module.exports,
    require: (name) => name === "./cloud" ? { uploadUserFile, callCloud } : require(name),
    Error,
    String,
    Array,
    Object,
    RegExp
  }, { filename });
  return module.exports;
}

test("speech retry reuses the uploaded recording after a cloud transcription failure", async () => {
  let uploads = 0;
  const calls = [];
  let failFirst = true;
  const service = loadSpeechService({
    uploadUserFile: async () => { uploads += 1; return "cloud://qa.bucket/speech-input/user/qa/recording.mp3"; },
    callCloud: async (_name, payload) => {
      calls.push(payload.payload.fileID);
      if (failFirst) {
        failFirst = false;
        throw Object.assign(new Error("识别服务暂不可用"), { code: "SpeechTaskTimeout" });
      }
      return { text: "窗台收口需要复核" };
    }
  });

  await assert.rejects(
    () => service.transcribeVoiceFile("/persisted/recording.mp3", { duration: 2300 }),
    (error) => error.fileID === "cloud://qa.bucket/speech-input/user/qa/recording.mp3"
  );
  const result = await service.transcribeVoiceFile("/persisted/recording.mp3", {
    duration: 2300,
    fileID: "cloud://qa.bucket/speech-input/user/qa/recording.mp3"
  });

  assert.equal(result.text, "窗台收口需要复核");
  assert.equal(uploads, 1, "retry should not upload a duplicate recording");
  assert.deepEqual(calls, [
    "cloud://qa.bucket/speech-input/user/qa/recording.mp3",
    "cloud://qa.bucket/speech-input/user/qa/recording.mp3"
  ]);
});

test("empty speech recognition result retains the uploaded file reference for retry", async () => {
  const service = loadSpeechService({
    uploadUserFile: async () => "cloud://qa.bucket/speech-input/user/qa/quiet.mp3",
    callCloud: async () => ({ text: "" })
  });
  await assert.rejects(
    () => service.transcribeVoiceFile("/persisted/quiet.mp3", { duration: 1400 }),
    (error) => error.fileID === "cloud://qa.bucket/speech-input/user/qa/quiet.mp3"
  );
});

function loadCreatePage(transcribeVoiceFile) {
  let config;
  const filename = path.resolve(__dirname, "../miniprogram/pages/inspection/create/index.js");
  const mocks = {
    "../../../services/speech": {
      transcribeVoiceFile,
      mergeSpeechText: (before, next) => [before, next].filter(Boolean).join("\n"),
      formatSpeechError: (error) => ({ message: error.message || "语音转写失败" })
    },
    "../../../services/inspection": {},
    "../../../utils/router": {},
    "../../../utils/async": {},
    "../../../services/inspection-media": {},
    "../../../utils/inspection-draft": {},
    "../../../utils/inspection-model": {},
    "../../../services/cloud-media": {}
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    Page: (definition) => { config = definition; },
    wx: { getRecorderManager: () => ({}), showToast() {} },
    require: (name) => mocks[name] || require(path.resolve(path.dirname(filename), name)),
    console,
    Date,
    Math,
    Promise,
    setTimeout,
    clearTimeout
  }, { filename });
  return {
    ...config,
    data: structuredClone(config.data),
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (!key.includes(".")) { this.data[key] = value; continue; }
        const [root, nested] = key.split(".");
        this.data[root] = { ...this.data[root], [nested]: value };
      }
    }
  };
}

test("failed voice transcription keeps its diagnostic and retries the same local and cloud audio", async () => {
  const requests = [];
  let failFirst = true;
  const page = loadCreatePage(async (_path, options) => {
    requests.push(options);
    if (failFirst) {
      failFirst = false;
      throw Object.assign(new Error("语音识别超时"), {
        code: "SpeechTaskTimeout",
        fileID: "cloud://qa.bucket/speech-input/user/qa/recording.mp3"
      });
    }
    return { text: "门套收口需要复核", fileID: options.fileID };
  });
  page.data.form = { issueDrafts: [{ id: "photo-1", voiceText: "现场补充", voiceFilePath: "/persisted/recording.mp3", voiceDuration: 2300 }] };
  page.persistDraft = () => true;

  await page.handleIssueTranscription("photo-1", "/persisted/recording.mp3", 2300);
  const failed = page.data.form.issueDrafts[0];
  assert.equal(failed.isTranscribing, false);
  assert.match(failed.speechError, /语音识别超时/);
  assert.equal(failed.voiceStorageFileId, "cloud://qa.bucket/speech-input/user/qa/recording.mp3");
  assert.equal(failed.voiceText, "现场补充");

  await page.retryIssueTranscription({ currentTarget: { dataset: { index: 0 } } });
  const recovered = page.data.form.issueDrafts[0];
  assert.equal(recovered.speechError, "");
  assert.equal(recovered.voiceText, "现场补充\n门套收口需要复核");
  assert.equal(requests[1].fileID, "cloud://qa.bucket/speech-input/user/qa/recording.mp3", "retry should reuse the saved cloud audio file");
});
