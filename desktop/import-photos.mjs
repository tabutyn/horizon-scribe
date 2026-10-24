import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import sharp from "sharp";
import { options, writeJSON, isMain } from "./lib.mjs";

export async function importPhotos({ input, output, set = "photos" }) {
  if (!/^[A-Za-z0-9_-]+$/.test(set))
    throw new Error("Set ID must use letters, digits, hyphens, or underscores");
  const entries = (await readdir(input, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && /\.(jpg|jpeg|png|webp)$/i.test(entry.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!entries.length)
    throw new Error(
      "No JPEG, PNG, or WebP photos found in the input folder (non-recursive)",
    );
  await mkdir(output); // A fresh directory prevents accidental overwrites.
  await mkdir(join(output, "photos"));
  await mkdir(join(output, "masks"));
  const images = [];
  for (const [index, entry] of entries.entries()) {
    const name = `${String(index + 1).padStart(5, "0")}-${entry.name.slice(0, -extname(entry.name).length).replace(/[^A-Za-z0-9_-]/g, "_")}.jpg`;
    const photo = `photos/${name}`,
      baseMask = `masks/${name}.png`;
    const { data, info } = await sharp(resolve(input, entry.name))
      .rotate()
      .flatten({ background: "#fff" })
      .jpeg({ quality: 95 })
      .toBuffer({ resolveWithObject: true });
    if (info.width > 8192 || info.height > 8192)
      throw new Error(
        `Photo exceeds the iPad's 8192-pixel dimension limit: ${entry.name}`,
      );
    await writeFile(join(output, photo), data, { flag: "wx" }); // EXIF/GPS stripped by default; original remains unchanged.
    await sharp(Buffer.alloc(info.width * info.height, 255), {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .toColourspace("b-w")
      .png()
      .toFile(join(output, baseMask));
    images.push({
      name,
      width: info.width,
      height: info.height,
      photo,
      baseMask,
    });
  }
  const source = join(output, "source.json");
  await writeJSON(source, {
    schema: "horizon-scribe-source/v1",
    sets: [{ id: set, label: set, images }],
  });
  return {
    source: resolve(source),
    images: images.length,
    note: "All-white base masks are placeholders, not model predictions or human labels.",
  };
}

if (isMain(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(
        await importPhotos(
          options(
            process.argv.slice(2),
            { input: null, output: null, set: "photos" },
            ["input", "output"],
          ),
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`import-photos: ${error.message}`);
    process.exitCode = 1;
  }
}
