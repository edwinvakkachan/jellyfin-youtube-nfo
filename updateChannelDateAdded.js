import fs from "node:fs";
import path from "node:path";

export async function updateChannelDateAdded(folderPath) {
  const channelNfo = path.join(folderPath, "tvshow.nfo");

  if (!fs.existsSync(channelNfo)) {
    return false;
  }

  let content = fs.readFileSync(channelNfo, "utf8");

  const currentDate = new Date().toISOString();

  if (/<dateadded>.*?<\/dateadded>/s.test(content)) {
    content = content.replace(
      /<dateadded>.*?<\/dateadded>/s,
      `<dateadded>${currentDate}</dateadded>`
    );
  } else {
    content = content.replace(
      /<\/tvshow>/i,
      `  <dateadded>${currentDate}</dateadded>\n</tvshow>`
    );
  }

  fs.writeFileSync(channelNfo, content, "utf8");

  log(`📅 Updated channel dateadded: ${path.basename(folderPath)}`);

  return true;
}