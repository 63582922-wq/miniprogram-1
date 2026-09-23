const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const serviceDir = path.resolve(__dirname, "../report-pdf-service");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, processState) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processState.exitCode !== null) {
      throw new Error(`PDF service exited before health check passed:\n${processState.logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();
      if (response.ok && body.success && body.service === "report-pdf-service") {
        return;
      }
    } catch (_error) {
      // The service may still be binding or Chromium may still be warming up.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for PDF service health:\n${processState.logs.join("")}`);
}

async function readJson(response) {
  const body = await response.json();
  return { response, body };
}

test("local PDF service authenticates, deduplicates, completes and downloads one immutable task", { timeout: 60_000 }, async () => {
  const port = await reservePort();
  const apiKey = `local-test-${crypto.randomBytes(16).toString("hex")}`;
  const jobId = `pdf-${crypto.createHash("sha1").update(`local-pdf-${port}`).digest("hex")}`;
  const tempPdfPath = path.join(os.tmpdir(), `${jobId}.pdf`);
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: serviceDir,
    env: {
      ...process.env,
      PORT: `${port}`,
      PDF_API_KEY: apiKey,
      PDF_TASK_TTL_MS: "60000",
      PDF_TASK_SWEEP_INTERVAL_MS: "60000",
      ...(fs.existsSync(chromePath) ? { PUPPETEER_EXECUTABLE_PATH: chromePath } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const processState = { exitCode: null, logs: [] };
  child.stdout.on("data", (chunk) => processState.logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => processState.logs.push(chunk.toString()));
  child.on("exit", (code) => { processState.exitCode = code; });

  const baseUrl = `http://127.0.0.1:${port}`;
  const payload = {
    jobId,
    title: "隔离测试现场记录报告",
    projectName: "QA-PDF-LOCAL",
    inspectionDate: "20260922",
    companyName: "毫厘智管 · 本地测试",
    inspectorName: "本地测试员",
    publisherName: "本地测试员",
    testLabel: "隔离测试样本 · 不含真实客户资料",
    summary: "用于验证本地 PDF 服务鉴权、去重、任务状态与下载。",
    photos: [],
    items: []
  };
  const authorizedHeaders = {
    "content-type": "application/json",
    "x-api-key": apiKey
  };

  try {
    await waitForHealth(baseUrl, processState);

    const unauthorized = await readJson(await fetch(`${baseUrl}/api/report-pdf/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }));
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.body.success, false);

    const first = await readJson(await fetch(`${baseUrl}/api/report-pdf/tasks`, {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify(payload)
    }));
    assert.equal(first.response.status, 200);
    assert.equal(first.body.success, true);
    assert.equal(first.body.data.taskId, jobId);
    assert.match(first.body.data.status, /^(queued|running|success)$/);

    const duplicate = await readJson(await fetch(`${baseUrl}/api/report-pdf/tasks`, {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify(payload)
    }));
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.data.taskId, first.body.data.taskId);
    assert.equal(duplicate.body.data.createdAt, first.body.data.createdAt);

    let task = duplicate.body.data;
    const deadline = Date.now() + 40_000;
    while (task.status !== "success" && Date.now() < deadline) {
      assert.notEqual(task.status, "failed", task.errorMessage || "PDF task failed");
      await delay(150);
      const status = await readJson(await fetch(`${baseUrl}/api/report-pdf/tasks/${jobId}`, {
        headers: { "x-api-key": apiKey }
      }));
      assert.equal(status.response.status, 200);
      task = status.body.data;
    }
    assert.equal(task.status, "success", `PDF task did not finish:\n${processState.logs.join("")}`);
    assert.ok(task.pdfBytes > 1000);

    const download = await fetch(`${baseUrl}/api/report-pdf/tasks/${jobId}/download`, {
      headers: { "x-api-key": apiKey }
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/pdf");
    assert.match(download.headers.get("content-disposition") || "", /QA-PDF-LOCAL20260922\.pdf/);
    const pdf = Buffer.from(await download.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.equal(pdf.length, task.pdfBytes);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(3000)
      ]);
    }
    await fs.promises.unlink(tempPdfPath).catch(() => {});
  }
});
