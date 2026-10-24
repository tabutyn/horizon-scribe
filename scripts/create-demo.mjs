import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { isMain, options, writeJSON } from "../desktop/lib.mjs";

export async function createDemo(output) {
  await mkdir(output, { recursive: false });
  const images = [],
    predictions = [];
  const width = 480,
    height = 320;
  for (let index = 0; index < 6; index++) {
    const rgb = Buffer.alloc(width * height * 3),
      labels = Buffer.alloc(width * height),
      base = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sky = y < 105 + index * 4,
          land = !sky && y > 240 - Math.round(35 * Math.sin(x / 70 + index));
        const label = sky ? 3 : land ? 1 : 2;
        const color = sky
          ? [120 + (y % 25), 180, 230]
          : land
            ? [80, 110 + (x % 22), 70]
            : [30, 100 + (y % 18), 155];
        rgb.set(color, (y * width + x) * 3);
        labels[y * width + x] = label;
        base[y * width + x] = land ? 255 : 0;
      }
    // Deliberately wrong small patches make candidate selection visible in the tutorial.
    if (index % 2)
      for (let y = 140; y < 175; y++)
        labels.fill(3, y * width + 220, y * width + 290);
    const name = `synthetic-${index + 1}.png`;
    await sharp(rgb, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(join(output, name));
    await sharp(base, { raw: { width, height, channels: 1 } })
      .toColourspace("b-w")
      .png()
      .toFile(join(output, `${index}.base.png`));
    await sharp(labels, { raw: { width, height, channels: 1 } })
      .toColourspace("b-w")
      .png()
      .toFile(join(output, `${index}.labels.png`));
    images.push({
      name,
      width,
      height,
      photo: name,
      baseMask: `${index}.base.png`,
    });
    predictions.push({
      setId: "demo",
      image: name,
      classMask: `${index}.labels.png`,
      priority: index % 2 ? 1 : 0,
    });
  }
  await writeJSON(join(output, "source.json"), {
    schema: "horizon-scribe-source/v1",
    sets: [
      {
        id: "demo",
        label: "Synthetic tutorial scenes — not photographs",
        images,
      },
    ],
  });
  await writeJSON(join(output, "predictions.json"), {
    schema: "horizon-scribe-predictions-source/v1",
    modelId: "synthetic-demo-not-a-trained-model",
    images: predictions,
  });
  return {
    source: join(output, "source.json"),
    predictions: join(output, "predictions.json"),
    images: images.length,
  };
}

if (isMain(import.meta.url)) {
  try {
    const args = options(process.argv.slice(2), { output: "data/demo" });
    await mkdir("data", { recursive: true });
    console.log(JSON.stringify(await createDemo(args.output), null, 2));
  } catch (error) {
    console.error(`create-demo: ${error.message}`);
    process.exitCode = 1;
  }
}
