const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
const { MongoClient } = require("mongodb");

// ============================================================
// CONFIGURATION
// ============================================================

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "tubearchivist";

const SOURCE_COLLECTION =
  process.env.SOURCE_COLLECTION || "jellyfin_sync";

const TRACKING_COLLECTION = "nfo_generator_jobs";
const STATE_COLLECTION = "nfo_generator_state";
const STATE_ID = "nfo_generator_baseline_v2";

const MEDIA_ROOT = path.resolve(
  process.env.MEDIA_ROOT || path.join(__dirname, "media")
);

const REQUIRE_THUMBNAIL =
  String(process.env.REQUIRE_THUMBNAIL || "false").toLowerCase() === "true";

const REGENERATE_NFO =
  String(process.env.REGENERATE_NFO || "false").toLowerCase() === "true";

const TZ = "Asia/Kolkata";

const JOB_STATUSES_TO_RETRY = [
  "pending",
  "failed",
  "processing"
];

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is required.");
  process.exit(1);
}

// ============================================================
// LOGGING AND HELPERS
// ============================================================

function log(message) {
  const time = new Date().toLocaleString("en-IN", {
    timeZone: TZ,
    hour12: false
  });

  console.log(`[${time}] ${message}`);
}

function sleepMs(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function jitter(min, max) {
  return (min + Math.random() * (max - min)).toFixed(2);
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toUploadDate(value) {
  if (!value) return "";

  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})$/);

  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? String(value)
    : "";
}

// ============================================================
// VIDEO NFO GENERATION
// ============================================================

function generateVideoNfo(data) {
  const uploadDate = toUploadDate(data.upload_date);
  const year = uploadDate ? uploadDate.slice(0, 4) : "";

  const categories = Array.isArray(data.categories)
    ? data.categories
    : [];

  const tags = Array.isArray(data.tags)
    ? data.tags
    : [];

  const genreXml = [...new Set(categories)]
    .map(genre => `  <genre>${escapeXml(genre)}</genre>`)
    .join("\n");

  const tagXml = [...new Set(tags)]
    .map(tag => `  <tag>${escapeXml(tag)}</tag>`)
    .join("\n");

  const runtime = Number.isFinite(Number(data.duration))
    ? Math.floor(Number(data.duration) / 60)
    : null;

  const runtimeXml =
    runtime !== null ? `  <runtime>${runtime}</runtime>` : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>${escapeXml(data.title || "Unknown Title")}</title>
  <plot>${escapeXml(data.description || "")}</plot>
  <studio>${escapeXml(data.channel || data.uploader || "Unknown Channel")}</studio>
  <premiered>${uploadDate}</premiered>
  <dateadded>${new Date().toISOString()}</dateadded>
  <aired>${uploadDate}</aired>
  <year>${year}</year>
${runtimeXml}
  <uniqueid type="youtube">${escapeXml(data.id || "")}</uniqueid>
${genreXml}
${tagXml}
</movie>`;
}

function generateChannelNfo(data) {
  const uploadDate = toUploadDate(data.upload_date);
  const year = uploadDate ? uploadDate.slice(0, 4) : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<tvshow>
  <title>${escapeXml(data.channel || data.uploader || data.title || "Unknown Channel")}</title>
  <plot>${escapeXml(data.description || "")}</plot>
  <studio>YouTube</studio>
  <premiered>${uploadDate}</premiered>
  <dateadded>${new Date().toISOString()}</dateadded>
  <year>${year}</year>
  <uniqueid type="youtube">${escapeXml(data.channel_id || data.id || "")}</uniqueid>
  <genre>YouTube</genre>
</tvshow>`;
}

// ============================================================
// MEDIA PATH HELPERS
// ============================================================

function resolveMediaPath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.trim() === ""
  ) {
    throw new Error("mediaPath is missing.");
  }

  const resolved = path.resolve(MEDIA_ROOT, relativePath);
  const relative = path.relative(MEDIA_ROOT, resolved);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing path outside MEDIA_ROOT: ${relativePath}`);
  }

  return resolved;
}

function isUsableMediaPath(mediaPath) {
  try {
    return Boolean(
      mediaPath &&
      typeof mediaPath === "string" &&
      fs.existsSync(resolveMediaPath(mediaPath))
    );
  } catch {
    return false;
  }
}

// ============================================================
// YT-DLP HELPERS
// ============================================================

function buildYtDlpFlags() {
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

function runYtDlp(url, outputBase, extraFlags = []) {
  execFileSync(
    "yt-dlp",
    [
      ...buildYtDlpFlags(),
      ...extraFlags,
      "-o",
      outputBase,
      url
    ],
    {
      stdio: "inherit",
      timeout: 10 * 60 * 1000
    }
  );
}

function findExistingThumbnail(folderPath, id) {
  for (const filename of [`${id}.jpg`, `${id}.jpeg`, `${id}.png`]) {
    const candidate = path.join(folderPath, filename);

    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ============================================================
// THUMBNAIL PROCESSING
// ============================================================

async function convertThumbnail(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) return false;

  await sharp(sourcePath)
    .jpeg({ quality: 90 })
    .toFile(destinationPath);

  return fs.existsSync(destinationPath);
}

async function ensureVideoThumbnail(folderPath, videoId) {
  const webpPath = path.join(folderPath, `${videoId}.webp`);
  const jpgPath = path.join(folderPath, `${videoId}.jpg`);

  if (fs.existsSync(jpgPath)) return "completed";

  const otherThumbnail = findExistingThumbnail(folderPath, videoId);

  if (otherThumbnail) {
    if (otherThumbnail !== jpgPath) {
      try {
        await convertThumbnail(otherThumbnail, jpgPath);
      } catch (error) {
        log(`⚠️ Thumbnail conversion failed for ${videoId}: ${error.message}`);
      }
    }

    if (fs.existsSync(jpgPath)) return "completed";
  }

  if (fs.existsSync(webpPath)) {
    await convertThumbnail(webpPath, jpgPath);
    return fs.existsSync(jpgPath) ? "completed" : "pending";
  }

  return "missing";
}

async function ensureChannelThumbnail(folderPath, channelId) {
  const webpPath = path.join(folderPath, `${channelId}.webp`);
  const jpgPath = path.join(folderPath, "folder.jpg");

  if (fs.existsSync(jpgPath)) return;

  if (fs.existsSync(webpPath)) {
    try {
      await convertThumbnail(webpPath, jpgPath);
      log(`🖼️ Created channel thumbnail: ${channelId}`);
    } catch (error) {
      log(`⚠️ Channel thumbnail conversion failed for ${channelId}: ${error.message}`);
    }
  }
}
// ============================================================
// CHANNEL METADATA
// ============================================================

async function processChannel(folderPath, channelId) {
  const channelJson = path.join(folderPath, `${channelId}.info.json`);
  const channelNfo = path.join(folderPath, "tvshow.nfo");

  // In regeneration mode, use local channel JSON only.
  if (REGENERATE_NFO) {
    if (fs.existsSync(channelJson)) {
      try {
        const data = JSON.parse(fs.readFileSync(channelJson, "utf8"));

        fs.writeFileSync(
          channelNfo,
          generateChannelNfo(data),
          "utf8"
        );

        log(`🔄 Regenerated channel NFO: ${channelId}`);
      } catch (error) {
        log(`⚠️ Channel NFO regeneration failed for ${channelId}: ${error.message}`);
      }
    } else {
      log(`⏭️ Skipping channel NFO regeneration; local JSON missing: ${channelId}`);
    }

    await ensureChannelThumbnail(folderPath, channelId);
    return;
  }

  // Normal mode: fetch channel metadata only if JSON is missing.
  if (!fs.existsSync(channelJson)) {
    try {
      log(`📥 Fetching missing channel metadata: ${channelId}`);

      runYtDlp(
        `https://www.youtube.com/channel/${channelId}`,
        path.join(folderPath, channelId),
        ["--playlist-end", "1"]
      );

      sleepMs(300);
    } catch (error) {
      log(`⚠️ Channel metadata request failed for ${channelId}: ${error.message}`);
    }
  }

  if (!fs.existsSync(channelNfo) && fs.existsSync(channelJson)) {
    try {
      const data = JSON.parse(fs.readFileSync(channelJson, "utf8"));

      fs.writeFileSync(
        channelNfo,
        generateChannelNfo(data),
        "utf8"
      );

      log(`✅ Created channel NFO: ${channelId}`);
    } catch (error) {
      log(`⚠️ Channel NFO failed for ${channelId}: ${error.message}`);
    }
  }

  await ensureChannelThumbnail(folderPath, channelId);
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

  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file not found: ${filePath}`);
  }

  // Regeneration mode never runs yt-dlp.
  // It only rebuilds NFO files from existing local JSON.
  if (REGENERATE_NFO) {
    if (!fs.existsSync(jsonPath)) {
      throw new Error(
        `Cannot regenerate NFO; local metadata JSON is missing: ${jsonPath}`
      );
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

    fs.writeFileSync(
      nfoPath,
      generateVideoNfo(data),
      "utf8"
    );

    log(`🔄 Regenerated video NFO: ${videoId}`);

    let thumbnailStatus = "missing";

    try {
      thumbnailStatus = await ensureVideoThumbnail(folderPath, videoId);
    } catch (error) {
      log(`⚠️ Thumbnail processing failed for ${videoId}: ${error.message}`);
      thumbnailStatus = "pending";
    }

    if (REQUIRE_THUMBNAIL && thumbnailStatus !== "completed") {
      throw new Error(`Required thumbnail is not available for ${videoId}`);
    }

    return {
      nfoExists: fs.existsSync(nfoPath),
      jsonExists: fs.existsSync(jsonPath),
      thumbnailStatus
    };
  }

  const needsJson = !fs.existsSync(jsonPath);

  const needsThumbnail =
    !findExistingThumbnail(folderPath, videoId) &&
    !fs.existsSync(`${base}.webp`);

  // Normal mode: fetch only if local JSON or thumbnail data is missing.
  if (needsJson || needsThumbnail) {
    log(`📥 Fetching video metadata/thumbnail for ${videoId}`);

    runYtDlp(
      `https://www.youtube.com/watch?v=${videoId}`,
      base
    );

    sleepMs(300);
  }

  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Metadata JSON is unavailable: ${jsonPath}`);
  }

  if (!fs.existsSync(nfoPath)) {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

    fs.writeFileSync(
      nfoPath,
      generateVideoNfo(data),
      "utf8"
    );

    log(`✅ Created video NFO: ${videoId}`);
  }

  let thumbnailStatus;

  try {
    thumbnailStatus = await ensureVideoThumbnail(folderPath, videoId);
  } catch (error) {
    log(`⚠️ Thumbnail processing failed for ${videoId}: ${error.message}`);
    thumbnailStatus = "pending";
  }

  if (REQUIRE_THUMBNAIL && thumbnailStatus !== "completed") {
    throw new Error(`Required thumbnail is not available for ${videoId}`);
  }

  return {
    nfoExists: fs.existsSync(nfoPath),
    jsonExists: fs.existsSync(jsonPath),
    thumbnailStatus
  };
}

// ============================================================
// TRACKING HELPERS
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

async function markPending(jobs, record, reason) {
  await updateJob(jobs, record.youtubeId, {
    mediaPath: record.mediaPath || null,
    status: "pending",
    lastError: reason,
    lastCheckedAt: new Date()
  });
}

// ============================================================
// BASELINE INITIALIZATION
// ============================================================

// Existing library items are registered as baseline_ignored.
// Items with missing media are queued for retry.
// The source collection remains read-only.

async function initializeBaseline(db, source, jobs, state) {
  let baselineState = await state.findOne({ _id: STATE_ID });

  if (!baselineState) {
    const newest = await source.findOne(
      {},
      {
        sort: { _id: -1 },
        projection: { _id: 1 }
      }
    );

    baselineState = {
      _id: STATE_ID,
      status: "initializing",
      baselineMaxId: newest?._id ?? null,
      initializedAt: new Date(),
      note: "Existing library registered without generating NFOs"
    };

    await state.updateOne(
      { _id: STATE_ID },
      { $setOnInsert: baselineState },
      { upsert: true }
    );

    baselineState = await state.findOne({ _id: STATE_ID });
  }

  if (baselineState.status === "initialized") {
    return true;
  }

  log("🧭 Initializing generator baseline.");

  const baselineMaxId = baselineState.baselineMaxId;

  if (baselineMaxId !== null && baselineMaxId !== undefined) {
    const cursor = source.find({
      _id: { $lte: baselineMaxId },
      youtubeId: {
        $exists: true,
        $type: "string",
        $ne: ""
      }
    });

    let registered = 0;
    let pending = 0;

    for await (const record of cursor) {
      const youtubeId = record.youtubeId;

      const existingJob = await jobs.findOne(
        { youtubeId },
        { projection: { _id: 1 } }
      );

      if (existingJob) continue;

      const mediaExists = isUsableMediaPath(record.mediaPath);

      const baselineJob = {
        youtubeId,
        baselineMediaPath: record.mediaPath || null,
        mediaPath: record.mediaPath || null,
        status: mediaExists ? "baseline_ignored" : "pending",
        lastError: mediaExists
          ? null
          : "Media path/file unavailable during baseline",
        baselineRegisteredAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await jobs.insertOne(baselineJob);
      registered++;

      if (!mediaExists) pending++;

      if (registered % 500 === 0) {
        log(`🧭 Baseline progress: ${registered} records registered.`);
      }
    }

    log(`🧭 Baseline registered: ${registered}; queued for retry: ${pending}.`);
  }

  await state.updateOne(
    { _id: STATE_ID },
    {
      $set: {
        status: "initialized",
        baselineCompletedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );

  log("✅ Baseline completed.");
  log("ℹ️ Existing baseline items will not be backfilled automatically.");

  return false;
}
// ============================================================
// RECORD RECONCILIATION
// ============================================================

function shouldProcessRecord(record, job, videoPath) {
  // Regeneration mode: process all records with an available media file.
  if (REGENERATE_NFO) {
    return {
      process: true,
      reason: "NFO regeneration mode"
    };
  }

  // New source record.
  if (!job) {
    return {
      process: true,
      reason: "new source record"
    };
  }

  // Retry pending, failed, and interrupted jobs.
  if (JOB_STATUSES_TO_RETRY.includes(job.status)) {
    return {
      process: true,
      reason: `retry status: ${job.status}`
    };
  }

  const currentPath = record.mediaPath || null;

  // Detect source mediaPath changes for baseline records.
  if (
    job.status === "baseline_ignored" &&
    currentPath !== (job.baselineMediaPath || null)
  ) {
    return {
      process: true,
      reason: "source mediaPath changed"
    };
  }

  // Requeue baseline records if their media file is missing.
  if (
    job.status === "baseline_ignored" &&
    (!videoPath || !fs.existsSync(videoPath))
  ) {
    return {
      process: true,
      reason: "baseline media file missing"
    };
  }

  // Verify files for completed records.
  if (job.status === "completed") {
    if (!videoPath || !fs.existsSync(videoPath)) {
      return {
        process: true,
        reason: "completed item's media file missing"
      };
    }

    const folder = path.dirname(videoPath);
    const id = record.youtubeId;
    const nfo = path.join(folder, `${id}.nfo`);
    const json = path.join(folder, `${id}.info.json`);

    if (!fs.existsSync(nfo) || !fs.existsSync(json)) {
      return {
        process: true,
        reason: "generated metadata file missing"
      };
    }

    if (
      REQUIRE_THUMBNAIL &&
      !findExistingThumbnail(folder, id)
    ) {
      return {
        process: true,
        reason: "required thumbnail missing"
      };
    }

    return {
      process: false,
      reason: "already completed"
    };
  }

  // Leave unchanged baseline records alone during normal operation.
  if (job.status === "baseline_ignored") {
    return {
      process: false,
      reason: "existing baseline item"
    };
  }

  return {
    process: true,
    reason: `unrecognized job status: ${job.status}`
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const client = new MongoClient(MONGODB_URI);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let pending = 0;
  let channelsChecked = 0;

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

    await jobs.createIndex({ status: 1 });

    log("🟢 MongoDB connected.");
    log(`📂 MEDIA_ROOT: ${MEDIA_ROOT}`);
    log(`📖 Source collection (read-only): ${SOURCE_COLLECTION}`);
    log(`📝 Tracking collection: ${TRACKING_COLLECTION}`);
    log(`🧭 State collection: ${STATE_COLLECTION}`);
    log(`🔄 Regenerate NFO: ${REGENERATE_NFO}`);

    if (!fs.existsSync(MEDIA_ROOT)) {
      throw new Error(`MEDIA_ROOT does not exist: ${MEDIA_ROOT}`);
    }

    // In regeneration mode, bypass baseline initialization.
    // This permits existing library records to be regenerated.
    if (!REGENERATE_NFO) {
      const baselineReady = await initializeBaseline(
        db,
        source,
        jobs,
        state
      );

      if (!baselineReady) {
        return;
      }
    }

    // Reconcile the entire source collection.
    // No dateDownloaded filter is used.
    const pipeline = [
      {
        $match: {
          youtubeId: {
            $exists: true,
            $type: "string",
            $ne: ""
          }
        }
      },
      {
        $lookup: {
          from: TRACKING_COLLECTION,
          localField: "youtubeId",
          foreignField: "youtubeId",
          as: "_generatorJobs"
        }
      }
    ];

    const cursor = source.aggregate(
      pipeline,
      { allowDiskUse: true }
    );

    for await (const record of cursor) {
      const youtubeId = record.youtubeId;
      const job = record._generatorJobs?.[0] || null;

      let videoPath = null;

      if (record.mediaPath) {
        try {
          videoPath = resolveMediaPath(record.mediaPath);
        } catch (error) {
          log(`⚠️ Invalid media path for ${youtubeId}: ${error.message}`);

          if (!REGENERATE_NFO) {
            await markPending(
              jobs,
              record,
              `Invalid mediaPath: ${error.message}`
            );
          }

          pending++;
          continue;
        }
      }

      const decision = shouldProcessRecord(
        record,
        job,
        videoPath
      );

      if (!decision.process) {
        skipped++;
        continue;
      }

      if (!videoPath || !fs.existsSync(videoPath)) {
        if (!REGENERATE_NFO) {
          await markPending(
            jobs,
            record,
            "Media file/path not available; will retry"
          );
        }

        log(`⏳ Skipping ${youtubeId}: media file/path unavailable.`);
        pending++;
        continue;
      }

      const folderPath = path.dirname(videoPath);
      const channelId = path.basename(folderPath);
      const nfoPath = path.join(folderPath, `${youtubeId}.nfo`);

      try {
        if (!REGENERATE_NFO) {
          await updateJob(jobs, youtubeId, {
            mediaPath: record.mediaPath,
            nfoPath: path.relative(MEDIA_ROOT, nfoPath),
            status: "processing",
            lastError: null,
            startedAt: new Date(),
            sourceDateDownloaded: record.dateDownloaded ?? null
          });
        }

        log(`🎬 Processing ${youtubeId} (${decision.reason})`);

        if (!processedChannels.has(channelId)) {
          processedChannels.add(channelId);

          await processChannel(folderPath, channelId);
          channelsChecked++;
        }

        const result = await processVideo(videoPath);

        if (!result.nfoExists) {
          throw new Error("NFO was not created successfully.");
        }

        if (REGENERATE_NFO) {
          processed++;
          log(`✅ Regenerated ${youtubeId}`);
          continue;
        }

        const completed =
          result.thumbnailStatus === "completed" ||
          (
            !REQUIRE_THUMBNAIL &&
            result.thumbnailStatus === "missing"
          );

        await updateJob(jobs, youtubeId, {
          mediaPath: record.mediaPath,
          nfoPath: path.relative(MEDIA_ROOT, nfoPath),
          status: completed ? "completed" : "pending",
          baselineMediaPath: record.mediaPath || null,
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
          lastError: completed
            ? null
            : "Thumbnail is still missing",
          completedAt: completed ? new Date() : null
        });

        if (completed) {
          processed++;
          log(`✅ Completed ${youtubeId}`);
        } else {
          pending++;
          log(`⏳ ${youtubeId}: NFO complete; thumbnail pending.`);
        }
      } catch (error) {
        failed++;

        log(`❌ Failed ${youtubeId}: ${error.message}`);

        // Regeneration mode does not alter job tracking.
        if (!REGENERATE_NFO) {
          await updateJob(jobs, youtubeId, {
            mediaPath: record.mediaPath || null,
            status: "failed",
            lastError: error.message,
            failedAt: new Date()
          });
        }
      }
    }

    // Only normal operation updates scan state.
    if (!REGENERATE_NFO) {
      await state.updateOne(
        { _id: STATE_ID },
        {
          $set: {
            lastScanAt: new Date(),
            lastScanStatus: "completed",
            updatedAt: new Date()
          }
        }
      );
    }

    log("========================================");
    log(
      REGENERATE_NFO
        ? "🎉 NFO regeneration finished."
        : "🎉 Reconciliation finished."
    );
    log(`✅ Processed this run: ${processed}`);
    log(`⏭️ Skipped: ${skipped}`);
    log(`⏳ Pending: ${pending}`);
    log(`❌ Failed: ${failed}`);
    log(`📺 Channels checked: ${channelsChecked}`);
    log("========================================");
  } finally {
    await client.close();
  }
}

main().catch(error => {
  log(`💥 Fatal error: ${error.stack || error.message}`);
  process.exitCode = 1;
});