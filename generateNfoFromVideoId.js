const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const sharp = require("sharp");

const MEDIA_ROOT = path.join(__dirname, "media");

/* -----------------------------
   ADDED: polite yt-dlp flags (single values, not ranges)
   ----------------------------- */
function jitter(min, max) {
  // random float as string, e.g. "2.13"
  return (min + Math.random() * (max - min)).toFixed(2);
}

function buildSafeFlags() {
  // construct once per call so sleeps are randomized each time
  const limitRate = process.env.YTDLP_LIMIT_RATE || "2M";
  const concFrags = process.env.YTDLP_CONCURRENT_FRAGMENTS || "1";
  const retries = process.env.YTDLP_RETRIES || "3";
  const retrySleep = process.env.YTDLP_RETRY_SLEEP || "2";

  return [
    "--skip-download",
    "--no-overwrites",
    "--write-info-json",
    "--write-thumbnail",
    "--sleep-requests", jitter(1, 3),
    "--sleep-interval", jitter(1, 3),
    "--max-sleep-interval", "5",
    "--limit-rate", limitRate,
    "--concurrent-fragments", concFrags,
    "--retries", retries,
    "--retry-sleep", retrySleep
  ];
}

function flagsToString(arr) {
  return arr.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

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
      const safeFlags = flagsToString(buildSafeFlags());
      execSync(`yt-dlp ${safeFlags} -o "${base}" https://www.youtube.com/watch?v=${videoId}`, {
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      console.error(`❌ yt-dlp failed for ${videoId}:`, err.message);
      return;
    }
  }

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
}

// Process channel-level metadata (unchanged except safe flags)
function processChannel(folderPath, channelId) {
  const channelJson = path.join(folderPath, `${channelId}.info.json`);
  const webpPath = path.join(folderPath, `${channelId}.webp`);
  const jpgPath = path.join(folderPath, `folder.jpg`);
  const nfoPath = path.join(folderPath, `tvshow.nfo`);
  const url = `https://www.youtube.com/channel/${channelId}`;

  if (!fs.existsSync(channelJson)) {
    try {
      console.log(`📥 Downloading channel metadata for: ${channelId}`);
      const safeFlags = flagsToString(buildSafeFlags());
      execSync(`yt-dlp ${safeFlags} --playlist-end 1 -o "${folderPath}/${channelId}" ${url}`, {
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      console.error(`❌ Channel yt-dlp failed for ${channelId}:`, err.message);
    }
  }

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
}

// Process all folders
function processAllChannels() {
  if (!fs.existsSync(MEDIA_ROOT)) {
    console.error("❌ Media folder not found");
    return;
  }

  const channels = fs.readdirSync(MEDIA_ROOT);
  channels.forEach(channelId => {
    // ADDED: skip hidden/system dirs like .stfolder, .git, etc.
    if (channelId.startsWith(".")) return;

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
