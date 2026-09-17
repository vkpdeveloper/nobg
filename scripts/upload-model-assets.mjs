// Upload .model-assets/ to the R2 bucket. Reads credentials from the gitignored
// .env.r2.local; never prints secret values.
// bun scripts/upload-model-assets.mjs [--assets-dir=.model-assets]
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join, relative } from "node:path";

const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const assetsDir = resolve(option("assets-dir") ?? ".model-assets");
const aws = existsSync("/usr/bin/aws") ? "/usr/bin/aws" : "aws";
const CACHE_CONTROL = "public, max-age=31536000, immutable, no-transform";
const CONTENT_TYPES = {
  ".gz": "application/gzip",
  ".json": "application/json",
  ".txt": "text/plain",
};

const envFile = await readFile(resolve(".env.r2.local"), "utf8");
const env = { ...process.env };
for (const line of envFile.split("\n")) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
}
for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "R2_BUCKET_NAME"]) {
  if (!env[name]) throw new Error(`.env.r2.local is missing ${name}`);
}
env.AWS_ACCESS_KEY_ID = env.R2_ACCESS_KEY_ID;
env.AWS_SECRET_ACCESS_KEY = env.R2_SECRET_ACCESS_KEY;
// R2 rejects real AWS region names that a local ~/.aws config may set.
env.AWS_DEFAULT_REGION = "auto";
env.AWS_REGION = "auto";

const run = (args) => execFileSync(aws, args, { env, stdio: ["ignore", "pipe", "pipe"] });
const exists = (key) => {
  try {
    run(["s3api", "head-object", "--bucket", env.R2_BUCKET_NAME, "--key", key, "--endpoint-url", env.R2_ENDPOINT]);
    return true;
  } catch {
    return false;
  }
};

const files = [];
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
};
await walk(assetsDir);

// Publish each manifest last so a bundle is never visible half-uploaded.
files.sort((a, b) => Number(a.endsWith("manifest.json")) - Number(b.endsWith("manifest.json")));

let uploaded = 0;
let skipped = 0;
for (const file of files) {
  const key = relative(assetsDir, file).split("\\").join("/");
  const ext = file.slice(file.lastIndexOf("."));
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) throw new Error(`No content type mapping for ${file}`);
  if (exists(key)) {
    skipped++;
    continue;
  }
  // Gzip objects carry no Content-Encoding; the downloader decompresses them.
  run(["s3api", "put-object", "--bucket", env.R2_BUCKET_NAME, "--key", key,
    "--body", file, "--content-type", contentType, "--cache-control", CACHE_CONTROL,
    "--endpoint-url", env.R2_ENDPOINT]);
  uploaded++;
  console.log(`uploaded ${key}`);
}
console.log(JSON.stringify({ uploaded, skipped, total: files.length }));
