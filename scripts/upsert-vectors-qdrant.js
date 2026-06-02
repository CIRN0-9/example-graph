import fs from "fs/promises";
import path from "path";

const INPUT = path.resolve(
  process.cwd(),
  "data",
  "component-docs",
  "chunks.vectors.jsonl",
);

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_COLLECTION =
  process.env.QDRANT_COLLECTION || "component_docs_chunks";
const UPSERT_BATCH_SIZE = Number(process.env.UPSERT_BATCH_SIZE || 64);
const DISTANCE = process.env.QDRANT_DISTANCE || "Cosine";
const MAX_DOCS = Number(process.env.MAX_DOCS || 0);
const DRY_RUN = process.env.DRY_RUN === "1";

function numericId(seed) {
  const value = String(seed || "");
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return Math.abs(hash >>> 0);
}

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const rows = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return MAX_DOCS > 0 ? rows.slice(0, MAX_DOCS) : rows;
}

function toPoint(row, index) {
  return {
    id: numericId(row.id || `${row.relPath}-${index}`),
    vector: row.embedding,
    payload: {
      id: row.id,
      relPath: row.relPath,
      sourceFile: row.sourceFile,
      title: row.title,
      sectionPath: row.sectionPath,
      chunkType: row.chunkType,
      order: row.order,
      charCount: row.charCount,
      embeddingModel: row.embeddingModel,
      content: row.content,
    },
  };
}

async function ensureCollection(vectorDim) {
  const collectionUrl = `${QDRANT_URL}/collections/${QDRANT_COLLECTION}`;
  const existsRes = await fetch(collectionUrl);
  if (existsRes.ok) {
    return;
  }

  const createRes = await fetch(collectionUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vectors: {
        size: vectorDim,
        distance: DISTANCE,
      },
    }),
  });

  if (!createRes.ok) {
    throw new Error(
      `Create collection failed: ${createRes.status} ${await createRes.text()}`,
    );
  }
}

async function upsertBatch(points) {
  const url = `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points?wait=true`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
  });

  if (!res.ok) {
    throw new Error(`Qdrant upsert failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const rows = await readJsonl(INPUT);
  if (rows.length === 0) {
    throw new Error("No vectors found. Please run embed:component-docs first.");
  }

  const firstDim = rows[0]?.embedding?.length || 0;
  if (!firstDim) {
    throw new Error("Invalid vectors: embedding field is missing or empty.");
  }

  if (DRY_RUN) {
    console.log("dry-run mode");
    console.log("input =", INPUT);
    console.log("rows =", rows.length);
    console.log("vectorDim =", firstDim);
    console.log("qdrant =", `${QDRANT_URL}/collections/${QDRANT_COLLECTION}`);
    return;
  }

  await ensureCollection(firstDim);

  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const points = batch.map((row, j) => toPoint(row, i + j));
    await upsertBatch(points);
    upserted += points.length;
    console.log(`upserted ${upserted}/${rows.length}`);
  }

  console.log("done");
  console.log("collection =", QDRANT_COLLECTION);
  console.log("vectorDim =", firstDim);
  console.log("upserted =", upserted);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
