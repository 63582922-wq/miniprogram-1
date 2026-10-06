const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cloudRoot = path.join(root, "cloudfunctions");
const clientServices = path.join(root, "miniprogram", "services");
const productionFunctions = ["ai", "auth", "inspection", "project", "report", "settings", "speech"];

function jsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(directory, entry.name));
}

test("each client-invoked cloud function has a complete isolated deploy package", () => {
  const invoked = new Set();
  for (const file of jsFiles(clientServices)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/callCloud\(\s*["']([a-z][a-z0-9_-]*)["']/g)) {
      invoked.add(match[1]);
    }
  }
  assert.deepEqual([...invoked].sort(), [...productionFunctions].sort());

  for (const name of productionFunctions) {
    const directory = path.join(cloudRoot, name);
    const manifestPath = path.join(directory, "package.json");
    const lockPath = path.join(directory, "package-lock.json");
    assert.ok(fs.existsSync(path.join(directory, "index.js")), `${name}: missing entry point`);
    assert.ok(fs.existsSync(manifestPath), `${name}: missing isolated package.json`);
    assert.ok(fs.existsSync(lockPath), `${name}: missing lockfile`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(manifest.name, name, `${name}: package name must match cloud function`);
    assert.equal(manifest.main, "index.js", `${name}: unexpected entry point`);
    assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies, `${name}: manifest/lock dependencies differ`);

    for (const file of jsFiles(directory)) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
        const requiredPath = path.resolve(path.dirname(file), match[1]);
        assert.ok(fs.existsSync(`${requiredPath}.js`) || fs.existsSync(path.join(requiredPath, "index.js")),
          `${name}: ${path.relative(directory, file)} requires missing local module ${match[1]}`);
      }
    }
  }
});

test("deployment-only setupdb is not part of the client production call graph", () => {
  for (const file of jsFiles(clientServices)) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /callCloud\(\s*["']setupdb["']/,
      "database initialization must never be bundled as a routine client deployment");
  }
});
