import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runAction(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["github-action.mjs"], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("requests the exact audience and publishes one file without a stored secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "artifact-action-"));
  const file = join(dir, "report.txt");
  const output = join(dir, "output.txt");
  await writeFile(file, "action bytes");
  await writeFile(output, "");
  let publishSeen = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname === "/oidc") {
      assert.equal(req.headers.authorization, "Bearer github-runtime-token");
      assert.equal(url.searchParams.get("audience"), `http://127.0.0.1:${server.address().port}/api/github-actions`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: "short-lived-oidc-jwt" }));
      return;
    }
    if (url.pathname === "/api/github-actions/publish/test-server/release-report") {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer short-lived-oidc-jwt");
      assert.equal(url.searchParams.get("filename"), "report.txt");
      let requestBody = "";
      for await (const chunk of req) requestBody += chunk;
      assert.equal(requestBody, "action bytes");
      publishSeen = true;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        target: { public_url: "https://raft-artifacts.com/p/test-server/release-report" },
        artifact: {
          id: "artifact-1",
          public_url: "https://raft-artifacts.com/a/token",
          sha256: "abc123",
        },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const port = server.address().port;
    const result = await runAction({
      INPUT_TARGET: "test-server/release-report",
      INPUT_FILE: file,
      INPUT_ENDPOINT: `http://127.0.0.1:${port}`,
      ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/oidc?x=1`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-runtime-token",
      GITHUB_EVENT_NAME: "push",
      GITHUB_OUTPUT: output,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(publishSeen, true);
    assert.equal(
      await readFile(output, "utf8"),
      "artifact-url=https://raft-artifacts.com/p/test-server/release-report\n" +
        "immutable-artifact-url=https://raft-artifacts.com/a/token\n" +
        "artifact-id=artifact-1\n" +
        "sha256=abc123\n",
    );
    assert.match(result.stdout, /Published https:\/\/raft-artifacts\.com\/p\/test-server\/release-report/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails before requesting OIDC on pull-request-family events", async () => {
  const result = await runAction({
    INPUT_TARGET: "test-server/release-report",
    INPUT_FILE: "/does/not/matter",
    INPUT_ENDPOINT: "https://raft-artifacts.com",
    GITHUB_EVENT_NAME: "pull_request_target",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /disabled for untrusted event pull_request_target/);
  assert.doesNotMatch(result.stderr, /ACTIONS_ID_TOKEN_REQUEST/);
});

test("rejects a non-HTTPS remote endpoint before requesting OIDC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "artifact-action-"));
  const file = join(dir, "report.txt");
  await writeFile(file, "action bytes");
  try {
    const result = await runAction({
      INPUT_TARGET: "test-server/release-report",
      INPUT_FILE: file,
      INPUT_ENDPOINT: "http://example.com",
      GITHUB_EVENT_NAME: "push",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /endpoint must use HTTPS/);
    assert.doesNotMatch(result.stderr, /ACTIONS_ID_TOKEN_REQUEST/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
