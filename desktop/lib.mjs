import { createHash } from "node:crypto";
import { readFile, lstat, realpath, writeFile, rename } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export const identity = (setId, image) => JSON.stringify([setId, image]);
export const readJSON = async (path) =>
  JSON.parse(await readFile(path, "utf8"));
export const writeJSON = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
export const isMain = (url) =>
  Boolean(process.argv[1]) &&
  url === pathToFileURL(resolve(process.argv[1])).href;

export function options(args, defaults, required = []) {
  const result = { ...defaults };
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith("--") || !(flag.slice(2) in defaults))
      throw new Error(`Unknown option: ${flag}`);
    const value = args.shift();
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    result[flag.slice(2)] = value;
  }
  for (const key of required)
    if (!result[key]) throw new Error(`--${key} is required`);
  return result;
}

export async function atomicJSON(path, value) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeJSON(temporary, value);
  await rename(temporary, path);
}

export async function containedFile(root, name) {
  if (typeof name !== "string" || isAbsolute(name))
    throw new Error("Invalid relative asset path");
  const base = await realpath(root),
    path = await realpath(resolve(base, name));
  const rel = relative(base, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Asset escapes its bundle");
  if (!(await lstat(path)).isFile()) throw new Error("Asset is not a file");
  return path;
}

export async function verifiedFile(record) {
  if (
    !record ||
    typeof record.localPath !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256)
  )
    throw new Error("Invalid upload evidence");
  const info = await lstat(record.localPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== record.bytes)
    throw new Error("Upload source is missing or changed");
  const bytes = await readFile(record.localPath);
  if (sha256(bytes) !== record.sha256)
    throw new Error("Upload checksum changed");
  return bytes;
}

export async function maskPixels(path, width, height, labels = false) {
  const metadata = await sharp(path).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== width ||
    metadata.height !== height ||
    metadata.channels !== 1 ||
    metadata.depth !== "uchar"
  ) {
    throw new Error(
      "Masks must be same-size, 8-bit, single-channel PNGs (not RGB or palette artwork)",
    );
  }
  const pixels = await sharp(path).toColourspace("b-w").raw().toBuffer();
  if (labels && pixels.some((value) => value > 3))
    throw new Error(
      "Class mask values must be 0 automatic, 1 land, 2 sea, 3 sky",
    );
  if (!labels && pixels.some((value) => value !== 0 && value !== 255))
    throw new Error("Base/effective mask values must be 0 remove or 255 keep");
  return pixels;
}
