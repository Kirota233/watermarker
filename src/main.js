import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import "./style.css";

const VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
]);
const watermarkUrl = "/watermark.png";

/* ---- Detect multi-thread support ---- */
const canUseMT = typeof SharedArrayBuffer !== "undefined";

const app = document.querySelector("#app");
app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">本地视频工具</p>
      <h1>一起加样片水印吧！</h1>
      <p class="subtitle">视频在你的浏览器本地处理，不上传服务器。</p>
    </section>
    <section class="panel">
      <label class="drop-zone" id="drop-zone" for="video-input">
        <input id="video-input" type="file" accept="video/*" multiple />
        <span class="drop-icon">＋</span>
        <strong>拖放视频到这里</strong>
        <span>或点击选择视频，可一次处理多个文件</span>
      </label>
      <div class="file-area">
        <div class="section-heading">
          <span>待处理视频</span>
          <button id="clear-button" class="text-button" type="button">清空</button>
        </div>
        <ul id="file-list" class="file-list">
          <li class="empty">还没有选择视频</li>
        </ul>
      </div>
      <div class="action-row">
        <button id="start-button" class="primary-button" type="button" disabled>开始处理</button>
        <div class="status-wrap">
          <div class="status" id="status">等待选择视频</div>
          <div class="progress"><div id="progress-bar"></div></div>
        </div>
      </div>
      <p class="note">
        模式：<strong>${canUseMT ? "⚡ 多线程加速" : "单线程"}</strong>
        &nbsp;|&nbsp; 输出文件名为"原文件名样片"，保存到浏览器的下载目录。水印会强制拉伸到每个视频的完整分辨率。
      </p>
    </section>
    <p class="privacy">本页面只负责提供工具。视频、音频和处理结果均留在本机浏览器中。</p>
  </main>
`;

let ffmpeg = new FFmpeg();
const files = [];
const input = document.querySelector("#video-input");
const dropZone = document.querySelector("#drop-zone");
const fileList = document.querySelector("#file-list");
const clearButton = document.querySelector("#clear-button");
const startButton = document.querySelector("#start-button");
const status = document.querySelector("#status");
const progressBar = document.querySelector("#progress-bar");

function isVideo(file) {
  return VIDEO_TYPES.has(file.type) || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name);
}

function addFiles(newFiles) {
  for (const file of newFiles) {
    if (isVideo(file) && !files.some((item) => item.name === file.name && item.size === file.size)) {
      files.push(file);
    }
  }
  renderFiles();
}

function renderFiles() {
  fileList.replaceChildren();
  if (!files.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "还没有选择视频";
    fileList.append(empty);
  } else {
    files.forEach((file, index) => {
      const item = document.createElement("li");
      item.innerHTML = `<span>${file.name}</span><button type="button" aria-label="移除 ${file.name}">移除</button>`;
      item.querySelector("button").addEventListener("click", () => {
        files.splice(index, 1);
        renderFiles();
      });
      fileList.append(item);
    });
  }
  startButton.disabled = !files.length;
  status.textContent = files.length ? `已选择 ${files.length} 个视频` : "等待选择视频";
}

function setProgress(value) {
  progressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

/* ---- Build CDN source list based on multi-thread capability ---- */
function getSources() {
  if (canUseMT) {
    return [
      {
        name: "国内 npm 镜像 (多线程)",
        core: "https://npm.elemecdn.com/@ffmpeg/core-mt@0.12.10/dist/esm/ffmpeg-core.js",
        wasm: "https://npm.elemecdn.com/@ffmpeg/core-mt@0.12.10/dist/esm/ffmpeg-core.wasm",
        worker: "https://npm.elemecdn.com/@ffmpeg/core-mt@0.12.10/dist/esm/ffmpeg-core.worker.js",
      },
      {
        name: "jsDelivr (多线程)",
        core: "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm/ffmpeg-core.js",
        wasm: "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm/ffmpeg-core.wasm",
        worker: "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm/ffmpeg-core.worker.js",
      },
    ];
  }
  return [
    {
      name: "国内 npm 镜像 (单线程)",
      core: "https://npm.elemecdn.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js",
      wasm: "https://npm.elemecdn.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm",
    },
    {
      name: "jsDelivr (单线程)",
      core: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js",
      wasm: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm",
    },
  ];
}

async function loadFFmpeg() {
  if (ffmpeg.loaded) return;
  status.textContent = `首次使用，正在加载${canUseMT ? "多线程" : ""}FFmpeg…`;
  const sources = getSources();
  let lastError;
  for (const source of sources) {
    try {
      status.textContent = `正在加载 FFmpeg（${source.name}）…`;
      let loadOptions;
      if (source.direct) {
        loadOptions = {
          coreURL: source.core,
          wasmURL: source.wasm,
          classWorkerURL: "/ffmpeg-worker/worker.js",
        };
        if (source.workerURL) loadOptions.workerURL = source.workerURL;
      } else {
        loadOptions = {
          coreURL: await toBlobURL(source.core, "text/javascript"),
          wasmURL: await toBlobURL(source.wasm, "application/wasm"),
        };
        if (source.worker) {
          loadOptions.workerURL = await toBlobURL(source.worker, "text/javascript");
        }
      }
      await Promise.race([
        ffmpeg.load(loadOptions),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("加载超时")), 30000),
        ),
      ]);
      break;
    } catch (error) {
      lastError = error;
      console.warn(`FFmpeg source failed: ${source.name}`, error);
      ffmpeg.terminate();
      ffmpeg = new FFmpeg();
    }
  }
  if (!ffmpeg.loaded) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError || "");
    throw new Error(`FFmpeg 核心文件加载失败。请刷新页面重试。${detail ? ` ${detail}` : ""}`);
  }
  ffmpeg.on("progress", ({ progress }) => setProgress(progress * 100));
}

let watermarkCached = false;

async function processFile(file, index, total) {
  const t0 = performance.now();
  const inputName = `input_${index}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const outputName = `output_${index}.mp4`;

  await ffmpeg.writeFile(inputName, await fetchFile(file));

  // Only write watermark once — it persists in the virtual FS
  if (!watermarkCached) {
    await ffmpeg.writeFile("watermark.png", await fetchFile(watermarkUrl));
    watermarkCached = true;
  }

  const execArgs = [
    "-i", inputName,
    "-loop", "1",
    "-i", "watermark.png",
    "-filter_complex",
    "[1:v][0:v]scale2ref=w=main_w:h=main_h[wm][video];[video][wm]overlay=0:0:shortest=1[outv]",
    "-map", "[outv]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-tune", "fastdecode",
    "-c:a", "aac",
    "-shortest",
  ];

  // Multi-thread encoding flags
  if (canUseMT) {
    const threadCount = navigator.hardwareConcurrency ? navigator.hardwareConcurrency.toString() : "4";
    execArgs.push("-threads", threadCount);
  }

  execArgs.push(outputName);

  await ffmpeg.exec(execArgs);

  const data = await ffmpeg.readFile(outputName);
  const blob = new Blob([data.buffer], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${file.name.replace(/\.[^.]+$/, "")}样片.mp4`;
  link.click();
  URL.revokeObjectURL(url);
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  status.textContent = `已完成 ${index + 1}/${total}：${file.name}（耗时 ${elapsed}s）`;
}

async function startProcessing() {
  if (!files.length || startButton.disabled) return;
  startButton.disabled = true;
  clearButton.disabled = true;
  input.disabled = true;
  setProgress(0);
  try {
    await loadFFmpeg();
    const totalStart = performance.now();
    for (let index = 0; index < files.length; index += 1) {
      await processFile(files[index], index, files.length);
    }
    const totalElapsed = ((performance.now() - totalStart) / 1000).toFixed(1);
    status.textContent = `全部完成（总耗时 ${totalElapsed}s），文件已下载到浏览器默认下载目录`;
    setProgress(100);
  } catch (error) {
    console.error(error);
    status.textContent = "处理失败，请查看浏览器控制台";
    alert(`处理失败：${error.message || error}`);
  } finally {
    startButton.disabled = !files.length;
    clearButton.disabled = false;
    input.disabled = false;
  }
}

input.addEventListener("change", (event) => addFiles(event.target.files));
clearButton.addEventListener("click", () => {
  files.length = 0;
  input.value = "";
  renderFiles();
});
startButton.addEventListener("click", startProcessing);
["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
});
dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
