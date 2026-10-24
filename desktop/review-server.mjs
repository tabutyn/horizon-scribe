import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import {
  options,
  readJSON,
  atomicJSON,
  containedFile,
  identity,
  isMain,
} from "./lib.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const ui = fileURLToPath(new URL("./review/", import.meta.url));
const errorWithStatus = (message, status = 400) =>
  Object.assign(new Error(message), { status });

export function validateSelection(value, manifest) {
  if (
    value?.schema !== "horizon-scribe-next-batch-source/v1" ||
    value.datasetId !== manifest.datasetId ||
    !Array.isArray(value.images) ||
    value.images.length > 500
  )
    throw errorWithStatus(
      "Selection must match this dataset and contain at most 500 images",
    );
  const available = new Set(
      manifest.images.map((row) => identity(row.setId, row.image)),
    ),
    seen = new Set();
  const images = value.images.map((row, rank) => {
    const key = identity(row?.setId, row?.image);
    if (!available.has(key) || seen.has(key))
      throw errorWithStatus("Unknown or duplicate selection");
    seen.add(key);
    return { setId: row.setId, image: row.image, rank };
  });
  return {
    schema: value.schema,
    datasetId: manifest.datasetId,
    runId: manifest.runId,
    modelId: manifest.modelId,
    predictionSetId: manifest.predictionSetId,
    images,
  };
}

export async function startReviewServer({ bundle, port = 4317 }) {
  const root = resolve(bundle),
    manifest = await readJSON(join(root, "manifest.json"));
  if (
    manifest.schema !== "horizon-scribe-review-bundle/v1" ||
    !/^[a-f0-9]{64}$/.test(manifest.datasetId) ||
    !Array.isArray(manifest.images) ||
    manifest.images.some((row, index) => row.index !== index)
  )
    throw new Error("Invalid review bundle");
  const selectionPath = join(root, "next-batch.json");
  let selected = validateSelection(
    {
      schema: "horizon-scribe-next-batch-source/v1",
      datasetId: manifest.datasetId,
      images: [],
    },
    manifest,
  );
  try {
    selected = validateSelection(await readJSON(selectionPath), manifest);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let revision = 0,
    writeChain = Promise.resolve();
  const server = http.createServer(async (request, response) => {
    const send = (status, value, contentType = "application/json") => {
      response.writeHead(status, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        "Referrer-Policy": "no-referrer",
      });
      response.end(
        typeof value === "string" || Buffer.isBuffer(value)
          ? value
          : JSON.stringify(value),
      );
    };
    try {
      const host = `127.0.0.1:${server.address().port}`,
        origin = `http://${host}`;
      if (
        request.headers.host !== host ||
        (request.headers.origin && request.headers.origin !== origin) ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw errorWithStatus("Local same-origin access required", 403);
      const url = new URL(request.url, origin);
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        return send(200, await readFile(join(ui, name)), type);
      }
      if (request.method === "GET" && url.pathname === "/api/catalog")
        return send(200, {
          ...manifest,
          selection: selected,
          selectionRevision: revision,
        });
      if (request.method === "GET" && url.pathname === "/api/selection")
        return send(200, selected);
      const media = /^\/media\/(\d+)\.(photo|overlay)\.jpg$/.exec(url.pathname);
      if (
        request.method === "GET" &&
        media &&
        manifest.images[Number(media[1])]
      )
        return send(
          200,
          await readFile(
            await containedFile(
              root,
              `media/${Number(media[1])}.${media[2]}.jpg`,
            ),
          ),
          "image/jpeg",
        );
      if (request.method === "PUT" && url.pathname === "/api/selection") {
        if (
          request.headers["content-type"]?.split(";")[0] !== "application/json"
        )
          throw errorWithStatus("JSON required", 415);
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 512 * 1024)
            throw errorWithStatus("Selection too large", 413);
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw errorWithStatus("Invalid JSON");
        }
        const next = validateSelection(body, manifest);
        const save = writeChain.then(async () => {
          if (body.selectionRevision !== revision)
            throw errorWithStatus(
              "Selection changed in another tab; reload before editing",
              409,
            );
          await atomicJSON(selectionPath, next);
          selected = next;
          revision++;
        });
        writeChain = save.catch(() => {});
        await save;
        return send(200, {
          ok: true,
          selection: selected,
          selectionRevision: revision,
        });
      }
      throw errorWithStatus("Not found", 404);
    } catch (error) {
      if (!response.headersSent)
        send(error.status || 500, {
          error: error.status
            ? error.message
            : "Local review operation failed; check the bundle and filesystem permissions",
        });
      else response.end();
    }
  });
  server.requestTimeout = 15000;
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(Number(port), "127.0.0.1", done);
  });
  return server;
}

if (isMain(import.meta.url)) {
  try {
    const args = options(
      process.argv.slice(2),
      { bundle: null, port: "4317" },
      ["bundle"],
    );
    if (!/^\d+$/.test(args.port) || Number(args.port) > 65535)
      throw new Error("Port must be 0–65535");
    const server = await startReviewServer(args);
    console.log(
      `HorizonScribe Next Round: http://127.0.0.1:${server.address().port}\nSelections saved to ${resolve(args.bundle, "next-batch.json")}\nLocal only. No cloud upload occurs here. Ctrl+C to stop.`,
    );
  } catch (error) {
    console.error(`review-server: ${error.message}`);
    process.exitCode = 1;
  }
}
