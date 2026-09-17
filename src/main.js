import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";
import { Combinator, MP4Clip, ImgClip, OffscreenSprite } from "@webav/av-cliper";
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
const ua = navigator.userAgent.toLowerCase();
const isFirefox = ua.includes("firefox");
const isChromium = ua.includes("chrome") || ua.includes("edg");

// Chromium 内核存在极其严格的 COEP Worker 限制和 WebAssembly 内存共享死锁 Bug，导致 FFmpeg MT 经常假死。
// 因为 Chromium 有极速的 WebAV 可用，我们在此强制其 FFmpeg 走单线程保底，仅给 Firefox 保留 MT。
const canUseMT = typeof SharedArrayBuffer !== "undefined" && !isChromium;
const threadCount = canUseMT ? Math.min(navigator.hardwareConcurrency || 4, 8) : 1;

const app = document.querySelector("#app");
app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <h1>一起来导样片吧！</h1>
    </section>
    <section class="panel">
      <label class="drop-zone" id="drop-zone" for="video-input">
        <input id="video-input" type="file" accept="video/*" multiple />
        <span class="drop-icon">＋</span>
        <strong>拖放视频到这里</strong>
        <span>或点击选择视频，可一次处理多个文件</span>
      </label>
      
      <!-- Settings Bar -->
      <div class="settings-bar" id="engine-bar">
        <label class="select-tag">
          <span style="background: #3a2818; color: #f0b475; border-color: #805828;">处理引擎</span>
          <select id="setting-engine" style="color: #f0b475;">
            <option value="webav">⚡ WebAV 硬件加速 (极速/推荐)</option>
            <option value="ffmpeg">FFmpeg WASM (高兼容/全功能)</option>
          </select>
        </label>
        <label class="select-tag">
          <span>画质级别</span>
          <select id="setting-crf">
            <option value="18">高 (大体积)</option>
            <option value="23" selected>中 (均衡/推荐)</option>
            <option value="28">低 (极速小体积)</option>
          </select>
        </label>
      </div>

      <div class="settings-bar" id="ffmpeg-settings-bar" style="display: none;">
        <label class="select-tag">
          <span>加速模式</span>
          <select id="setting-threads" ${!canUseMT ? 'disabled' : ''}>
            ${canUseMT ? `<option value="auto">自动多核 (推荐)</option>` : `<option value="1">单线程 (环境受限)</option>`}
            ${canUseMT ? `
              <option value="1">单线程</option>
              <option value="2">2 线程</option>
              <option value="4">4 线程</option>
              <option value="8">8 线程</option>
            ` : ''}
          </select>
        </label>
        <label class="select-tag">
          <span>音频模式</span>
          <select id="setting-audio">
            <option value="auto">智能直拷 (推荐)</option>
            <option value="aac">强制转码 (AAC)</option>
          </select>
        </label>
      </div>

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

      <!-- 报错日志与原因诊断卡片 -->
      <div id="error-card" class="error-card" style="display: none;">
        <div class="error-header">
          <span class="error-title">⚠️ 处理遇到错误</span>
          <button id="close-error" class="text-button" type="button">关闭提示</button>
        </div>
        <p id="error-summary" class="error-summary"></p>
        <details class="error-details" open>
          <summary>查看详细日志与报错原因</summary>
          <pre id="error-log-content" class="error-log-content"></pre>
        </details>
      </div>
    </section>
    
    <footer class="footer" style="text-align: center; margin-top: 24px; color: #827c73; font-size: 13px;">
      <p>🔒 本地处理，不上传云端</p>
    </footer>
  </main>
`;

let ffmpeg = new FFmpeg();
const files = [];
const ffmpegLogs = [];
const input = document.querySelector("#video-input");
const dropZone = document.querySelector("#drop-zone");
const fileList = document.querySelector("#file-list");
const clearButton = document.querySelector("#clear-button");
const startButton = document.querySelector("#start-button");
const status = document.querySelector("#status");
const progressBar = document.querySelector("#progress-bar");
const errorCard = document.querySelector("#error-card");
const errorSummary = document.querySelector("#error-summary");
const errorLogContent = document.querySelector("#error-log-content");
const closeErrorBtn = document.querySelector("#close-error");

// Settings selectors
const settingEngine = document.querySelector("#setting-engine");
const ffmpegSettingsBar = document.querySelector("#ffmpeg-settings-bar");
const settingThreads = document.querySelector("#setting-threads");
const settingCrf = document.querySelector("#setting-crf");
const settingAudio = document.querySelector("#setting-audio");

settingEngine.addEventListener("change", (e) => {
  if (e.target.value === "ffmpeg") {
    ffmpegSettingsBar.style.display = "flex";
  } else {
    ffmpegSettingsBar.style.display = "none";
  }
});

// Firefox 兼容性降级处理
if (isFirefox) {
  const webavOpt = settingEngine.querySelector('option[value="webav"]');
  if (webavOpt) {
    webavOpt.disabled = true;
    webavOpt.textContent = "⚡ WebAV 硬件加速 (Firefox 暂不兼容)";
  }
  settingEngine.value = "ffmpeg";
  ffmpegSettingsBar.style.display = "flex";
}

closeErrorBtn.addEventListener("click", () => {
  errorCard.style.display = "none";
});

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

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
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
      const ext = (file.name.split('.').pop() || 'VIDEO').toUpperCase();
      const sizeStr = formatSize(file.size);
      item.innerHTML = `
        <span>${file.name}</span>
        <div class="file-meta">
          <span class="file-badge">${ext} · ${sizeStr}</span>
          <button type="button" aria-label="移除 ${file.name}">移除</button>
        </div>
      `;
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
  ffmpeg.on("log", ({ message }) => {
    ffmpegLogs.push(message);
    if (ffmpegLogs.length > 50) ffmpegLogs.shift();
    console.log("[FFmpeg]", message);
  });
}

let watermarkCached = false;

async function processFile(file, index, total) {
  const t0 = performance.now();
  const inputName = `input_${index}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const outputName = `output_${index}.mp4`;

  await ffmpeg.writeFile(inputName, await fetchFile(file));

  if (!watermarkCached) {
    await ffmpeg.writeFile("watermark.png", await fetchFile(watermarkUrl));
    watermarkCached = true;
  }

  const crfVal = settingCrf.value || "23";
  let threadsVal = "1";
  let threadsDisplay = "单线程";
  if (canUseMT) {
    if (settingThreads.value === "auto") {
      const maxT = Math.min(navigator.hardwareConcurrency || 4, 8);
      threadsVal = maxT.toString();
      threadsDisplay = `${maxT}线程`;
    } else {
      threadsVal = settingThreads.value;
      threadsDisplay = `${threadsVal}线程`;
    }
  }

  const getExecArgs = (audioCodec) => {
    const args = [
      "-y",
      "-i", inputName,
      "-i", "watermark.png",
      "-filter_complex",
      "[1:v][0:v]scale2ref=w=main_w:h=main_h[wm][video];[video][wm]overlay=0:0[outv]",
      "-map", "[outv]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", crfVal,
      "-tune", "fastdecode",
      "-c:a", audioCodec,
    ];

    if (canUseMT) {
      args.push("-threads", threadsVal);
    }
    args.push(outputName);
    return args;
  };

  const executeFFmpegWithWatchdog = async (args) => {
    let lastActivityTime = performance.now();
    let isDone = false;
    
    const poke = () => { lastActivityTime = performance.now(); };
    ffmpeg.on("log", poke);
    ffmpeg.on("progress", poke);

    const execPromise = ffmpeg.exec(args).then((ret) => {
      isDone = true;
      return ret;
    }).catch(err => {
      isDone = true;
      throw err;
    });
    
    const watchdogPromise = new Promise((_, reject) => {
      const interval = setInterval(() => {
        if (isDone) {
          clearInterval(interval);
          return;
        }
        if (performance.now() - lastActivityTime > 20000) {
          clearInterval(interval);
          ffmpeg.terminate(); // Force kill the stuck instance
          reject(new Error("FFmpeg 引擎超过 20 秒无响应，发生底层死锁。建议在上方将加速模式改为“单线程”后重试。"));
        }
      }, 2000);
    });

    try {
      return await Promise.race([execPromise, watchdogPromise]);
    } finally {
      ffmpeg.off("log", poke);
      ffmpeg.off("progress", poke);
    }
  };

  const audioPref = settingAudio.value; // 'auto' or 'aac'
  let success = false;
  let activeAudioCodec = "直拷";

  const updateStatus = (ac) => {
    status.textContent = `处理中 ${index + 1}/${total}：${file.name} (${threadsDisplay} · CRF${crfVal} · 音频${ac})`;
  };

  if (audioPref === "auto") {
    updateStatus("直拷");
    try {
      const ret = await executeFFmpegWithWatchdog(getExecArgs("copy"));
      if (ret === 0) success = true;
    } catch (err) {
      console.warn("音频直接复制遇到兼容问题，准备回退", err);
    }
  }

  if (!success) {
    activeAudioCodec = "AAC转码";
    updateStatus(activeAudioCodec);
    try {
      if (audioPref === "auto" || !ffmpeg.loaded) {
        // Need to reload if we tried copy and it failed, or watchdog killed it
        if (ffmpeg.loaded) ffmpeg.terminate();
        ffmpeg = new FFmpeg();
        await loadFFmpeg();
        await ffmpeg.writeFile(inputName, await fetchFile(file));
        await ffmpeg.writeFile("watermark.png", await fetchFile(watermarkUrl));
        watermarkCached = true;
      }
      const retFallback = await executeFFmpegWithWatchdog(getExecArgs("aac"));
      if (retFallback !== 0) {
        throw new Error(`处理失败，FFmpeg 退出码：${retFallback}`);
      }
    } catch (fallbackErr) {
      throw fallbackErr;
    }
  }

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

async function processWebAV(fileObj, index, total) {
  const t0 = performance.now();
  status.textContent = `准备中 ${index + 1}/${total}：${fileObj.name} (WebAV 硬件加速)`;
  
  if (typeof window.VideoEncoder === "undefined" || typeof window.VideoDecoder === "undefined") {
    throw new Error("当前浏览器不支持 WebCodecs (VideoEncoder/Decoder) 硬件加速 API。建议切换回“FFmpeg WASM”模式，或使用最新版 Chrome/Edge。");
  }

  const supported = await Combinator.isSupported({ videoCodec: "avc1.42E032" });
  if (!supported) {
    throw new Error("当前浏览器环境不支持 H.264 (avc1) 硬件编码（可能因授权或系统限制）。建议切换回“FFmpeg WASM”模式。");
  }

  // 1. 初始化视频 Clip
  const mp4Clip = new MP4Clip(fileObj.stream());
  await mp4Clip.ready;
  const { width, height } = mp4Clip.meta;

  // 2. 初始化水印图片 Clip
  const imgResp = await fetch(watermarkUrl);
  const imgBlob = await imgResp.blob();
  const imgBitmap = await createImageBitmap(imgBlob);
  const imgClip = new ImgClip(imgBitmap);
  await imgClip.ready;

  // 3. 构建精灵贴图 (Sprites)
  const videoSprite = new OffscreenSprite(mp4Clip);
  
  const imgSprite = new OffscreenSprite(imgClip);
  // 全屏覆盖水印
  imgSprite.rect.w = width;
  imgSprite.rect.h = height;
  imgSprite.rect.x = 0;
  imgSprite.rect.y = 0;

  // 4. 初始化合成器 (Combinator)
  const crfVal = settingCrf.value || "23";
  let targetBitrate = 5e6; // 默认中画质基准 (约 5Mbps for 1080p)
  if (crfVal === "18") targetBitrate = 12e6; // 高画质
  if (crfVal === "28") targetBitrate = 2e6;  // 低画质
  
  // 根据实际分辨率动态缩放码率
  const area = width * height;
  const baseArea = 1920 * 1080;
  const finalBitrate = Math.round(targetBitrate * (area / baseArea));

  const com = new Combinator({
    width,
    height,
    videoCodec: "avc1.42E032", // H.264
    bitrate: finalBitrate,
  });

  await com.addSprite(videoSprite, { main: true }); // main 给定视频长度
  await com.addSprite(imgSprite);

  // 5. 导出并下载流
  const outStream = com.output();
  const reader = outStream.getReader();

  let lastProgressTime = performance.now();
  let progressValue = 0;
  let watchdogInterval;
  
  const readLoop = async () => {
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return chunks;
  };

  const watchdogPromise = new Promise((_, reject) => {
    watchdogInterval = setInterval(() => {
      if (progressValue < 1 && performance.now() - lastProgressTime > 15000) {
        clearInterval(watchdogInterval);
        reader.cancel("Watchdog timeout");
        reject(new Error("硬件加速引擎长时间无响应 (可能由于浏览器底层 WebCodecs 兼容性问题)。请在上方处理引擎中切换回“FFmpeg WASM”模式重试。"));
      }
    }, 2000);
  });

  com.on("OutputProgress", (v) => {
    progressValue = v;
    lastProgressTime = performance.now();
    setProgress(v * 100);
    status.textContent = `处理中 ${index + 1}/${total}：${fileObj.name} (GPU硬件加速 · 画质${crfVal} - ${Math.floor(v * 100)}%)`;
  });

  com.on("error", (err) => {
    clearInterval(watchdogInterval);
    console.error("WebAV 合成失败", err);
    throw err;
  });

  let chunks;
  try {
    chunks = await Promise.race([readLoop(), watchdogPromise]);
  } finally {
    clearInterval(watchdogInterval);
  }
  
  const outBlob = new Blob(chunks, { type: "video/mp4" });
  
  const url = URL.createObjectURL(outBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileObj.name.replace(/\.[^.]+$/, "")}样片.mp4`;
  link.click();
  URL.revokeObjectURL(url);
  
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  status.textContent = `已完成 ${index + 1}/${total}：${fileObj.name}（耗时 ${elapsed}s）`;
}

async function startProcessing() {
  if (!files.length || startButton.disabled) return;
  startButton.disabled = true;
  clearButton.disabled = true;
  input.disabled = true;
  errorCard.style.display = "none";
  errorSummary.textContent = "";
  errorLogContent.textContent = "";
  setProgress(0);
  
  const engine = settingEngine.value;

  try {
    if (engine === "ffmpeg") {
      await loadFFmpeg();
    }
    const totalStart = performance.now();
    
    for (let index = 0; index < files.length; index += 1) {
      if (engine === "webav") {
        await processWebAV(files[index], index, files.length);
      } else {
        await processFile(files[index], index, files.length);
      }
    }
    
    const totalElapsed = ((performance.now() - totalStart) / 1000).toFixed(1);
    status.textContent = `全部完成（总耗时 ${totalElapsed}s），文件已下载到浏览器默认下载目录`;
    setProgress(100);
  } catch (error) {
    console.error(error);
    status.textContent = "处理失败，详细诊断结果已显示在下方";
    
    // Parse error logs to display user-friendly diagnostic message
    let reason = "处理过程中发生未知错误。";
    const errStr = String(error?.message || error || "");
    const logsTail = ffmpegLogs.slice(-25).join("\n");
    
    if (errStr.includes("GetDirectory") || errStr.includes("opfs") || errStr.includes("SecurityError")) {
      reason = "浏览器本地文件系统(OPFS)访问被拒绝。Firefox 等浏览器的严格防追踪/隐私保护功能可能会拦截本地高级缓存。建议：切换回“FFmpeg WASM (高兼容)”引擎，或使用 Chrome/Edge 浏览器体验极致硬件加速。";
    } else if (errStr.includes("SharedArrayBuffer") || logsTail.includes("SharedArrayBuffer")) {
      reason = "浏览器环境未开启 SharedArrayBuffer 多线程支持。建议刷新页面或在本地测试。";
    } else if (errStr.includes("memory") || errStr.includes("Out of Memory") || logsTail.includes("Out of Memory") || logsTail.includes("OOM")) {
      reason = "浏览器 WebAssembly 内存不足。处理过大或超高清视频时耗尽了内存，建议关闭其他标签页或处理较小的视频。";
    } else if (logsTail.includes("Invalid data found") || logsTail.includes("moov atom not found")) {
      reason = "视频文件数据损坏或格式不受支持，无法正常解码该视频。";
    } else if (errStr.includes("startsWith") || errStr.includes("Aborted") || logsTail.includes("Error")) {
      reason = "底层执行异常终止。通常是由于视频容器格式不规范或通道不支持导致。";
    } else {
      reason = `执行失败：${errStr}`;
    }
    
    errorSummary.innerHTML = `<strong>诊断原因：</strong> ${reason}`;
    errorLogContent.textContent = [
      `[错误信息] ${errStr}`,
      `[系统堆栈] ${error?.stack || "无"}`,
      `\n--- 最近 25 行 FFmpeg 运行日志 ---`,
      logsTail || "(暂无 FFmpeg 日志)"
    ].join("\n");
    
    errorCard.style.display = "block";
    errorCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
