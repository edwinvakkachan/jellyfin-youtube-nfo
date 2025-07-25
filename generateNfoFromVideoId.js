const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const sharp = require("sharp");

const MEDIA_ROOT = path.join(__dirname, "media");

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
      execSync(`yt-dlp --skip-download --write-info-json --write-thumbnail -o "${base}" https://www.youtube.com/watch?v=${videoId}`);
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
      execSync(`yt-dlp --skip-download --write-info-json --write-thumbnail --playlist-end 1 -o "${folderPath}/${channelId}" ${url}`);
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
