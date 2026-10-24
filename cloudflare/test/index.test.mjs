import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import worker from "../src/index.mjs";

const PREFIX = "production/horizon-scribe/v1",
  DATASET = "a".repeat(64),
  PHOTO_SHA = "b".repeat(64),
  VALID_TOKEN = "v".repeat(43);
function fixture() {
  const descriptor = {
    bytes: 4,
    contentType: "image/jpeg",
    key: `${PREFIX}/blobs/sha256/${PHOTO_SHA.slice(0, 2)}/${PHOTO_SHA}`,
    sha256: PHOTO_SHA,
  };
  const manifest = {
      schema: "horizon-scribe-r2-snapshot/v1",
      datasetId: DATASET,
      prefix: PREFIX,
      sets: [
        {
          id: "set-01",
          label: "Set 1",
          scene: null,
          images: [
            {
              name: "frame.JPG",
              width: 2,
              height: 1,
              photo: descriptor,
              baseMask: null,
              review: null,
            },
          ],
        },
      ],
    },
    raw = JSON.stringify(manifest),
    manifestSha = createHash("sha256").update(raw).digest("hex"),
    manifestKey = `${PREFIX}/snapshots/${DATASET}/manifest.json`;
  const current = JSON.stringify({
      schema: "horizon-scribe-r2-current/v1",
      datasetId: DATASET,
      manifest: { key: manifestKey, sha256: manifestSha },
    }),
    objects = new Map([
      [`${PREFIX}/current.json`, current],
      [manifestKey, raw],
      [descriptor.key, Buffer.from("jpeg")],
    ]),
    versions = new Map([...objects.keys()].map((key) => [key, 1]));
  const bucket = {
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      const etag = "etag-" + String(versions.get(key) || 1);
      if (Buffer.isBuffer(value))
        return {
          body: value,
          size: value.length,
          httpEtag: '"' + etag + '"',
          etag,
        };
      return { text: async () => value, size: Buffer.byteLength(value), etag };
    },
    async head(key) {
      const value = objects.get(key);
      return Buffer.isBuffer(value)
        ? { size: value.length, httpEtag: '"etag"' }
        : null;
    },
    async put(key, value, options = {}) {
      const existing = objects.has(key),
        etag = existing ? "etag-" + String(versions.get(key) || 1) : null,
        condition = options.onlyIf || {};
      if (condition.etagDoesNotMatch === "*" && existing) return null;
      if (condition.etagMatches && condition.etagMatches !== etag) return null;
      objects.set(key, Buffer.isBuffer(value) ? value : String(value));
      versions.set(key, (versions.get(key) || 0) + 1);
      return { etag: "etag-" + String(versions.get(key)) };
    },
  };
  return {
    env: {
      ALLOWED_ORIGINS: "https://dashboard.example",
      HORIZON_SCRIBE_PREFIX: PREFIX,
      HORIZON_SCRIBE_BUCKET: bucket,
      HORIZON_SCRIBE_API_TOKEN: VALID_TOKEN,
    },
    descriptor,
    objects,
  };
}
function request(
  path,
  {
    authorization = VALID_TOKEN,
    origin = "https://dashboard.example",
    method = "GET",
    body,
  } = {},
) {
  return new Request(`https://horizon-scribe.example${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
    },
    body,
  });
}

test("serves only a manifest-resolved object to the configured API token", async () => {
  const { env } = fixture(),
    response = await worker.fetch(
      request("/v1/asset?set=set-01&image=frame.JPG&artifact=photo"),
      env,
    );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://dashboard.example",
  );
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.equal(await response.text(), "jpeg");
});
test("rejects missing tokens, hostile origins, and arbitrary object keys", async () => {
  const { env } = fixture();
  let response = await worker.fetch(
    request("/v1/asset?set=set-01&image=frame.JPG&artifact=photo", {
      authorization: "",
    }),
    env,
  );
  assert.equal(response.status, 401);
  response = await worker.fetch(
    request("/v1/asset?set=set-01&image=frame.JPG&artifact=photo", {
      origin: "https://attacker.example",
    }),
    env,
  );
  assert.equal(response.status, 403);
  response = await worker.fetch(
    request("/v1/asset?set=set-01&image=frame.JPG&artifact=../../secret"),
    env,
  );
  assert.equal(response.status, 400);
});
test("rejects a different well-formed API token", async () => {
  const { env } = fixture(),
    response = await worker.fetch(
      request("/v1/asset?set=set-01&image=frame.JPG&artifact=photo", {
        authorization: "x".repeat(43),
      }),
      env,
    );
  assert.equal(response.status, 401);
});
test("exposes health without credentials", async () => {
  const { env } = fixture(),
    response = await worker.fetch(
      request("/health", { authorization: "", origin: "" }),
      env,
    );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "horizon-scribe",
  });
});
test("saves a cloud review revision and reflects it in the catalog", async () => {
  const { env } = fixture(),
    edit = {
      schema: "horizon-scribe-cloud-review-edit/v1",
      representation: "full-class-raster/v1",
      humanReviewed: true,
      localBaseRevision: null,
      cloudBaseRevision: null,
      operationId: "operation-00000001",
      approved: true,
      rows: [
        {
          y: 0,
          runs: [
            [0, 1, 1],
            [1, 2, 2],
          ],
        },
      ],
    };
  let response = await worker.fetch(
    request("/v1/sets/set-01/images/frame.JPG", {
      method: "PUT",
      body: JSON.stringify(edit),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.match(saved.correction.revision, /^[a-f0-9]{64}$/);
  assert.equal(saved.correction.approved, true);
  assert.deepEqual(saved.correction.rows, edit.rows);
  response = await worker.fetch(
    request("/v1/sets/set-01/images/frame.JPG", {
      method: "PUT",
      body: JSON.stringify(edit),
    }),
    env,
  );
  assert.equal(response.status, 409);
  response = await worker.fetch(request("/v1/catalog"), env);
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.sets[0].images[0].approved, true);
  assert.equal(catalog.sets[0].images[0].snapshotApproved, false);
  assert.equal(
    catalog.sets[0].images[0].cloudRevision,
    saved.correction.revision,
  );
});

test("publishes an exact dataset-bound next pass and uses it for training progress", async () => {
  const { env, objects } = fixture(),
    key = `${PREFIX}/next-pass/${DATASET}/current.json`;
  objects.set(
    key,
    JSON.stringify({
      schema: "horizon-scribe-next-pass-selection/v1",
      datasetId: DATASET,
      runId: "run-1",
      updatedAt: "2026-10-02T21:08:04.128Z",
      selectedImages: [{ setId: "set-01", image: "frame.JPG", rank: 5 }],
    }),
  );
  let response = await worker.fetch(request("/v1/catalog"), env);
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.nextPass.selectedImages.length, 1);
  assert.deepEqual(body.nextPass.selectedImages[0], {
    setId: "set-01",
    image: "frame.JPG",
    rank: 5,
  });
  response = await worker.fetch(request("/v1/training-manifest"), env);
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.counts.nextPassTotal, 1);
  assert.equal(body.counts.nextPassCompleted, 0);
  assert.equal(body.counts.nextPassPending, 1);
});

test("rejects stale dataset state reads and writes before touching reviews", async () => {
  const { env } = fixture();
  for (const method of ["GET", "PUT"]) {
    const response = await worker.fetch(
      request(`/v1/sets/set-01/images/frame.JPG?dataset=${"c".repeat(64)}`, {
        method,
        body: method === "PUT" ? "{}" : undefined,
      }),
      env,
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "DATASET_STALE");
  }
});

test("normal saves retain earlier revisions and reject incomplete or invalid masks", async () => {
  const { env, objects } = fixture();
  const edit = {
    schema: "horizon-scribe-cloud-review-edit/v1",
    representation: "full-class-raster/v1",
    humanReviewed: true,
    localBaseRevision: null,
    cloudBaseRevision: null,
    operationId: "operation-00000002",
    approved: false,
    rows: [{ y: 0, runs: [[0, 2, 1]] }],
  };
  const first = await (
    await worker.fetch(
      request("/v1/sets/set-01/images/frame.JPG", {
        method: "PUT",
        body: JSON.stringify(edit),
      }),
      env,
    )
  ).json();
  const updated = {
    ...edit,
    cloudBaseRevision: first.correction.revision,
    operationId: "operation-00000003",
    approved: true,
  };
  const second = await worker.fetch(
    request("/v1/sets/set-01/images/frame.JPG", {
      method: "PUT",
      body: JSON.stringify(updated),
    }),
    env,
  );
  assert.equal(second.status, 200);
  assert.equal(
    [...objects.keys()].filter((key) => key.includes("/revisions/")).length,
    2,
  );
  for (const rows of [
    [],
    [{ y: 0, runs: [[0, 1, 1]] }],
    [{ y: 0, runs: [[0, 2, 4]] }],
  ]) {
    const response = await worker.fetch(
      request("/v1/sets/set-01/images/frame.JPG", {
        method: "PUT",
        body: JSON.stringify({ ...edit, rows }),
      }),
      env,
    );
    assert.equal(response.status, 400);
  }
  const removed = await worker.fetch(
    request("/v1/maintenance/prune-label-history", { method: "POST" }),
    env,
  );
  assert.equal(removed.status, 404);
});

test("snapshot cache does not leak between bucket bindings", async () => {
  const first = fixture();
  await worker.fetch(request("/v1/catalog"), first.env);
  const second = fixture();
  second.objects.delete(`${PREFIX}/current.json`);
  const response = await worker.fetch(request("/v1/catalog"), second.env);
  assert.equal(response.status, 503);
});

test("catalog index retries a conditional-write conflict", async () => {
  const { env } = fixture(),
    originalPut = env.HORIZON_SCRIBE_BUCKET.put;
  let conflict = true;
  env.HORIZON_SCRIBE_BUCKET.put = async (key, value, options) => {
    if (key.endsWith("/index.json") && conflict) {
      conflict = false;
      return null;
    }
    return originalPut(key, value, options);
  };
  const edit = {
    schema: "horizon-scribe-cloud-review-edit/v1",
    representation: "full-class-raster/v1",
    humanReviewed: true,
    localBaseRevision: null,
    cloudBaseRevision: null,
    operationId: "operation-retry-01",
    approved: true,
    rows: [{ y: 0, runs: [[0, 2, 3]] }],
  };
  assert.equal(
    (
      await worker.fetch(
        request("/v1/sets/set-01/images/frame.JPG", {
          method: "PUT",
          body: JSON.stringify(edit),
        }),
        env,
      )
    ).status,
    200,
  );
  const catalog = await (
    await worker.fetch(request("/v1/catalog"), env)
  ).json();
  assert.equal(catalog.sets[0].images[0].approved, true);
});
