const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const sharp = require("sharp");

const MEDIA_ROOT = path.join(__dirname, "media");

/* -----------------------------
   Helpers for pacing + logging
   ----------------------------- */
function jitter(min, max) {
  return (min + Math.random() * (max - min)).toFixed(2); // string float
}

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
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

/* -----------------------------
   Track async thumbnail tasks so we can exit cleanly
   ----------------------------- */
let PENDING_ASYNC = 0;
function track(promise) {
  PENDING_ASYNC++;
  promise.finally(() => { PENDING_ASYNC--; });
  return promise;
}

/* -----------------------------
   NFO generators (unchanged structure)
   ----------------------------- */
function generateVideoNfo(data) {
  const uploadDate = data.upload_date
    ? data.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>${data.title || "Unknown Title"}</title>
  <plot>${(data.description || "").replace(/&/g, "&amp;")}</plot>
  <studio>${data.uploader || "Unknown Channel"}</studio>
  <premiered>${uploadDate}</premiered>
  <dateadded>${new Date().toISOString()}</dateadded>
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
  <title>${data.channel || data.uploader || "Unknown Channel"}</title>
  <plot>${(data.description || "").replace(/&/g, "&amp;")}</plot>
  <studio>YouTube</studio>
  <premiered>${uploadDate}</premiered>
  <dateadded>${new Date().toISOString()}</dateadded>
  <year>${uploadDate.split("-")[0] || ""}</year>
  <uniqueid type="youtube">${data.id || data.channel_id || ""}</uniqueid>
  <genre>YouTube</genre>
</tvshow>`;
}

/* -----------------------------
   Core processing
   ----------------------------- */
function processVideo(filePath, folderPath) {
  const videoId = path.parse(filePath).name;
  const base = path.join(folderPath, videoId);
  const jsonPath = `${base}.info.json`;
  const nfoPath = `${base}.nfo`;
  const webpPath = `${base}.webp`;
  const jpgPath = `${base}.jpg`;

  if (!fs.existsSync(jsonPath)) {
    log(`📥 Fetching video metadata: ${videoId}`);
    try {
      const safeFlags = flagsToString(buildSafeFlags());
      execSync(`yt-dlp ${safeFlags} -o "${base}" https://www.youtube.com/watch?v=${videoId}`, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      sleepMs(400 + Math.random() * 400); // tiny cool-down
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
    track(
      sharp(webpPath)
        .toFile(jpgPath)
        .then(() => log(`🖼️ Converted thumbnail to .jpg for video ${videoId}`))
        .catch(err => log(`❌ Thumbnail error: ${err.message}`))
    );
  }

  sleepMs(300 + Math.random() * 500); // tiny pause before next file
}

function processChannel(folderPath, channelId) {
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
    track(
      sharp(webpPath)
        .toFile(jpgPath)
        .then(() => log(`🖼️ Created folder.jpg for channel ${channelId}`))
        .catch(err => log(`❌ Folder.jpg conversion failed: ${err.message}`))
    );
  }

  sleepMs(500 + Math.random() * 800); // tiny pause after channel work
}

/* -----------------------------
   Orchestration
   ----------------------------- */
function processAllChannels() {
  if (!fs.existsSync(MEDIA_ROOT)) {
    log("❌ Media folder not found");
    finishAndExit();
    return;
  }

  const channels = fs.readdirSync(MEDIA_ROOT);
  let processed = 0;

  channels.forEach(channelId => {
    // skip system/hidden dirs like .stfolder, .git, etc.
    if (channelId.startsWith(".")) return;

    const channelPath = path.join(MEDIA_ROOT, channelId);
    if (!fs.statSync(channelPath).isDirectory()) return;

    log(`📂 Processing channel: ${channelId}`);
    processChannel(channelPath, channelId);

    const files = fs.readdirSync(channelPath);
    files.filter(f => f.endsWith(".mp4")).forEach(file => {
      processVideo(path.join(channelPath, file), channelPath);
    });

    processed++;
    log(`--- DONE with channel ${channelId} ---`);
  });

  log(`🎉 Completed processing. Channels scanned: ${processed}`);
  log(`✅ All folders are scanned. Going to stop container now.`);

  finishAndExit();
}

/* -----------------------------
   Graceful exit helper
   ----------------------------- */
function finishAndExit() {
  // Wait a short time for pending async thumbnail conversions to finish
  const start = Date.now();
  const MAX_WAIT_MS = 10000; // 10s cap
  const CHECK_INTERVAL = 200;

  while (PENDING_ASYNC > 0 && (Date.now() - start) < MAX_WAIT_MS) {
    log(`⏳ Waiting for ${PENDING_ASYNC} pending image task(s) before exit...`);
    sleepMs(CHECK_INTERVAL);
  }

  if (PENDING_ASYNC > 0) {
    log(`⚠ Exiting with ${PENDING_ASYNC} image task(s) still pending (timeout reached).`);
  } else {
    log(`🟢 All background image tasks completed.`);
  }

  log(`👋 Exiting process now.`);
  // Explicitly exit so container stops
  process.exit(0);
}

/* -----------------------------
   Run once
   ----------------------------- */
processAllChannels();
