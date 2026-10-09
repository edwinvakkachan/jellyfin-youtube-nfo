
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
const SOURCE_COLLECTION = "jellyfin_sync"; // READ-ONLY
const TRACKING_COLLECTION = "nfo_generator_jobs";

const MEDIA_ROOT = path.resolve(
    process.env.MEDIA_ROOT || path.join(__dirname, "media")
);

const TZ = "Asia/Kolkata";

if (!MONGODB_URI) {
    console.error("Set MONGODB_URI environment variable.");
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
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(sab, 0, 0, ms);
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

// ============================================================
// NFO GENERATORS
// ============================================================

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

// ============================================================
// PATH VALIDATION
// ============================================================

function resolveMediaPath(relativePath) {
    if (typeof relativePath !== "string" || !relativePath.trim()) {
        throw new Error("Missing mediaPath");
    }

    const resolved = path.resolve(MEDIA_ROOT, relativePath);
    const relative = path.relative(MEDIA_ROOT, resolved);

    if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        throw new Error(`Path outside MEDIA_ROOT: ${relativePath}`);
    }

    return resolved;
}

// ============================================================
// YT-DLP
// ============================================================

function runYtDlp(url, outputBase, extraFlags = []) {
    execFileSync("yt-dlp", [
        ...buildSafeFlags(),
        ...extraFlags,
        "-o",
        outputBase,
        url
    ], {
        stdio: "inherit",
        timeout: 10 * 60 * 1000
    });
}

// ============================================================
// CHANNEL PROCESSING
// ============================================================

async function processChannel(folderPath, channelId) {
    const jsonPath = path.join(
        folderPath,
        `${channelId}.info.json`
    );

    const webpPath = path.join(
        folderPath,
        `${channelId}.webp`
    );

    const jpgPath = path.join(folderPath, "folder.jpg");
    const nfoPath = path.join(folderPath, "tvshow.nfo");

    if (!fs.existsSync(jsonPath)) {
        try {
            log(`Fetching channel metadata: ${channelId}`);

            runYtDlp(
                `https://www.youtube.com/channel/${channelId}`,
                path.join(folderPath, channelId),
                ["--playlist-end", "1"]
            );
        } catch (error) {
            log(`Channel metadata failed: ${error.message}`);
        }
    }

    if (!fs.existsSync(nfoPath) && fs.existsSync(jsonPath)) {
        try {
            const data = JSON.parse(
                fs.readFileSync(jsonPath, "utf8")
            );

            fs.writeFileSync(
                nfoPath,
                generateChannelNfo(data),
                "utf8"
            );

            log(`Created channel NFO: ${channelId}`);
        } catch (error) {
            log(`Channel NFO failed: ${error.message}`);
        }
    }

    if (fs.existsSync(webpPath) && !fs.existsSync(jpgPath)) {
        try {
            await sharp(webpPath).toFile(jpgPath);
            log(`Created channel thumbnail: ${channelId}`);
        } catch (error) {
            log(`Channel thumbnail failed: ${error.message}`);
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
        throw new Error(`Video not found: ${filePath}`);
    }

    if (!fs.existsSync(jsonPath)) {
        log(`Fetching metadata: ${videoId}`);

        runYtDlp(
            `https://www.youtube.com/watch?v=${videoId}`,
            base
        );

        sleepMs(400);

        if (!fs.existsSync(jsonPath)) {
            throw new Error(`Info JSON not created: ${jsonPath}`);
        }
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

        log(`Created video NFO: ${videoId}`);
    }

    let thumbnailStatus = "not_available";

    if (fs.existsSync(webpPath)) {
        if (!fs.existsSync(jpgPath)) {
            await sharp(webpPath).toFile(jpgPath);
            log(`Converted thumbnail: ${videoId}`);
        }

        thumbnailStatus = fs.existsSync(jpgPath)
            ? "completed"
            : "pending";
    } else if (fs.existsSync(jpgPath)) {
        thumbnailStatus = "completed";
    }

    return {
        nfoExists: fs.existsSync(nfoPath),
        thumbnailStatus
    };
}

// ============================================================
// TRACKING COLLECTION
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

    try {
        await client.connect();

        const db = client.db(DB_NAME);
        const source = db.collection(SOURCE_COLLECTION);
        const jobs = db.collection(TRACKING_COLLECTION);

        await jobs.createIndex(
            { youtubeId: 1 },
            { unique: true }
        );

        log("MongoDB connected");
        log(`Media root: ${MEDIA_ROOT}`);
        log(`Read-only source: ${DB_NAME}.${SOURCE_COLLECTION}`);
        log(`Tracking: ${DB_NAME}.${TRACKING_COLLECTION}`);

        if (!fs.existsSync(MEDIA_ROOT)) {
            throw new Error(`Media root not found: ${MEDIA_ROOT}`);
        }

        // READ ONLY: no writes to jellyfin_sync.
        const cursor = source.find({
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
        });

        for await (const record of cursor) {
            const youtubeId = record.youtubeId;

            let videoPath;

            try {
                videoPath = resolveMediaPath(record.mediaPath);
            } catch (error) {
                log(`Skipping ${youtubeId}: ${error.message}`);
                skipped++;
                continue;
            }

            if (!fs.existsSync(videoPath)) {
                skipped++;
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
                !fs.existsSync(webpPath);

            if (
                job?.status === "completed" &&
                nfoReady &&
                thumbnailReady
            ) {
                skipped++;
                continue;
            }

            try {
                await updateJob(jobs, youtubeId, {
                    mediaPath: record.mediaPath,
                    nfoPath: path.relative(MEDIA_ROOT, nfoPath),
                    status: "processing",
                    lastError: null,
                    startedAt: new Date()
                });

                log(`Processing video: ${youtubeId}`);

                await processChannel(folderPath, channelId);

                const result = await processVideo(videoPath);

                if (!result.nfoExists) {
                    throw new Error("NFO file missing after processing");
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
                }
            } catch (error) {
                failed++;

                log(`Failed ${youtubeId}: ${error.message}`);

                await updateJob(jobs, youtubeId, {
                    mediaPath: record.mediaPath,
                    status: "failed",
                    lastError: error.message,
                    failedAt: new Date()
                });
            }
        }

        log("========================================");
        log(`Completed: ${processed}`);
        log(`Skipped: ${skipped}`);
        log(`Failed: ${failed}`);
        log("Processing run finished");
    } finally {
        await client.close();
    }
}

main().catch(error => {
    log(`Fatal error: ${error.stack || error.message}`);
    process.exitCode = 1;
});
