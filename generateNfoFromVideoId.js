// code.txt
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const sharp = require("sharp");

const MEDIA_ROOT = path.join(__dirname, "media");

// ---------- Helpers ----------
const TZ = "Asia/Kolkata";
function nowIST() {
  return new Date().toLocaleString("en-IN", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function log(msg) {
  console.log(`[${nowIST()}] ${msg}`);
}

function jitter(min, max) {
  return (min + Math.random() * (max - min)).toFixed(2);
}

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function buildSafeFlags() {
  return [
    "--skip-download",
    "--no-overwrites",
    "--write-info-json",
    "--write-thumbnail",
    "--sleep-requests", jitter(1, 3),
    "--sleep-interval", jitter(1, 3),
    "--max-sleep-interval", "5",
    "--limit-rate", process.env.YTDLP_LIMIT_RATE || "2M",
    "--concurrent-fragments", process.env.YTDLP_CONCURRENT_FRAGMENTS || "1",
    "--retries", process.env.YTDLP_RETRIES || "3",
    "--retry-sleep", process.env.YTDLP_RETRY_SLEEP || "2"
  ];
}

function flagsToString(arr) {
  return arr.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

// ---------- Track async thumbnail tasks ----------
const PENDING_SET = new Set();
function track(promise) {
  PENDING_SET.add(promise);
  promise.finally(() => PENDING_SET.delete(promise));
  return promise;
}

async function waitForPendingAndExit() {
  const MAX_PENDING_WAIT_MS = Number(process.env.MAX_PENDING_WAIT_MS ?? 10 * 60 * 1000);
  const PENDING_LOG_EVERY_MS = Number(process.env.PENDING_LOG_EVERY_MS ?? 1000);

  const start = Date.now();
  let lastLog = 0;

  for (;;) {
    const remaining = MAX_PENDING_WAIT_MS - (Date.now() - start);
    const count = PENDING_SET.size;

    if (count === 0) {
      log(`🟢 All background image tasks completed.`);
      break;
    }
    if (remaining <= 0) {
      log(`⚠ Exiting with ${count} image task(s) still pending (timeout).`);
      break;
    }

    const now = Date.now();
    if (now - lastLog >= PENDING_LOG_EVERY_MS) {
      log(`⏳ Waiting for ${count} pending image task(s) before exit...`);
      lastLog = now;
    }
    await new Promise(r => setTimeout(r, Math.min(PENDING_LOG_EVERY_MS, remaining)));
  }

  log(`👋 Exiting process now.`);
  process.exit(0);
}

// ---------- NFO generators ----------
function escapeXml(text = "") {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function generateVideoNfo(data) {
  const uploadDate = data.upload_date
    ? data.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>${escapeXml(data.title || "Unknown Title")}</title>
  <plot>${escapeXml(data.description || "")}</plot>
  <studio>${escapeXml(data.uploader || "Unknown Channel")}</studio>
  <premiered>${uploadDate}</premiered>
  <dateadded>${nowIST()}</dateadded>
  <aired>${uploadDate}</aired>
  <year>${uploadDate.split("-")[0] || ""}</year>
  <uniqueid type="youtube">${data.id || ""}</uniqueid>
  <genre>YouTube</genre>
</movie>`;
}

function generateChannelNfo(data) {
  const uploadDate = data.upload_date
    ? data.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<tvshow>
  <title>${escapeXml(data.channel || data.uploader || "Unknown Channel")}</title>
  <plot>${escapeXml(data.description || "")}</plot>
  <studio>YouTube</studio>
  <premiered>${uploadDate}</premiered>
  <dateadded>${nowIST()}</dateadded>
  <year>${uploadDate.split("-")[0] || ""}</year>
  <uniqueid type="youtube">${data.id || data.channel_id || ""}</uniqueid>
  <genre>YouTube</genre>
</tvshow>`;
}

// ---------- Processing ----------
let counters = { channels: 0, videos: 0, thumbs: 0 };

function processVideo(filePath, folderPath) {
  const videoId = path.parse(filePath).name;
  const base = path.join(folderPath, videoId);
  const jsonPath = `${base}.info.json`;
  const nfoPath = `${base}.nfo`;
  const webpPath = `${base}.webp`;
  const jpgPath = `${base}.jpg`;

  counters.videos++;

  if (!fs.existsSync(jsonPath)) {
    log(`📥 Fetching metadata for video: ${videoId}`);
    try {
      const safeFlags = flagsToString(buildSafeFlags());
      execSync(`yt-dlp ${safeFlags} -o "${base}" https://www.youtube.com/watch?v=${videoId}`, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      sleepMs(400 + Math.random() * 400);
    } catch (err) {
      log(`❌ yt-dlp failed for video ${videoId}: ${err.message}`);
      return;
    }
  }

  if (!fs.existsSync(nfoPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      fs.writeFileSync(nfoPath, generateVideoNfo(data));
      log(`✅ Created .nfo for video ${videoId}`);
    } catch (err) {
      log(`❌ Failed to write .nfo for video ${videoId}: ${err.message}`);
    }
  }

  if (fs.existsSync(webpPath) && !fs.existsSync(jpgPath)) {
    counters.thumbs++;
    track(
      sharp(webpPath)
        .toFile(jpgPath)
        .then(() => log(`🖼️ Converted thumbnail to .jpg for video ${videoId}`))
        .catch(err => log(`❌ Thumbnail error: ${err.message}`))
    );
  }

  sleepMs(300 + Math.random() * 500);
}

function processChannel(folderPath, channelId) {
  counters.channels++;
  const channelJson = path.join(folderPath, `${channelId}.info.json`);
  const webpPath = path.join(folderPath, `${channelId}.webp`);
  const jpgPath = path.join(folderPath, `folder.jpg`);
  const nfoPath = path.join(folderPath, `tvshow.nfo`);
  const url = `https://www.youtube.com/channel/${channelId}`;

  if (!fs.existsSync(channelJson)) {
    try {
      log(`📥 Fetching channel metadata: ${channelId}`);
      const safeFlags = flagsToString(buildSafeFlags());
      execSync(`yt-dlp ${safeFlags} --playlist-end 1 -o "${folderPath}/${channelId}" ${url}`, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      sleepMs(500 + Math.random() * 700);
    } catch (err) {
      log(`❌ yt-dlp failed for channel ${channelId}: ${err.message}`);
    }
  }

  if (fs.existsSync(channelJson) && !fs.existsSync(nfoPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(channelJson, "utf-8"));
      fs.writeFileSync(nfoPath, generateChannelNfo(data));
      log(`✅ Created tvshow.nfo for channel ${channelId}`);
    } catch (err) {
      log(`❌ Failed to write tvshow.nfo for channel ${channelId}: ${err.message}`);
    }
  }

  if (fs.existsSync(webpPath) && !fs.existsSync(jpgPath)) {
    counters.thumbs++;
    track(
      sharp(webpPath)
        .toFile(jpgPath)
        .then(() => log(`🖼️ Created folder.jpg for channel ${channelId}`))
        .catch(err => log(`❌ Folder.jpg conversion failed: ${err.message}`))
    );
  }

  sleepMs(500 + Math.random() * 800);
}

// ---------- Orchestration ----------
async function processAllChannels() {
  const startedAt = Date.now();
  log("🟢 Starting full media scan...");

  if (!fs.existsSync(MEDIA_ROOT)) {
    log("❌ Media folder not found");
    await waitForPendingAndExit();
    return;
  }

  const channels = fs.readdirSync(MEDIA_ROOT);

  channels.forEach(channelId => {
    if (channelId.startsWith(".")) return;
    const channelPath = path.join(MEDIA_ROOT, channelId);
    if (!fs.statSync(channelPath).isDirectory()) return;

    log(`📂 Processing channel: ${channelId}`);
    processChannel(channelPath, channelId);

    const files = fs.readdirSync(channelPath);
    files.filter(f => f.endsWith(".mp4")).forEach(file => {
      processVideo(path.join(channelPath, file), channelPath);
    });

    log(`--- DONE with channel ${channelId} ---`);
  });

  const duration = ((Date.now() - startedAt) / 1000).toFixed(2);
  log(`🎉 Completed processing.`);
  log(`🧾 Summary: Channels=${counters.channels}, Videos=${counters.videos}, Thumbnails=${counters.thumbs}`);
  log(`⏱️ Duration: ${duration}s (Started: ${new Date(startedAt).toLocaleString("en-IN",{timeZone:TZ})}, Finished: ${nowIST()})`);
  await waitForPendingAndExit();
}

// ---------- Run once ----------
processAllChannels().catch(err => {
  console.error(`[${nowIST()}] Fatal error:`, err);
  process.exit(1);
});
