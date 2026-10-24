import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wranglerCLI } from "../wrangler-upload.mjs";
import { uploadOne } from "../upload-r2.mjs";
import { sha256 } from "../lib.mjs";

test("resolves the pinned Wrangler executable without downloading another version", () => {
  const output = execFileSync(process.execPath, [wranglerCLI(), "--version"], {
    encoding: "utf8",
  });
  assert.match(output, /4\.152\.0/);
});
test("S3 immutable writes are conditional and verified; conflicting objects are not replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "horizon-scribe-upload-")),
    path = join(root, "blob"),
    bytes = Buffer.from("synthetic");
  await writeFile(path, bytes);
  const record = {
    localPath: path,
    key: "prefix/blob",
    bytes: bytes.length,
    sha256: sha256(bytes),
    contentType: "application/octet-stream",
    cacheControl: "private",
    immutable: true,
  };
  let head = null,
    puts = 0;
  const client = {
    async send(command) {
      if (command.constructor.name === "HeadObjectCommand") {
        if (!head)
          throw Object.assign(new Error("missing"), {
            $metadata: { httpStatusCode: 404 },
          });
        return head;
      }
      puts++;
      assert.equal(command.input.IfNoneMatch, "*");
      for await (const chunk of command.input.Body)
        assert.deepEqual(chunk, bytes);
      head = {
        ContentLength: bytes.length,
        Metadata: { sha256: record.sha256 },
      };
      return {};
    },
  };
  assert.equal(await uploadOne(client, "bucket", record), "uploaded");
  assert.equal(await uploadOne(client, "bucket", record), "skipped");
  assert.equal(puts, 1);
  head.Metadata.sha256 = "f".repeat(64);
  await assert.rejects(uploadOne(client, "bucket", record), /Immutable/);
  assert.equal(puts, 1);
});
