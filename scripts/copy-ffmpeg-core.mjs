import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/@ffmpeg/core/dist/esm");
const sourceMt = resolve(root, "node_modules/@ffmpeg/core-mt/dist/esm");
const ffmpegSource = resolve(root, "node_modules/@ffmpeg/ffmpeg/dist/esm");
const target = resolve(root, "public/ffmpeg");
const targetMt = resolve(root, "public/ffmpeg-mt");
const workerTarget = resolve(root, "src/ffmpeg-worker");
const publicWorkerTarget = resolve(root, "public/ffmpeg-worker");

await mkdir(target, { recursive: true });
await mkdir(targetMt, { recursive: true });
await mkdir(workerTarget, { recursive: true });
await mkdir(publicWorkerTarget, { recursive: true });
await Promise.all([
  // Single-threaded core
  copyFile(resolve(source, "ffmpeg-core.js"), resolve(target, "ffmpeg-core.js")),
  copyFile(resolve(source, "ffmpeg-core.wasm"), resolve(target, "ffmpeg-core.wasm")),
  // Multi-threaded core
  copyFile(resolve(sourceMt, "ffmpeg-core.js"), resolve(targetMt, "ffmpeg-core.js")),
  copyFile(resolve(sourceMt, "ffmpeg-core.wasm"), resolve(targetMt, "ffmpeg-core.wasm")),
  copyFile(resolve(sourceMt, "ffmpeg-core.worker.js"), resolve(targetMt, "ffmpeg-core.worker.js")),
  // Worker files
  copyFile(resolve(ffmpegSource, "worker.js"), resolve(workerTarget, "worker.js")),
  copyFile(resolve(ffmpegSource, "const.js"), resolve(workerTarget, "const.js")),
  copyFile(resolve(ffmpegSource, "errors.js"), resolve(workerTarget, "errors.js")),
  copyFile(resolve(ffmpegSource, "worker.js"), resolve(publicWorkerTarget, "worker.js")),
  copyFile(resolve(ffmpegSource, "const.js"), resolve(publicWorkerTarget, "const.js")),
  copyFile(resolve(ffmpegSource, "errors.js"), resolve(publicWorkerTarget, "errors.js")),
]);
console.log("Copied FFmpeg core (single + multi-threaded) to public/");
