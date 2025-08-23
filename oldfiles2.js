const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const sharp = require("sharp");

const MEDIA_ROOT = path.join(__dirname, "media");

/* =======================
   ADDED: Anti-throttle helpers
   ======================= */

// configurable via env if you want to tune
const SAFE_FLAGS = [
  "--skip-download",
  "--no-overwrites",
  "--write-info-json",
  "--write-thumbnail",
  // polite pacing
  "--sleep-requests", "1-3",
  "--sleep-interval", "1-3",
  "--max-sleep-interval", "5",
  // be gentle on bandwidth and parallelism
  "--limit-rate", process.env.YTDLP_LIMIT_RATE || "2M",
  "--concurrent-fragments", process.env.YTDLP_CONCURRENT_FRAGMENTS || "1",
  // retries at the yt-dlp layer too
  "--retries", process.env.YTDLP_RETRIES || "3",
  "--retry-sleep", process.env.YTDLP_RETRY_SLEEP || "2",
];

function sleepMsSync(ms) {
  // blocking sleep that works in pure JS without timers in sync contexts
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function randomInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

/**
 * ADDED: polite exec wrapper for yt-dlp with retries + backoff + random pauses.
 * - cmdArgs: array of args AFTER 'yt-dlp'
 * - label: for logs
 */
function execYtDlp(cmdArgs, label = "yt-dlp") {
  const MAX_ATTEMPTS = Number(process.env.YTDLP_MAX_ATTEMPTS || 3);
  const BASE_BACKOFF = Number(process.env.YTDLP_BASE_BACKOFF_MS || 1200);

  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;

    // tiny random pause before each attempt to avoid bursty patterns
    const prePause = randomInt(400, 1100);
    sleepMsSync(prePause);

    try {
      const fullArgs = cmdArgs; // already composed by caller
      const fullCmd = `yt-dlp ${fullArgs.map(a => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
      console.log(`▶ ${label} attempt ${attempt}: ${fullCmd}`);
      const out = execSync(fullCmd, { stdio: ["ignore", "pipe", "pipe"] });
      // short cool-down after success
      sleepMsSync(randomInt(300, 900));
      return out;
    } catch (err) {
      const stderr = (err.stderr || "").toString();
      console.warn(`⚠ ${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
      if (stderr) console.warn(String(stderr).slice(0, 400));

      if (attempt >= MAX_ATTEMPTS) {
        throw err;
      }
      // exponential backoff with jitter
      const backoff = BASE_BACKOFF * Math.pow(2, attempt - 1) + randomInt(200, 800);
      console.log(`⏳ backing off for ${backoff}ms before retry...`);
      sleepMsSync(backoff);
    }
  }
}

/* =======================
   Original code (unchanged logic)
   ======================= */

// Generate Jellyfin-compatible .nfo for videos
function generateVideoNfo(data) {
  const uploadDate = data.upload_date 
    ? data.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") // Format: YYYY-MM-DD
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

// Generate tvshow.nfo for channel (Jellyfin-compatible)
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

// Process single video (NO filename changes)
function processVideo(filePath, folderPath) {
  const videoId = path.parse(filePath).name;
  const base = path.join(folderPath, videoId);
  const jsonPath = `${base}.info.json`;
  const nfoPath = `${base}.nfo`;
  const webpPath = `${base}.webp`;
  const jpgPath = `${base}.jpg`;

  if (!fs.existsSync(jsonPath)) {
    console.log(`📥 Downloading metadata for: ${videoId}`);
    try {
      // ADDED: safe flags and wrapper
      execYtDlp(
        [
          ...SAFE_FLAGS,
          "-o", base,
          `https://www.youtube.com/watch?v=${videoId}`
        ],
        `video:${videoId}`
      );
    } catch (err) {
      console.error(`❌ yt-dlp failed for ${videoId}:`, err.message);
      return;
    }
  }

  // tiny pacing between filesystem-heavy steps
  sleepMsSync(randomInt(120, 300));

  if (!fs.existsSync(nfoPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      fs.writeFileSync(nfoPath, generateVideoNfo(data));
      console.log(`✅ Created Jellyfin .nfo for ${videoId}`);
    } catch (err) {
      console.error(`❌ Failed to write .nfo for ${videoId}:`, err.message);
    }
  }

  if (fs.existsSync(webpPath) && !fs.existsSync(jpgPath)) {
    sharp(webpPath)
      .toFile(jpgPath)
      .then(() => console.log(`🖼️ Converted thumbnail to .jpg for ${videoId}`))
      .catch(err => console.error(`❌ Thumbnail error:`, err.message));
  }

  // polite gap before moving to the next video
  sleepMsSync(randomInt(350, 900));
}

// Process channel-level metadata (unchanged)
function processChannel(folderPath, channelId) {
  const channelJson = path.join(folderPath, `${channelId}.info.json`);
  const webpPath = path.join(folderPath, `${channelId}.webp`);
  const jpgPath = path.join(folderPath, `folder.jpg`);
  const nfoPath = path.join(folderPath, `tvshow.nfo`);
  const url = `https://www.youtube.com/channel/${channelId}`;

  if (!fs.existsSync(channelJson)) {
    try {
      console.log(`📥 Downloading channel metadata for: ${channelId}`);
      // ADDED: safe flags and wrapper (plus playlist-end=1 like before)
      execYtDlp(
        [
          ...SAFE_FLAGS,
          "--playlist-end", "1",
          "-o", `${folderPath}/${channelId}`,
          url
        ],
        `channel:${channelId}`
      );
    } catch (err) {
      console.error(`❌ Channel yt-dlp failed for ${channelId}:`, err.message);
    }
  }

  // tiny pacing
  sleepMsSync(randomInt(120, 300));

  if (fs.existsSync(channelJson) && !fs.existsSync(nfoPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(channelJson, "utf-8"));
      fs.writeFileSync(nfoPath, generateChannelNfo(data));
      console.log(`✅ Created Jellyfin tvshow.nfo for ${channelId}`);
    } catch (err) {
      console.error(`❌ Failed to write tvshow.nfo for ${channelId}:`, err.message);
    }
  }

  if (fs.existsSync(webpPath) && !fs.existsSync(jpgPath)) {
    sharp(webpPath)
      .toFile(jpgPath)
      .then(() => console.log(`🖼️ Created folder.jpg for ${channelId}`))
      .catch(err => console.error(`❌ Folder.jpg conversion failed:`, err.message));
  }

  // polite gap before scanning videos of this channel
  sleepMsSync(randomInt(400, 1000));
}

// Process all folders (unchanged)
function processAllChannels() {
  if (!fs.existsSync(MEDIA_ROOT)) {
    console.error("❌ Media folder not found");
    return;
  }

  const channels = fs.readdirSync(MEDIA_ROOT);
  channels.forEach(channelId => {
    const channelPath = path.join(MEDIA_ROOT, channelId);
    if (!fs.statSync(channelPath).isDirectory()) return;

    console.log(`📂 Processing channel: ${channelId}`);
    processChannel(channelPath, channelId);

    const files = fs.readdirSync(channelPath);
    files.filter(f => f.endsWith(".mp4")).forEach(file => {
      processVideo(path.join(channelPath, file), channelPath);
    });
  });
}

// Run once
processAllChannels();
