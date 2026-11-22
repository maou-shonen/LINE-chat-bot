import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = 8797;
const DIR = process.env.C_BLOB_DIR ?? "/tmp/c-blob-build-v4";
const SNAPSHOT =
  process.env.C_SNAPSHOT ?? join(homedir(), "linebot-import/line-snapshot-20261121.db");

export default async function setup() {
  const files = readdirSync(DIR)
    .map((name) => ({ name, size: statSync(join(DIR, name)).size }))
    .filter((file) => file.name !== "c-manifest.json");
  const bySize = (list) => [...list].sort((a, b) => b.size - a.size)[0] ?? null;
  const keyword = files.filter((f) => /^keyword-(aho|rows)-(.*)\.bin$/.test(f.name));
  const logs = files.filter((f) => /^c-logs:\d+\.json$/.test(f.name));
  const groups = files.filter((f) => /^c-group:[A-Za-z0-9]+\.json$/.test(f.name));

  const db = new DatabaseSync(SNAPSHOT, { readOnly: true });
  const top = db
    .prepare("SELECT gid, COUNT(*) AS n FROM group_user GROUP BY gid ORDER BY n DESC LIMIT 1")
    .get();
  db.close();
  const file = groups.find((f) => f.name === `c-group:${top.gid}.json`) ?? null;

  const stats = {
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    files: files.length,
    keywordBytes: keyword.reduce((sum, f) => sum + f.size, 0),
    largestGroup: { members: Number(top.n), file: file?.name ?? null, size: file?.size ?? 0 },
    max: {
      aho: bySize(keyword.filter((f) => f.name.startsWith("keyword-aho"))),
      row: bySize(keyword.filter((f) => f.name.startsWith("keyword-rows"))),
      log: bySize(logs),
      group: bySize(groups),
    },
  };

  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.slice(1));
    if (path === "index.json") {
      return send(response, { files, stats });
    }
    const file = files.find((entry) => entry.name === path);
    if (file === undefined) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": file.name.endsWith(".json") ? "application/json" : "application/octet-stream" })
      .end(readFileSync(join(DIR, file.name)));
  });
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  return () => new Promise((resolve) => server.close(resolve));
}

function send(response, value) {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}
