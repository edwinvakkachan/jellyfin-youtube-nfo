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

// Existing scanner collection: READ-ONLY
const SOURCE_COLLECTION =
  process.env.SOURCE_COLLECTION || "jellyfin_sync";

// Generator-owned collections
const TRACKING_COLLECTION = "nfo_generator_jobs";
const STATE_COLLECTION = "nfo_generator_state";
const STATE_ID = "nfo_generator_baseline_v2";

const MEDIA_ROOT = path.resolve(
  process.env.MEDIA_ROOT || path.join(__dirname, "media")
);

const REQUIRE_THUMBNAIL =
  String(process.env.REQUIRE_THUMBNAIL || "false").toLowerCase() ===
  "true";

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


function generateVideoNfo(data) {
  const uploadDate = data.upload_date
    ? data.upload_date.replace(
        /^(\d{4})(\d{2})(\d{2})$/,
        "$1-$2-$3"
      )
    : "";

  const year = uploadDate
    ? uploadDate.slice(0, 4)
    : "";

  const categories = Array.isArray(data.categories)
    ? data.categories
    : [];

  const tags = Array.isArray(data.tags)
    ? data.tags
    : [];

  const genres = [...new Set(categories)];

  const genreXml = genres
    .map(genre => `  <genre>${escapeXml(genre)}</genre>`)
    .join("\n");

  const tagXml = [...new Set(tags)]
    .map(tag => `  <tag>${escapeXml(tag)}</tag>`)
    .join("\n");

  const uniqueId = escapeXml(data.id || "");
  const title = escapeXml(data.title || "Unknown Title");
  const plot = escapeXml(data.description || "");
  const studio = escapeXml(
    data.channel || data.uploader || "Unknown Channel"
  );

  const runtime = Number.isFinite(Number(data.duration))
    ? Math.floor(Number(data.duration) / 60)
    : null;

  const runtimeXml = runtime !== null
    ? `  <runtime>${runtime}</runtime>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>${title}</title>
  <plot>${plot}</plot>
  <studio>${studio}</studio>
  <premiered>${uploadDate}</premiered>
  <dateadded>${new Date().toISOString()}</dateadded>
  <aired>${uploadDate}</aired>
  <year>${year}</year>
${runtimeXml}
  <uniqueid type="youtube">${uniqueId}</uniqueid>
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
    throw new Error(
      `Refusing path outside MEDIA_ROOT: ${relativePath}`
    );
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
  const candidates = [
    `${id}.jpg`,
    `${id}.jpeg`,
    `${id}.png`
  ];

  for (const filename of candidates) {
    const candidate = path.join(folderPath, filename);

    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ============================================================
// THUMBNAILS
// ============================================================

async function convertThumbnail(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  await sharp(sourcePath)
    .jpeg({ quality: 90 })
    .toFile(destinationPath);

  return fs.existsSync(destinationPath);
}

async function ensureVideoThumbnail(folderPath, videoId) {
  const webpPath = path.join(folderPath, `${videoId}.webp`);
  const jpgPath = path.join(folderPath, `${videoId}.jpg`);

  if (fs.existsSync(jpgPath)) {
    return "completed";
  }

  const otherThumbnail = findExistingThumbnail(
    folderPath,
    videoId
  );

  if (otherThumbnail) {
    if (otherThumbnail !== jpgPath) {
      try {
        await convertThumbnail(otherThumbnail, jpgPath);
      } catch (error) {
        log(
          `⚠️ Thumbnail conversion failed for ${videoId}: ${error.message}`
        );
      }
    }

    if (fs.existsSync(jpgPath)) {
      return "completed";
    }
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

  if (fs.existsSync(jpgPath)) {
    return;
  }

  if (fs.existsSync(webpPath)) {
    try {
      await convertThumbnail(webpPath, jpgPath);
      log(`🖼️ Created channel thumbnail: ${channelId}`);
    } catch (error) {
      log(
        `⚠️ Channel thumbnail conversion failed for ${channelId}: ${error.message}`
      );
    }
  }
}

// ============================================================
// CHANNEL METADATA
// ============================================================

async function processChannel(folderPath, channelId) {
  const channelJson = path.join(
    folderPath,
    `${channelId}.info.json`
  );

  const channelNfo = path.join(
    folderPath,
    "tvshow.nfo"
  );

  // Do not request channel metadata when the local JSON exists.
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
      log(
        `⚠️ Channel metadata request failed for ${channelId}: ${error.message}`
      );
    }
  }

  if (
    !fs.existsSync(channelNfo) &&
    fs.existsSync(channelJson)
  ) {
    try {
      const data = JSON.parse(
        fs.readFileSync(channelJson, "utf8")
      );

      fs.writeFileSync(
        channelNfo,
        generateChannelNfo(data),
        "utf8"
      );

      log(`✅ Created channel NFO: ${channelId}`);
    } catch (error) {
      log(
        `⚠️ Channel NFO failed for ${channelId}: ${error.message}`
      );
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
  const webpPath = `${base}.webp`;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file not found: ${filePath}`);
  }

  const needsJson = !fs.existsSync(jsonPath);

  const needsThumbnail =
    !findExistingThumbnail(folderPath, videoId) &&
    !fs.existsSync(webpPath);

  // Re-fetch only when JSON or thumbnail data is missing.
  if (needsJson || needsThumbnail) {
    log(
      `📥 Fetching video metadata/thumbnail for ${videoId}`
    );

    runYtDlp(
      `https://www.youtube.com/watch?v=${videoId}`,
      base
    );

    sleepMs(300);
  }

  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      `Metadata JSON is unavailable: ${jsonPath}`
    );
  }

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
  }

  let thumbnailStatus;

  try {
    thumbnailStatus = await ensureVideoThumbnail(
      folderPath,
      videoId
    );
  } catch (error) {
    log(
      `⚠️ Thumbnail processing failed for ${videoId}: ${error.message}`
    );

    thumbnailStatus = "pending";
  }

  if (
    REQUIRE_THUMBNAIL &&
    thumbnailStatus !== "completed"
  ) {
    throw new Error(
      `Required thumbnail is not available for ${videoId}`
    );
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
// They are not NFO-processed just because the generator is new.
// Existing records with missing media are queued for retry.
//
// The maximum _id is captured first so records inserted while
// initialization runs are not accidentally treated as baseline.

async function initializeBaseline(db, source, jobs, state) {
  let baselineState = await state.findOne({
    _id: STATE_ID
  });

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
      note:
        "Existing library registered without generating NFOs"
    };

    await state.updateOne(
      { _id: STATE_ID },
      { $setOnInsert: baselineState },
      { upsert: true }
    );

    baselineState = await state.findOne({
      _id: STATE_ID
    });
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

      // Preserve jobs that already exist; do not overwrite them.
      const existingJob = await jobs.findOne(
        { youtubeId },
        { projection: { _id: 1 } }
      );

      if (existingJob) {
        continue;
      }

      const mediaExists = isUsableMediaPath(
        record.mediaPath
      );

      const baselineJob = {
        youtubeId,
        baselineMediaPath: record.mediaPath || null,
        mediaPath: record.mediaPath || null,
        status: mediaExists
          ? "baseline_ignored"
          : "pending",
        lastError: mediaExists
          ? null
          : "Media path/file unavailable during baseline",
        baselineRegisteredAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await jobs.insertOne(baselineJob);

      registered++;

      if (!mediaExists) {
        pending++;
      }

      if (registered % 500 === 0) {
        log(
          `🧭 Baseline progress: ${registered} records registered.`
        );
      }
    }

    log(
      `🧭 Baseline registered: ${registered}; queued for retry: ${pending}.`
    );
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

  log(
    "✅ Baseline completed. Existing media will not be backfilled automatically."
  );

  log(
    "ℹ️ Start the next scheduled run to process new records and retry queued records."
  );

  return false;
}

// ============================================================
// RECORD RECONCILIATION
// ============================================================

function shouldProcessRecord(record, job, videoPath) {
  // New source record: no generator job exists.
  if (!job) {
    return {
      process: true,
      reason: "new source record"
    };
  }

  // Persistent retry queue.
  if (JOB_STATUSES_TO_RETRY.includes(job.status)) {
    return {
      process: true,
      reason: `retry status: ${job.status}`
    };
  }

  const currentPath = record.mediaPath || null;

  // Detect source mediaPath changes.
  if (
    job.status === "baseline_ignored" &&
    currentPath !== (job.baselineMediaPath || null)
  ) {
    return {
      process: true,
      reason: "source mediaPath changed"
    };
  }

  // Requeue baseline items whose media file is no longer present.
  if (
    job.status === "baseline_ignored" &&
    (!videoPath || !fs.existsSync(videoPath))
  ) {
    return {
      process: true,
      reason: "baseline media file missing"
    };
  }

  // For completed items, re-check generated files.
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

  // Existing baseline records are intentionally excluded while
  // their media path and file remain unchanged.
  if (job.status === "baseline_ignored") {
    return {
      process: false,
      reason: "existing baseline item"
    };
  }

  // Unknown status: process conservatively.
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

    if (!fs.existsSync(MEDIA_ROOT)) {
      throw new Error(
        `MEDIA_ROOT does not exist: ${MEDIA_ROOT}`
      );
    }

    // First run or interrupted baseline initialization.
    const baselineReady = await initializeBaseline(
      db,
      source,
      jobs,
      state
    );

    if (!baselineReady) {
      return;
    }

    // --------------------------------------------------------
    // RECONCILE THE WHOLE SOURCE COLLECTION
    //
    // This deliberately does not depend on dateDownloaded or
    // _id ordering. It catches delayed inserts with old dates.
    // Completed jobs are skipped after checking required files.
    // --------------------------------------------------------

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
          log(
            `⚠️ Invalid media path for ${youtubeId}: ${error.message}`
          );

          await markPending(
            jobs,
            record,
            `Invalid mediaPath: ${error.message}`
          );

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
        await markPending(
          jobs,
          record,
          "Media file/path not available; will retry"
        );

        log(
          `⏳ Queued ${youtubeId}: media file/path not available.`
        );

        pending++;
        continue;
      }

      const folderPath = path.dirname(videoPath);
      const channelId = path.basename(folderPath);
      const nfoPath = path.join(
        folderPath,
        `${youtubeId}.nfo`
      );

      try {
        await updateJob(jobs, youtubeId, {
          mediaPath: record.mediaPath,
          nfoPath: path.relative(MEDIA_ROOT, nfoPath),
          status: "processing",
          lastError: null,
          startedAt: new Date(),
          sourceDateDownloaded: record.dateDownloaded ?? null
        });

        log(
          `🎬 Processing ${youtubeId} (${decision.reason})`
        );

        // A channel is processed at most once during this run.
        if (!processedChannels.has(channelId)) {
          processedChannels.add(channelId);

          await processChannel(
            folderPath,
            channelId
          );

          channelsChecked++;
        }

        const result = await processVideo(videoPath);

        if (!result.nfoExists) {
          throw new Error(
            "NFO was not created successfully."
          );
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
          completedAt: completed
            ? new Date()
            : null
        });

        if (completed) {
          processed++;
          log(`✅ Completed ${youtubeId}`);
        } else {
          pending++;
          log(
            `⏳ ${youtubeId}: NFO complete; thumbnail pending.`
          );
        }
      } catch (error) {
        failed++;

        log(
          `❌ Failed ${youtubeId}: ${error.message}`
        );

        await updateJob(jobs, youtubeId, {
          mediaPath: record.mediaPath || null,
          status: "failed",
          lastError: error.message,
          failedAt: new Date()
        });
      }
    }

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

    log("========================================");
    log("🎉 Reconciliation finished.");
    log(`✅ Completed this run: ${processed}`);
    log(`⏭️ Skipped: ${skipped}`);
    log(`⏳ Pending/retry: ${pending}`);
    log(`❌ Failed this run: ${failed}`);
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