import { appendFile, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.replace(/^INPUT_/, "").toLowerCase()} is required`);
  return value;
}

const unsafeEvents = new Set(["pull_request", "pull_request_target", "pull_request_review", "merge_group"]);
if (unsafeEvents.has(process.env.GITHUB_EVENT_NAME ?? "")) {
  throw new Error(`Artifact publication is disabled for untrusted event ${process.env.GITHUB_EVENT_NAME}`);
}

const target = required("INPUT_TARGET");
const targetParts = target.split("/");
if (targetParts.length !== 2 || targetParts.some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
  throw new Error("target must be the stable name <server>/<url-name>");
}
const file = resolve(required("INPUT_FILE"));
const endpoint = new URL(required("INPUT_ENDPOINT"));
if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
  throw new Error("endpoint must use HTTPS");
}
endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
const info = await stat(file);
if (!info.isFile()) throw new Error("file must name one regular file");
if (info.size === 0) throw new Error("file is empty");
if (info.size > 10 * 1024 * 1024) throw new Error("GitHub Actions artifacts are limited to 10 MiB");

const idTokenUrl = required("ACTIONS_ID_TOKEN_REQUEST_URL");
const idTokenRequestToken = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
const audience = new URL("/api/github-actions", endpoint).toString();
const tokenUrl = new URL(idTokenUrl);
tokenUrl.searchParams.set("audience", audience);
const tokenResponse = await fetch(tokenUrl, { headers: { authorization: `Bearer ${idTokenRequestToken}` } });
if (!tokenResponse.ok) throw new Error(`GitHub OIDC token request failed (${tokenResponse.status})`);
const tokenBody = await tokenResponse.json();
if (typeof tokenBody.value !== "string" || !tokenBody.value) throw new Error("GitHub OIDC response did not contain a token");

const outputFilename = process.env.INPUT_FILENAME?.trim() || basename(file);
const url = new URL(`/api/github-actions/publish/${targetParts.map(encodeURIComponent).join("/")}`, endpoint);
url.searchParams.set("filename", outputFilename);
url.searchParams.set("title", process.env.INPUT_TITLE?.trim() || outputFilename);
if (process.env.INPUT_CONTENT_TYPE?.trim()) url.searchParams.set("content_type", process.env.INPUT_CONTENT_TYPE.trim());

const response = await fetch(url, {
  method: "POST",
  headers: {
    authorization: `Bearer ${tokenBody.value}`,
    "content-type": process.env.INPUT_CONTENT_TYPE?.trim() || "application/octet-stream",
    "content-length": String(info.size),
  },
  body: await readFile(file),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  const code = body?.error?.code ? `${body.error.code}: ` : "";
  throw new Error(`Artifact Share rejected publication (${response.status}): ${code}${body?.error?.message ?? "unknown error"}`);
}

const artifact = body.artifact;
if (!body.target?.public_url || !artifact?.public_url || !artifact?.id || !artifact?.sha256) {
  throw new Error("Artifact Share returned an incomplete receipt");
}
const output = required("GITHUB_OUTPUT");
await appendFile(output, `artifact-url=${body.target.public_url}\nimmutable-artifact-url=${artifact.public_url}\nartifact-id=${artifact.id}\nsha256=${artifact.sha256}\n`);
console.log(`Published ${body.target.public_url}`);
