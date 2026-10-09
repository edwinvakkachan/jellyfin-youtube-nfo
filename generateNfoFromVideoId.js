const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
const { MongoClient } = require("mongodb");

// ============================================================
// CONFIGURATION
// ============================================================

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "tubearchivist";

// Existing collection: READ-ONLY
const SOURCE_COLLECTION = "jellyfin_sync";

// Generator-specific collections
const TRACKING_COLLECTION = "nfo_generator_jobs";
const STATE_COLLECTION = "nfo_generator_state";
const STATE_ID = "new_downloads_checkpoint_v1";

const MEDIA_ROOT = path.resolve(
  process.env.MEDIA_ROOT || path.join(__dirname, "media")
);

const TZ = "Asia/Kolkata";

if (!MONGODB_URI) {
  console.error("❌ Set the MONGODB_URI environment variable.");
  process.exit(1);
}

// ============================================================
// HELPERS
// ============================================================

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

function log(message) {
  console.log(`[${nowIST()}] ${message}`);
}

function jitter(min, max) {
  return (min + Math.random() * (max - min)).toFixed(2);
}

function sleepMs(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
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
    "--concurrent-fragments",
    process.env.YTDLP_CONCURRENT_FRAGMENTS || "1",
    "--retries", process.env.YTDLP_RETRIES || "3",
    "--retry-sleep", process.env.YTDLP_RETRY_SLEEP || "2"
  ];
}

function escapeXml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function generateVideoNfo(data) {
  const uploadDate = data.upload_date
    ? data.upload_date.replace(
        /(\d{4})(\d{2})(\d{2})/,
        "$1-$2-$3"
      )
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
  <uniqueid type="youtube">${escapeXml(data.id || "")}</uniqueid>
  <genre>YouTube</genre>
</movie>`;
}

function generateChannelNfo(data) {
  const uploadDate = data.upload_date
    ? data.upload_date.replace(
        /(\d{4})(\d{2})(\d{2})/,
        "$1-$2-$3"
      )
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<tvshow>
  <title>${escapeXml(data.channel || data.uploader || "Unknown Channel")}</title>
  <plot>${escapeXml(data.description || "")}</plot>
  <studio>YouTube</studio>
  <premiered>${uploadDate}</premiered>
  <dateadded>${nowIST()}</dateadded>
  <year>${uploadDate.split("-")[0] || ""}</year>
  <uniqueid type="youtube">${escapeXml(data.id || data.channel_id || "")}</uniqueid>
  <genre>YouTube</genre>
</tvshow>`;
}

// Resolve a relative path and reject anything outside MEDIA_ROOT.
function resolveMediaPath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error("Missing mediaPath.");
  }

  const resolved = path.resolve(MEDIA_ROOT, relativePath);
  const relative = path.relative(MEDIA_ROOT, resolved);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path is outside MEDIA_ROOT: ${relativePath}`);
  }

  return resolved;
}

function runYtDlp(url, outputBase, extraFlags = []) {
  const args = [
    ...buildSafeFlags(),
    ...extraFlags,
    "-o",
    outputBase,
    url
  ];

  execFileSync("yt-dlp", args, {
    stdio: "inherit",
    timeout: 10 * 60 * 1000
  });
}

// ============================================================
// CHANNEL PROCESSING
// ============================================================

async function processChannel(folderPath, channelId) {
  const channelJson = path.join(
    folderPath,
    `${channelId}.info.json`
  );

  const webpPath = path.join(folderPath, `${channelId}.webp`);
  const jpgPath = path.join(folderPath, "folder.jpg");
  const nfoPath = path.join(folderPath, "tvshow.nfo");

  // Avoid contacting YouTube if channel metadata already exists.
  if (!fs.existsSync(channelJson)) {
    try {
      log(`📥 Channel metadata missing; fetching once: ${channelId}`);

      runYtDlp(
        `https://www.youtube.com/channel/${channelId}`,
        path.join(folderPath, channelId),
        ["--playlist-end", "1"]
      );

      sleepMs(300);
    } catch (error) {
      log(
        `❌ Channel metadata failed for ${channelId}: ${error.message}`
      );
    }
  }

  // Create channel NFO only if missing.
  if (!fs.existsSync(nfoPath) && fs.existsSync(channelJson)) {
    try {
      const data = JSON.parse(
        fs.readFileSync(channelJson, "utf8")
      );

      fs.writeFileSync(
        nfoPath,
        generateChannelNfo(data),
        "utf8"
      );

      log(`✅ Created channel NFO: ${channelId}`);
    } catch (error) {
      log(
        `❌ Channel NFO failed for ${channelId}: ${error.message}`
      );
    }
  }

  // Convert the channel thumbnail only if the JPG is missing.
  if (fs.existsSync(webpPath) && !fs.existsSync(jpgPath)) {
    try {
      await sharp(webpPath).toFile(jpgPath);
      log(`🖼️ Created channel thumbnail: ${channelId}`);
    } catch (error) {
      log(
        `❌ Channel thumbnail failed for ${channelId}: ${error.message}`
      );
    }
  }
}

// ============================================================
// VIDEO PROCESSING
// ============================================================

async function processVideo(filePath) {
  const videoId = path.parse(filePath).name;
  const folderPath = path.dirname(filePath);
  const base = path.join(folderPath, videoId);

  const jsonPath = `${base}.info.json`;
  const nfoPath = `${base}.nfo`;
  const webpPath = `${base}.webp`;
  const jpgPath = `${base}.jpg`;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file not found: ${filePath}`);
  }

  // Fetch metadata only if the existing info JSON is missing.
  if (!fs.existsSync(jsonPath)) {
    log(`📥 Fetching metadata for video: ${videoId}`);

    runYtDlp(
      `https://www.youtube.com/watch?v=${videoId}`,
      base
    );

    sleepMs(400);

    if (!fs.existsSync(jsonPath)) {
      throw new Error(`yt-dlp did not create ${jsonPath}`);
    }
  }

  // Create NFO only if it does not already exist.
  if (!fs.existsSync(nfoPath)) {
    const data = JSON.parse(
      fs.readFileSync(jsonPath, "utf8")
    );

    fs.writeFileSync(
      nfoPath,
      generateVideoNfo(data),
      "utf8"
    );

    log(`✅ Created video NFO: ${videoId}`);
  } else {
    log(`⏭️ NFO already exists: ${videoId}`);
  }

  let thumbnailStatus = "not_available";

  if (fs.existsSync(webpPath)) {
    if (!fs.existsSync(jpgPath)) {
      await sharp(webpPath).toFile(jpgPath);
      log(`🖼️ Converted thumbnail: ${videoId}`);
    }

    thumbnailStatus = fs.existsSync(jpgPath)
      ? "completed"
      : "pending";
  } else if (fs.existsSync(jpgPath)) {
    thumbnailStatus = "completed";
  }

  return {
    nfoExists: fs.existsSync(nfoPath),
    jsonExists: fs.existsSync(jsonPath),
    thumbnailStatus
  };
}

// ============================================================
// GENERATOR TRACKING
// ============================================================

async function updateJob(jobs, youtubeId, values) {
  await jobs.updateOne(
    { youtubeId },
    {
      $set: {
        ...values,
        updatedAt: new Date()
      },
      $setOnInsert: {
        youtubeId,
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const client = new MongoClient(MONGODB_URI);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let channelCount = 0;

  const processedChannels = new Set();

  try {
    await client.connect();

    const db = client.db(DB_NAME);
    const source = db.collection(SOURCE_COLLECTION);
    const jobs = db.collection(TRACKING_COLLECTION);
    const state = db.collection(STATE_COLLECTION);

    await jobs.createIndex(
      { youtubeId: 1 },
      { unique: true }
    );

    log("🟢 MongoDB connected.");
    log(`📂 Media root: ${MEDIA_ROOT}`);
    log(`📖 Read-only source: ${DB_NAME}.${SOURCE_COLLECTION}`);
    log(`📝 Generator tracking: ${DB_NAME}.${TRACKING_COLLECTION}`);
    log(`🧭 Checkpoint: ${DB_NAME}.${STATE_COLLECTION}`);

    if (!fs.existsSync(MEDIA_ROOT)) {
      throw new Error(`Media root not found: ${MEDIA_ROOT}`);
    }

    const validSourceFilter = {
      youtubeId: {
        $exists: true,
        $type: "string",
        $ne: ""
      },
      mediaPath: {
        $exists: true,
        $type: "string",
        $ne: ""
      }
    };

    // First run: establish a baseline instead of backfilling
    // the entire existing library.
    let checkpoint = await state.findOne({
      _id: STATE_ID
    });

    if (!checkpoint) {
      const newest = await source.findOne(
        {
          ...validSourceFilter,
          dateDownloaded: {
            $type: ["int", "long", "double", "decimal"]
          }
        },
        {
          sort: { dateDownloaded: -1 },
          projection: { dateDownloaded: 1 }
        }
      );

      const baseline = Number(
        newest?.dateDownloaded || 0
      );

      await state.insertOne({
        _id: STATE_ID,
        lastSeenDateDownloaded: baseline,
        initializedAt: new Date(),
        note: "Initial baseline; existing library intentionally not backfilled"
      });

      checkpoint = {
        lastSeenDateDownloaded: baseline
      };

      log(
        `🛑 First-run baseline established at dateDownloaded=${baseline}. Existing library will NOT be backfilled.`
      );
    }

    const lastSeen = Number(
      checkpoint.lastSeenDateDownloaded || 0
    );

    // Retry generator jobs that are incomplete or failed.
    const retryJobs = await jobs.find(
      {
        status: {
          $in: ["pending", "failed", "processing"]
        }
      },
      {
        projection: { youtubeId: 1 }
      }
    ).toArray();

    const retryIds = retryJobs
      .map(job => job.youtubeId)
      .filter(Boolean);

    // Process downloads newer than the checkpoint, plus retries.
    const candidateFilter = {
      ...validSourceFilter,
      $or: [
        { dateDownloaded: { $gt: lastSeen } },
        ...(retryIds.length
          ? [{ youtubeId: { $in: retryIds } }]
          : [])
      ]
    };

    const cursor = source.find(candidateFilter)
      .sort({
        dateDownloaded: 1,
        youtubeId: 1
      });

    let maxSeenThisRun = lastSeen;

    for await (const record of cursor) {
      const youtubeId = record.youtubeId;
      const downloadedAt = Number(
        record.dateDownloaded || 0
      );

      let videoPath;

      try {
        videoPath = resolveMediaPath(record.mediaPath);
      } catch (error) {
        log(`⚠️ Skipping ${youtubeId}: ${error.message}`);
        skipped++;

        if (downloadedAt > maxSeenThisRun) {
          maxSeenThisRun = downloadedAt;
        }

        continue;
      }

      if (!fs.existsSync(videoPath)) {
        log(
          `⏭️ Media file not available yet; will retry when job is pending or failed: ${youtubeId}`
        );

        // Only the generator collection is modified.
        await updateJob(jobs, youtubeId, {
          mediaPath: record.mediaPath,
          status: "pending",
          lastError: "Media file not present at MEDIA_ROOT",
          lastCheckedAt: new Date()
        });

        skipped++;

        if (downloadedAt > maxSeenThisRun) {
          maxSeenThisRun = downloadedAt;
        }

        continue;
      }

      const folderPath = path.dirname(videoPath);
      const channelId = path.basename(folderPath);

      const nfoPath = path.join(
        folderPath,
        `${youtubeId}.nfo`
      );

      const webpPath = path.join(
        folderPath,
        `${youtubeId}.webp`
      );

      const jpgPath = path.join(
        folderPath,
        `${youtubeId}.jpg`
      );

      const job = await jobs.findOne({ youtubeId });

      const nfoReady = fs.existsSync(nfoPath);

      const thumbnailReady =
        fs.existsSync(jpgPath) ||
        (!fs.existsSync(webpPath) &&
          !process.env.REQUIRE_THUMBNAIL);

      if (
        job?.status === "completed" &&
        nfoReady &&
        thumbnailReady
      ) {
        skipped++;

        if (downloadedAt > maxSeenThisRun) {
          maxSeenThisRun = downloadedAt;
        }

        continue;
      }

      try {
        await updateJob(jobs, youtubeId, {
          mediaPath: record.mediaPath,
          nfoPath: path.relative(MEDIA_ROOT, nfoPath),
          status: "processing",
          lastError: null,
          startedAt: new Date(),
          dateDownloaded: downloadedAt
        });

        log(
          `🎬 Processing new/incomplete video: ${youtubeId}`
        );

        // Process each channel at most once per run.
        if (!processedChannels.has(channelId)) {
          processedChannels.add(channelId);

          await processChannel(
            folderPath,
            channelId
          );

          channelCount++;
        }

        const result = await processVideo(videoPath);

        if (!result.nfoExists) {
          throw new Error(
            "NFO file is missing after processing."
          );
        }

        const completed =
          result.thumbnailStatus !== "pending";

        await updateJob(jobs, youtubeId, {
          mediaPath: record.mediaPath,
          nfoPath: path.relative(MEDIA_ROOT, nfoPath),
          status: completed ? "completed" : "pending",
          tasks: {
            nfo: {
              status: "completed",
              processedAt: new Date()
            },
            thumbnail: {
              status: result.thumbnailStatus,
              processedAt:
                result.thumbnailStatus === "completed"
                  ? new Date()
                  : null
            }
          },
          lastError: null,
          completedAt: completed ? new Date() : null
        });

        if (completed) {
          processed++;
        } else {
          log(
            `⚠️ ${youtubeId}: NFO done; thumbnail still pending.`
          );
        }
      } catch (error) {
        failed++;

        log(
          `❌ Failed ${youtubeId}: ${error.message}`
        );

        await updateJob(jobs, youtubeId, {
          mediaPath: record.mediaPath,
          status: "failed",
          lastError: error.message,
          failedAt: new Date()
        });
      }

      if (downloadedAt > maxSeenThisRun) {
        maxSeenThisRun = downloadedAt;
      }
    }

    // Update only the generator's checkpoint.
    // Never modify SOURCE_COLLECTION fields.
    if (maxSeenThisRun > lastSeen) {
      await state.updateOne(
        { _id: STATE_ID },
        {
          $set: {
            lastSeenDateDownloaded: maxSeenThisRun,
            updatedAt: new Date()
          }
        }
      );
    }

    log("========================================");
    log("🎉 Processing run finished.");
    log(`🆕 Completed: ${processed}`);
    log(`⏭️ Skipped: ${skipped}`);
    log(`❌ Failed: ${failed}`);
    log(`📺 Channels checked: ${channelCount}`);
    log(`🧭 Checkpoint: ${maxSeenThisRun}`);
    log("========================================");
  } finally {
    await client.close();
  }
}

main().catch(error => {
  log(`💥 Fatal error: ${error.stack || error.message}`);
  process.exitCode = 1;
});