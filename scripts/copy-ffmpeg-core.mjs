import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ffmpegSource = resolve(root, "node_modules/@ffmpeg/ffmpeg/dist/esm");
const workerTarget = resolve(root, "src/ffmpeg-worker");

// We no longer copy the giant 31MB wasm files to public/ because Cloudflare limits assets to 25MB.
// We only copy the local worker scripts needed by Vite for development.
await mkdir(workerTarget, { recursive: true });
await Promise.all([
  copyFile(resolve(ffmpegSource, "worker.js"), resolve(workerTarget, "worker.js")),
  copyFile(resolve(ffmpegSource, "const.js"), resolve(workerTarget, "const.js")),
  copyFile(resolve(ffmpegSource, "errors.js"), resolve(workerTarget, "errors.js")),
]);
console.log("Copied local worker scripts. (WASM files will be loaded via CDN to bypass Cloudflare 25MB limit)");
