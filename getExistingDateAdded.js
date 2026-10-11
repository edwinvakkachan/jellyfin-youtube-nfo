import fs from "node:fs";
import path from "node:path";

export function getExistingDateAdded(nfoPath) {
  if (!fs.existsSync(nfoPath)) return "";

  try {
    const nfo = fs.readFileSync(nfoPath, "utf8");

    const match = nfo.match(
      /<dateadded>([\s\S]*?)<\/dateadded>/i
    );

    return match ? match[1].trim() : "";
  } catch (error) {
    log(`⚠️ Could not read existing dateadded: ${error.message}`);
    return "";
  }
}