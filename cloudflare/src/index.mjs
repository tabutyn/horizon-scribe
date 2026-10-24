var __defProp = Object.defineProperty;
var __name = (target, value) =>
  __defProp(target, "name", { value, configurable: true });

// src/index.mjs
var CURRENT_SCHEMA = "horizon-scribe-r2-current/v1";
var SNAPSHOT_SCHEMA = "horizon-scribe-r2-snapshot/v1";
var HEX64 = /^[a-f0-9]{64}$/;
var CURRENT_CACHE_MS = 15e3;
var ALLOWED_ARTIFACTS = /* @__PURE__ */ new Set([
  "photo",
  "baseMask",
  "classMask",
  "effectiveMask",
  "scene",
]);
var CLOUD_EDIT_SCHEMA = "horizon-scribe-cloud-review-edit/v1";
var CLOUD_REVISION_SCHEMA = "horizon-scribe-cloud-review-revision/v1";
var CLOUD_POINTER_SCHEMA = "horizon-scribe-cloud-review-current/v1";
var NEXT_PASS_SCHEMA = "horizon-scribe-next-pass-selection/v1";
var FULL_LABEL_STATE = "full-class-raster/v1";
var LEGACY_OVERRIDES = "sparse-overrides/v1";
var SNAPSHOT_OVERRIDES = "snapshot-class-mask/v1";
var MODEL_BASE_STATE = "model-base-mask/v1";
var snapshotCache = null;
function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
__name(json, "json");
function corsHeaders(origin, allowed) {
  return allowed && origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
        "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, OPTIONS",
        "Access-Control-Expose-Headers":
          "Accept-Ranges, Content-Length, Content-Range, ETag",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      }
    : {};
}
__name(corsHeaders, "corsHeaders");
async function verifyToken(token, env) {
  const expected = String(env.HORIZON_SCRIBE_API_TOKEN || "");
  if (
    token.length < 32 ||
    expected.length < 32 ||
    token.length > 256 ||
    expected.length > 256
  )
    return null;
  const [actualDigest, expectedDigest] = await Promise.all([
    sha256Hex(token),
    sha256Hex(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < actualDigest.length; index += 1)
    difference |=
      actualDigest.charCodeAt(index) ^ expectedDigest.charCodeAt(index);
  return difference === 0 ? { uid: "self-hosted" } : null;
}
__name(verifyToken, "verifyToken");
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
__name(sha256Hex, "sha256Hex");
function validDescriptor(value, prefix) {
  if (!value || typeof value !== "object") return false;
  const sha = String(value.sha256 || "").toLowerCase(),
    bytes = Number(value.bytes);
  return (
    HEX64.test(sha) &&
    value.key === `${prefix}/blobs/sha256/${sha.slice(0, 2)}/${sha}` &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0 &&
    typeof value.contentType === "string" &&
    value.contentType.length > 0 &&
    value.contentType.length <= 128
  );
}
__name(validDescriptor, "validDescriptor");
async function r2Text(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  return object.text();
}
__name(r2Text, "r2Text");
async function loadSnapshot(env) {
  const now = Date.now();
  const prefix = String(
    env.HORIZON_SCRIBE_PREFIX || "production/horizon-scribe/v1",
  ).replace(/^\/+|\/+$/g, "");
  if (
    snapshotCache &&
    snapshotCache.bucket === env.HORIZON_SCRIBE_BUCKET &&
    snapshotCache.value.prefix === prefix &&
    snapshotCache.expiresAtMs > now
  )
    return snapshotCache.value;
  const currentRaw = await r2Text(
    env.HORIZON_SCRIBE_BUCKET,
    `${prefix}/current.json`,
  );
  if (!currentRaw) throw new Error("CURRENT_UNAVAILABLE");
  let current;
  try {
    current = JSON.parse(currentRaw);
  } catch {
    throw new Error("INVALID_CURRENT");
  }
  const datasetId = String(current?.datasetId || "").toLowerCase(),
    manifestKey = `${prefix}/snapshots/${datasetId}/manifest.json`,
    manifestSha = String(current?.manifest?.sha256 || "").toLowerCase();
  if (
    current?.schema !== CURRENT_SCHEMA ||
    !HEX64.test(datasetId) ||
    current?.manifest?.key !== manifestKey ||
    !HEX64.test(manifestSha)
  )
    throw new Error("INVALID_CURRENT");
  const manifestRaw = await r2Text(env.HORIZON_SCRIBE_BUCKET, manifestKey);
  if (!manifestRaw || (await sha256Hex(manifestRaw)) !== manifestSha)
    throw new Error("INVALID_MANIFEST");
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    throw new Error("INVALID_MANIFEST");
  }
  if (
    manifest?.schema !== SNAPSHOT_SCHEMA ||
    manifest?.datasetId !== datasetId ||
    manifest?.prefix !== prefix ||
    !Array.isArray(manifest?.sets)
  )
    throw new Error("INVALID_MANIFEST");
  const value = { prefix, datasetId, manifest };
  snapshotCache = {
    value,
    bucket: env.HORIZON_SCRIBE_BUCKET,
    expiresAtMs: now + CURRENT_CACHE_MS,
  };
  return value;
}
__name(loadSnapshot, "loadSnapshot");
function resolveDescriptor(snapshot, url) {
  const artifact = String(url.searchParams.get("artifact") || ""),
    setId = String(url.searchParams.get("set") || ""),
    image = String(url.searchParams.get("image") || ""),
    requestedDataset = String(url.searchParams.get("dataset") || "");
  if (requestedDataset && requestedDataset !== snapshot.datasetId)
    throw Object.assign(new Error("DATASET_STALE"), { status: 409 });
  if (!ALLOWED_ARTIFACTS.has(artifact) || !setId || setId.length > 200)
    throw Object.assign(new Error("INVALID_ASSET_REQUEST"), { status: 400 });
  const set = snapshot.manifest.sets.find(
    (candidate) => candidate?.id === setId,
  );
  if (!set) throw Object.assign(new Error("SET_NOT_FOUND"), { status: 404 });
  let descriptor;
  if (artifact === "scene") {
    if (image)
      throw Object.assign(new Error("INVALID_ASSET_REQUEST"), { status: 400 });
    descriptor = set.scene;
  } else {
    if (!image || image.length > 260)
      throw Object.assign(new Error("INVALID_ASSET_REQUEST"), { status: 400 });
    const record = set.images.find((candidate) => candidate?.name === image);
    if (!record)
      throw Object.assign(new Error("IMAGE_NOT_FOUND"), { status: 404 });
    if (artifact === "photo") descriptor = record.photo;
    if (artifact === "baseMask") descriptor = record.baseMask;
    if (artifact === "classMask") descriptor = record.review?.classMask;
    if (artifact === "effectiveMask") descriptor = record.review?.effectiveMask;
  }
  if (!descriptor)
    throw Object.assign(new Error("ASSET_NOT_FOUND"), { status: 404 });
  if (!validDescriptor(descriptor, snapshot.prefix))
    throw new Error("INVALID_MANIFEST");
  return { artifact, descriptor };
}
__name(resolveDescriptor, "resolveDescriptor");
function resolveImage(snapshot, setId, imageName) {
  if (!setId || setId.length > 200 || !imageName || imageName.length > 260)
    throw Object.assign(new Error("INVALID_REVIEW_REQUEST"), { status: 400 });
  const set = snapshot.manifest.sets.find(
    (candidate) => candidate?.id === setId,
  );
  if (!set) throw Object.assign(new Error("SET_NOT_FOUND"), { status: 404 });
  const image = set.images.find((candidate) => candidate?.name === imageName);
  if (!image)
    throw Object.assign(new Error("IMAGE_NOT_FOUND"), { status: 404 });
  return { set, image };
}
__name(resolveImage, "resolveImage");
function reviewRoot(snapshot, setId, imageName) {
  return `${snapshot.prefix}/cloud-reviews/${snapshot.datasetId}/${setId}/${imageName}`;
}
__name(reviewRoot, "reviewRoot");
function validRevision(value) {
  return value === null || HEX64.test(String(value || ""));
}
__name(validRevision, "validRevision");
function canonicalRows(value, width, height) {
  if (!Array.isArray(value))
    throw Object.assign(new Error("INVALID_REVIEW_ROWS"), { status: 400 });
  const rows = [];
  let previousY = -1,
    total = 0;
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !Number.isInteger(entry.y) ||
      entry.y < 0 ||
      entry.y >= height ||
      entry.y <= previousY ||
      !Array.isArray(entry.runs)
    )
      throw Object.assign(new Error("INVALID_REVIEW_ROWS"), { status: 400 });
    let edge = 0,
      previousLabel = 0;
    const runs = [];
    for (const run of entry.runs) {
      if (
        !Array.isArray(run) ||
        run.length !== 3 ||
        !run.every(Number.isInteger)
      )
        throw Object.assign(new Error("INVALID_REVIEW_ROWS"), { status: 400 });
      const [x0, x1, label] = run;
      if (
        x0 < edge ||
        x0 < 0 ||
        x1 <= x0 ||
        x1 > width ||
        label < 1 ||
        label > 3 ||
        (x0 === edge && label === previousLabel)
      )
        throw Object.assign(new Error("INVALID_REVIEW_ROWS"), { status: 400 });
      edge = x1;
      previousLabel = label;
      total += x1 - x0;
      runs.push([x0, x1, label]);
    }
    if (runs.length) rows.push({ y: entry.y, runs });
    previousY = entry.y;
  }
  if (total > width * height)
    throw Object.assign(new Error("INVALID_REVIEW_ROWS"), { status: 400 });
  return rows;
}
__name(canonicalRows, "canonicalRows");
function canonicalFullStateRows(value, width, height) {
  const rows = canonicalRows(value, width, height);
  if (rows.length !== height)
    throw Object.assign(new Error("FULL_LABEL_STATE_REQUIRED"), {
      status: 400,
    });
  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    if (
      row.y !== y ||
      row.runs[0]?.[0] !== 0 ||
      row.runs[row.runs.length - 1]?.[1] !== width
    )
      throw Object.assign(new Error("FULL_LABEL_STATE_REQUIRED"), {
        status: 400,
      });
    for (let index = 1; index < row.runs.length; index += 1)
      if (row.runs[index - 1][1] !== row.runs[index][0])
        throw Object.assign(new Error("FULL_LABEL_STATE_REQUIRED"), {
          status: 400,
        });
  }
  return rows;
}
__name(canonicalFullStateRows, "canonicalFullStateRows");
async function r2JsonObject(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  let value;
  try {
    value = JSON.parse(await object.text());
  } catch {
    throw new Error("INVALID_CLOUD_REVIEW");
  }
  return { object, value };
}
__name(r2JsonObject, "r2JsonObject");
async function loadNextPass(snapshot) {
  const key = `${snapshot.prefix}/next-pass/${snapshot.datasetId}/current.json`,
    raw = await r2Text(snapshot.bucket, key);
  if (!raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_NEXT_PASS");
  }
  if (
    value?.schema !== NEXT_PASS_SCHEMA ||
    value?.datasetId !== snapshot.datasetId ||
    !Array.isArray(value?.selectedImages) ||
    value.selectedImages.length > 500
  )
    throw new Error("INVALID_NEXT_PASS");
  const seen = /* @__PURE__ */ new Set(),
    selectedImages = value.selectedImages.map((entry) => {
      const setId = String(entry?.setId || ""),
        image = String(entry?.image || ""),
        rank = Number(entry?.rank),
        identity = `${setId}\n${image}`;
      if (
        !setId ||
        !image ||
        !Number.isSafeInteger(rank) ||
        rank < 0 ||
        seen.has(identity)
      )
        throw new Error("INVALID_NEXT_PASS");
      resolveImage(snapshot, setId, image);
      seen.add(identity);
      return { setId, image, rank };
    });
  selectedImages.sort(
    (left, right) =>
      left.rank - right.rank ||
      left.setId.localeCompare(right.setId) ||
      left.image.localeCompare(right.image),
  );
  return {
    schema: NEXT_PASS_SCHEMA,
    datasetId: snapshot.datasetId,
    revision: await sha256Hex(raw),
    runId: typeof value.runId === "string" ? value.runId : null,
    modelId: typeof value.modelId === "string" ? value.modelId : null,
    predictionSetId:
      typeof value.predictionSetId === "string" ? value.predictionSetId : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    selectedImages,
  };
}
__name(loadNextPass, "loadNextPass");
async function cloudPointer(snapshot, setId, imageName) {
  return r2JsonObject(
    snapshot.bucket,
    `${reviewRoot(snapshot, setId, imageName)}/current.json`,
  );
}
__name(cloudPointer, "cloudPointer");
function correctionResponse(
  snapshot,
  set,
  image,
  pointer = null,
  parentRows = [],
) {
  const initialRevision = image.review?.revision || null,
    value = pointer?.value || null;
  const representation =
    value?.representation ||
    (value
      ? LEGACY_OVERRIDES
      : image.review?.classMask
        ? SNAPSHOT_OVERRIDES
        : MODEL_BASE_STATE);
  const humanReviewed =
    value?.humanReviewed ??
    (value ? true : Boolean(image.review?.revision || image.review?.approved));
  return {
    schema: "horizon-scribe-cloud-review-state/v1",
    datasetId: snapshot.datasetId,
    setId: set.id,
    image: image.name,
    width: image.width,
    height: image.height,
    correction: {
      revision: value?.cloudRevision || null,
      localBaseRevision: value?.localBaseRevision ?? initialRevision,
      parentRevision: null,
      rows: value?.rows || [],
      parentRows: [],
      approved: value?.approved ?? Boolean(image.review?.approved),
      initialClassMask: !value && Boolean(image.review?.classMask),
      source: value ? "cloud" : "snapshot",
      representation,
      humanReviewed,
    },
  };
}
__name(correctionResponse, "correctionResponse");
async function loadCloudIndex(snapshot) {
  const key = `${snapshot.prefix}/cloud-reviews/${snapshot.datasetId}/index.json`,
    entry = await r2JsonObject(snapshot.bucket, key);
  if (!entry)
    return {
      key,
      value: {
        schema: "horizon-scribe-cloud-review-index/v1",
        datasetId: snapshot.datasetId,
        reviews: {},
      },
    };
  if (
    entry.value?.schema !== "horizon-scribe-cloud-review-index/v1" ||
    entry.value?.datasetId !== snapshot.datasetId ||
    !entry.value?.reviews ||
    typeof entry.value.reviews !== "object"
  )
    throw new Error("INVALID_CLOUD_REVIEW_INDEX");
  return { key, value: entry.value, etag: entry.object.etag };
}
__name(loadCloudIndex, "loadCloudIndex");
async function updateCloudIndex(snapshot, pointer) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const index = await loadCloudIndex(snapshot);
    // Read the authoritative image pointer on every retry; never regress a newer save.
    const latest =
      (await cloudPointer(snapshot, pointer.setId, pointer.image))?.value ||
      pointer;
    const reviews = { ...index.value.reviews },
      setReviews = { ...(reviews[pointer.setId] || {}) };
    setReviews[pointer.image] = {
      cloudRevision: latest.cloudRevision,
      localBaseRevision: latest.localBaseRevision,
      approved: latest.approved,
      humanReviewed: latest.humanReviewed,
      updatedAt: latest.updatedAt,
      representation: latest.representation,
    };
    reviews[pointer.setId] = setReviews;
    const written = await snapshot.bucket.put(
      index.key,
      JSON.stringify({ ...index.value, reviews, updatedAt: latest.updatedAt }),
      {
        onlyIf: index.etag
          ? { etagMatches: index.etag }
          : { etagDoesNotMatch: "*" },
        httpMetadata: {
          contentType: "application/json",
          cacheControl: "no-store",
        },
      },
    );
    if (written) return;
  }
  throw new Error("REVIEW_INDEX_BUSY");
}
__name(updateCloudIndex, "updateCloudIndex");
async function cloudCatalog(snapshot, setId = null) {
  const index = await loadCloudIndex(snapshot),
    nextPass = setId ? null : await loadNextPass(snapshot),
    sourceSets = setId
      ? snapshot.manifest.sets.filter((set) => set.id === setId)
      : snapshot.manifest.sets;
  if (setId && !sourceSets.length)
    throw Object.assign(new Error("SET_NOT_FOUND"), { status: 404 });
  const sets = sourceSets.map((set) => {
    const cloud = index.value.reviews[set.id] || {},
      images = set.images.map((image) => {
        const saved = cloud[image.name],
          labelRepresentation =
            saved?.representation ||
            (saved
              ? LEGACY_OVERRIDES
              : image.review?.classMask
                ? SNAPSHOT_OVERRIDES
                : MODEL_BASE_STATE),
          humanReviewed =
            saved?.humanReviewed ??
            (saved
              ? true
              : Boolean(image.review?.revision || image.review?.approved));
        return {
          name: image.name,
          width: image.width,
          height: image.height,
          revision: saved?.cloudRevision || image.review?.revision || null,
          localRevision: image.review?.revision || null,
          snapshotApproved: Boolean(image.review?.approved),
          approved: saved?.approved ?? Boolean(image.review?.approved),
          humanReviewed,
          cloudRevision: saved?.cloudRevision || null,
          labelRepresentation,
          imageUrl: `/v1/asset?set=${encodeURIComponent(set.id)}&image=${encodeURIComponent(image.name)}&artifact=photo`,
          baseMaskUrl: `/v1/asset?set=${encodeURIComponent(set.id)}&image=${encodeURIComponent(image.name)}&artifact=baseMask`,
        };
      }),
      approved = images.filter((image) => image.approved).length;
    return {
      id: set.id,
      label: set.label,
      sourceProfile: set.sourceProfile,
      images,
      review: {
        approved,
        edited: images.filter((image) => image.revision).length,
        total: images.length,
        complete: approved === images.length,
      },
    };
  });
  return setId
    ? {
        schema: "horizon-scribe-review-set/v1",
        datasetId: snapshot.datasetId,
        ...sets[0],
      }
    : {
        schema: "horizon-scribe-cloud-catalog/v1",
        datasetId: snapshot.datasetId,
        nextPass,
        sets,
      };
}
__name(cloudCatalog, "cloudCatalog");
async function trainingManifest(snapshot) {
  const catalog = await cloudCatalog(snapshot),
    completed = [],
    nextPassCompleted = [];
  for (const set of catalog.sets) {
    for (const image of set.images)
      if (image.approved && image.humanReviewed)
        completed.push({
          setId: set.id,
          setLabel: set.label,
          image: image.name,
          width: image.width,
          height: image.height,
          revision: image.revision,
          representation: image.labelRepresentation,
          stateUrl: `/v1/sets/${encodeURIComponent(set.id)}/images/${encodeURIComponent(image.name)}`,
        });
  }
  if (catalog.nextPass)
    for (const selected of catalog.nextPass.selectedImages) {
      const set = catalog.sets.find(
          (candidate) => candidate.id === selected.setId,
        ),
        image = set?.images.find(
          (candidate) => candidate.name === selected.image,
        );
      if (image?.approved && image.humanReviewed)
        nextPassCompleted.push({
          setId: set.id,
          image: image.name,
          revision: image.revision,
        });
    }
  const ready = completed.filter(
      (image) =>
        image.representation === FULL_LABEL_STATE &&
        HEX64.test(String(image.revision || "")),
    ),
    readyKeys = new Set(
      ready.map(
        (image) => `${image.setId}
${image.image}`,
      ),
    ),
    blocked = completed.filter(
      (image) =>
        !readyKeys.has(`${image.setId}
${image.image}`),
    );
  const completedKeys = new Set(
      completed.map(
        (image) => `${image.setId}
${image.image}`,
      ),
    ),
    overlap = nextPassCompleted.filter((image) =>
      completedKeys.has(`${image.setId}
${image.image}`),
    );
  const nextPassTotal = catalog.nextPass?.selectedImages.length ?? 0;
  return {
    schema: "horizon-scribe-training-manifest/v1",
    datasetId: catalog.datasetId,
    ready: blocked.length === 0,
    counts: {
      completed: completed.length,
      completedFullRaster: ready.length,
      nextPassCompleted: nextPassCompleted.length,
      nextPassTotal,
      nextPassPending: nextPassTotal - nextPassCompleted.length,
      completedNextPassOverlap: overlap.length,
      uniqueTrainingImages: ready.length,
    },
    images: ready,
    blocked,
    nextPassCompleted,
  };
}
__name(trainingManifest, "trainingManifest");
async function saveCloudReview(
  request,
  env,
  snapshot,
  claims,
  setId,
  imageName,
) {
  const { set, image } = resolveImage(snapshot, setId, imageName),
    contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 8 * 1024 * 1024)
    throw Object.assign(new Error("REVIEW_TOO_LARGE"), { status: 413 });
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    throw Object.assign(new Error("INVALID_REVIEW_JSON"), { status: 400 });
  }
  const humanReviewed = body?.humanReviewed ?? true;
  if (
    body?.schema !== CLOUD_EDIT_SCHEMA ||
    body.representation !== FULL_LABEL_STATE ||
    typeof body.approved !== "boolean" ||
    typeof humanReviewed !== "boolean" ||
    !validRevision(body.localBaseRevision) ||
    !validRevision(body.cloudBaseRevision) ||
    !/^[-A-Za-z0-9_]{16,80}$/.test(String(body.operationId || ""))
  )
    throw Object.assign(new Error("INVALID_REVIEW_EDIT"), { status: 400 });
  const rows = canonicalFullStateRows(body.rows, image.width, image.height),
    root = reviewRoot(snapshot, setId, imageName),
    current = await r2JsonObject(
      env.HORIZON_SCRIBE_BUCKET,
      `${root}/current.json`,
    ),
    expectedLocal =
      current?.value?.localBaseRevision ?? image.review?.revision ?? null,
    expectedCloud = current?.value?.cloudRevision ?? null;
  if (
    body.localBaseRevision !== expectedLocal ||
    body.cloudBaseRevision !== expectedCloud
  )
    throw Object.assign(new Error("REVIEW_CONFLICT"), { status: 409 });
  const core = {
      schema: CLOUD_REVISION_SCHEMA,
      datasetId: snapshot.datasetId,
      setId,
      image: imageName,
      localBaseRevision: expectedLocal,
      representation: FULL_LABEL_STATE,
      approved: body.approved,
      humanReviewed,
      rows,
      operationId: body.operationId,
      uid: claims.uid,
    },
    cloudRevision = await sha256Hex(JSON.stringify(core));
  if (current?.value?.cloudRevision === cloudRevision)
    return correctionResponse(
      snapshot,
      set,
      image,
      current,
      current.value.parentRows || [],
    );
  const updatedAt = /* @__PURE__ */ new Date().toISOString(),
    record = { ...core, cloudRevision, updatedAt },
    revisionKey = `${root}/revisions/${cloudRevision}.json`;
  await env.HORIZON_SCRIBE_BUCKET.put(revisionKey, JSON.stringify(record), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/json",
      cacheControl: "private, max-age=31536000, immutable",
    },
    customMetadata: { sha256: cloudRevision },
  });
  const pointer = {
    schema: CLOUD_POINTER_SCHEMA,
    datasetId: snapshot.datasetId,
    setId,
    image: imageName,
    localBaseRevision: expectedLocal,
    cloudRevision,
    representation: FULL_LABEL_STATE,
    approved: body.approved,
    humanReviewed,
    rows,
    updatedAt,
    uid: claims.uid,
  };
  let written;
  try {
    written = await env.HORIZON_SCRIBE_BUCKET.put(
      `${root}/current.json`,
      JSON.stringify(pointer),
      {
        onlyIf: current
          ? { etagMatches: current.object.etag }
          : { etagDoesNotMatch: "*" },
        httpMetadata: {
          contentType: "application/json",
          cacheControl: "no-store",
        },
      },
    );
  } catch {
    throw Object.assign(new Error("REVIEW_CONFLICT"), { status: 409 });
  }
  if (!written)
    throw Object.assign(new Error("REVIEW_CONFLICT"), { status: 409 });
  await updateCloudIndex(
    { ...snapshot, bucket: env.HORIZON_SCRIBE_BUCKET },
    pointer,
  );
  // Retain immutable revisions; a normal save must not destroy earlier labeling work.
  return correctionResponse(snapshot, set, image, { value: pointer });
}
__name(saveCloudReview, "saveCloudReview");
async function assetResponse(request, env, headers) {
  let snapshot, resolved;
  try {
    snapshot = await loadSnapshot(env);
    resolved = resolveDescriptor(snapshot, new URL(request.url));
  } catch (error) {
    const status = Number(error?.status) || 503;
    return json(
      status,
      {
        ok: false,
        error: String(error?.message || "HORIZON_SCRIBE_ASSET_UNAVAILABLE"),
      },
      headers,
    );
  }
  const options = request.headers.has("Range")
    ? { range: request.headers }
    : void 0;
  const object =
    request.method === "HEAD"
      ? await env.HORIZON_SCRIBE_BUCKET.head(resolved.descriptor.key)
      : await env.HORIZON_SCRIBE_BUCKET.get(resolved.descriptor.key, options);
  if (!object)
    return json(503, { ok: false, error: "ASSET_UNAVAILABLE" }, headers);
  if (!object.range && Number(object.size) !== resolved.descriptor.bytes)
    return json(502, { ok: false, error: "ASSET_SIZE_MISMATCH" }, headers);
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", resolved.descriptor.contentType);
  responseHeaders.set("Cache-Control", "private, max-age=3600");
  responseHeaders.set("Accept-Ranges", "bytes");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  if (object.httpEtag) responseHeaders.set("ETag", object.httpEtag);
  if (object.range) {
    const offset = Number(object.range.offset),
      length = Number(object.range.length);
    responseHeaders.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
    responseHeaders.set("Content-Length", String(length));
  } else
    responseHeaders.set("Content-Length", String(resolved.descriptor.bytes));
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: object.range ? 206 : 200,
    headers: responseHeaders,
  });
}
__name(assetResponse, "assetResponse");
async function apiResponse(request, env, headers, claims) {
  const snapshot = {
      ...(await loadSnapshot(env)),
      bucket: env.HORIZON_SCRIBE_BUCKET,
    },
    url = new URL(request.url);
  const requestedDataset = url.searchParams.get("dataset");
  if (requestedDataset !== null && requestedDataset !== snapshot.datasetId)
    throw Object.assign(new Error("DATASET_STALE"), { status: 409 });
  if (request.method === "GET" && url.pathname === "/v1/catalog")
    return json(200, await cloudCatalog(snapshot), headers);
  if (request.method === "GET" && url.pathname === "/v1/next-pass")
    return json(200, await loadNextPass(snapshot), headers);
  if (request.method === "GET" && url.pathname === "/v1/training-manifest")
    return json(200, await trainingManifest(snapshot), headers);
  const setMatch = /^\/v1\/sets\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && setMatch)
    return json(
      200,
      await cloudCatalog(snapshot, decodeURIComponent(setMatch[1])),
      headers,
    );
  const imageMatch = /^\/v1\/sets\/([^/]+)\/images\/([^/]+)$/.exec(
    url.pathname,
  );
  if (imageMatch) {
    const setId = decodeURIComponent(imageMatch[1]),
      imageName = decodeURIComponent(imageMatch[2]),
      { set, image } = resolveImage(snapshot, setId, imageName);
    if (request.method === "GET") {
      const current = await cloudPointer(snapshot, setId, imageName);
      return json(
        200,
        correctionResponse(snapshot, set, image, current),
        headers,
      );
    }
    if (request.method === "PUT")
      return json(
        200,
        await saveCloudReview(request, env, snapshot, claims, setId, imageName),
        headers,
      );
  }
  return json(404, { ok: false, error: "NOT_FOUND" }, headers);
}
__name(apiResponse, "apiResponse");
var index_default = {
  async fetch(request, env) {
    const origin = String(request.headers.get("Origin") || ""),
      selfOrigin = new URL(request.url).origin,
      configuredOrigins = new Set(
        String(env.ALLOWED_ORIGINS || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
      allowed =
        !origin || origin === selfOrigin || configuredOrigins.has(origin),
      headers = corsHeaders(origin, allowed);
    if (!allowed) return json(403, { ok: false, error: "BAD_ORIGIN" });
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return json(200, { ok: true, service: "horizon-scribe" }, headers);
    if (!url.pathname.startsWith("/v1/"))
      return json(404, { ok: false, error: "NOT_FOUND" }, headers);
    const auth = String(request.headers.get("Authorization") || ""),
      match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(auth),
      claims = match ? await verifyToken(match[1], env) : null;
    if (!claims)
      return json(
        401,
        { ok: false, error: "INVALID_HORIZON_SCRIBE_TOKEN" },
        headers,
      );
    if (
      url.pathname === "/v1/asset" &&
      ["GET", "HEAD"].includes(request.method)
    )
      return assetResponse(request, env, headers);
    try {
      return await apiResponse(request, env, headers, claims);
    } catch (error) {
      return json(
        Number(error?.status) || 503,
        {
          ok: false,
          error: String(error?.message || "HORIZON_SCRIBE_CLOUD_UNAVAILABLE"),
        },
        headers,
      );
    }
  },
};
export { index_default as default };
