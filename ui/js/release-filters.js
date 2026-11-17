const PACKAGE_MEDIA = new Set(["blr", "mrt", "cas", "cd", "dc", "dvd", "flp", "gdr", "mem", "nod", "umd"]);
const DOWNLOAD_MEDIA = new Set(["in", "dc"]);

export function defaultReleaseMedium(value) {
  if (value === undefined || value === "" || value === "package" || value === "download") {
    return value || "";
  }
  console.error("Invalid default release medium:", value);
  return "";
}

export function releaseMediaKinds(release) {
  const kinds = new Set();
  for (const { medium } of release.media) {
    if (PACKAGE_MEDIA.has(medium)) kinds.add("package");
    if (DOWNLOAD_MEDIA.has(medium)) kinds.add("download");
    if (!PACKAGE_MEDIA.has(medium) && !DOWNLOAD_MEDIA.has(medium)) kinds.add("other");
  }
  if (!release.media.length) kinds.add("other");
  return kinds;
}

export function matchesRelease(release, vnId, { productOnly, language, medium, platform }) {
  if (productOnly && (
    !release.official ||
    release.patch ||
    !release.vns.some((vn) => vn.id === vnId && (vn.rtype === "partial" || vn.rtype === "complete"))
  )) return false;
  if (language && !release.languages.some((item) => item.lang === language)) return false;
  if (medium && !releaseMediaKinds(release).has(medium)) return false;
  if (platform === "__unknown" && release.platforms.length) return false;
  if (platform && platform !== "__unknown" && !release.platforms.includes(platform)) return false;
  return true;
}
