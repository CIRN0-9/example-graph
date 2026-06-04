/**
 * 向量入库脚本
 *
 * 功能：读取向量化后的 chunks 文件（chunks.vectors.jsonl），
 * 批量写入 Qdrant 向量数据库，供后续 RAG 检索使用。
 *
 * 使用方式：
 *   yarn upsert:component-docs
 *
 * 环境变量：
 *   QDRANT_URL          - Qdrant 服务地址，默认 http://localhost:6333
 *   QDRANT_COLLECTION   - 集合名称，默认 component_docs_chunks
 *   UPSERT_BATCH_SIZE   - 每批写入的点数，默认 64
 *   QDRANT_DISTANCE     - 距离度量方式，默认 Cosine
 *   MAX_DOCS            - 限制入库条数（0=全部），用于调试
 *   DRY_RUN=1           - 仅打印信息，不实际写入
 */
import fs from "fs/promises";
import path from "path";

// ─── 配置项 ───────────────────────────────────────────────

// 输入文件：向量化后的 chunks（由 embedding-chuncks.js 生成）
const INPUT = path.resolve(
  process.cwd(),
  "data",
  "component-docs",
  "chunks.vectors.jsonl",
);

// Qdrant 连接配置
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_COLLECTION =
  process.env.QDRANT_COLLECTION || "component_docs_chunks";

// 每批 upsert 的点数量，避免单次请求体过大
const UPSERT_BATCH_SIZE = Number(process.env.UPSERT_BATCH_SIZE || 64);

// 向量距离度量方式：Cosine（余弦相似度）、Euclid（欧氏距离）、Dot（点积）
const DISTANCE = process.env.QDRANT_DISTANCE || "Cosine";

// 调试用：限制入库条数，0 表示不限制
const MAX_DOCS = Number(process.env.MAX_DOCS || 0);

// 调试用：设为 "1" 时只打印信息，不实际写入 Qdrant
const DRY_RUN = process.env.DRY_RUN === "1";

// ─── 工具函数 ─────────────────────────────────────────────

/**
 * 将字符串转换为无符号 32 位整数 ID（Qdrant 要求 point ID 为数字或 UUID）。
 * 使用 DJB2 哈希算法，确保同一输入始终生成相同 ID。
 * @param {string} seed - 用于生成 ID 的种子字符串
 * @returns {number} 无符号 32 位整数 ID
 */
function numericId(seed) {
  const value = String(seed || "");
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return Math.abs(hash >>> 0);
}

/**
 * 读取 JSONL 文件并解析为对象数组。
 * 如果设置了 MAX_DOCS，则只取前 N 条（用于调试）。
 * @param {string} filePath - JSONL 文件路径
 * @returns {Promise<Object[]>} 解析后的对象数组
 */
async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const rows = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return MAX_DOCS > 0 ? rows.slice(0, MAX_DOCS) : rows;
}

/**
 * 将一个 chunk 行转换为 Qdrant 的 point 格式。
 * point 包含：数字 ID、向量、payload（元数据 + 原文）。
 * @param {Object} row - chunks.vectors.jsonl 中的一行
 * @param {number} index - 该行在文件中的序号（用于生成备用 ID）
 * @returns {{ id: number, vector: number[], payload: Object }}
 */
function toPoint(row, index) {
  return {
    // 用 chunk 的 id 字段生成确定性数字 ID
    id: numericId(row.id || `${row.relPath}-${index}`),
    // 向量数据（768 维，由 Ollama nomic-embed-text 生成）
    vector: row.embedding,
    // payload：检索时返回的元数据和原文
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

// ─── Qdrant 操作函数 ──────────────────────────────────────

/**
 * 确保 Qdrant 中存在指定集合，不存在则自动创建。
 * 创建时会根据第一条向量的维度设置 size，并使用配置的距离度量方式。
 * @param {number} vectorDim - 向量维度（如 768）
 */
async function ensureCollection(vectorDim) {
  const collectionUrl = `${QDRANT_URL}/collections/${QDRANT_COLLECTION}`;
  // 先检查集合是否已存在
  const existsRes = await fetch(collectionUrl);
  if (existsRes.ok) {
    return; // 集合已存在，无需创建
  }

  // 集合不存在，创建新集合
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

/**
 * 向 Qdrant 批量写入（upsert）向量点。
 * 使用 wait=true 确保写入完成后再返回，保证数据一致性。
 * @param {{ id: number, vector: number[], payload: Object }[]} points - 待写入的点数组
 */
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

// ─── 主流程 ───────────────────────────────────────────────

/**
 * 主函数：读取向量化 chunks → 确保集合存在 → 分批 upsert → 打印结果。
 */
async function main() {
  // 1. 读取向量化后的 chunks 文件
  const rows = await readJsonl(INPUT);
  if (rows.length === 0) {
    throw new Error("No vectors found. Please run embed:component-docs first.");
  }

  // 2. 从第一条数据中提取向量维度，用于创建集合
  const firstDim = rows[0]?.embedding?.length || 0;
  if (!firstDim) {
    throw new Error("Invalid vectors: embedding field is missing or empty.");
  }

  // 3. dry-run 模式：仅打印信息，不实际写入
  if (DRY_RUN) {
    console.log("dry-run mode");
    console.log("input =", INPUT);
    console.log("rows =", rows.length);
    console.log("vectorDim =", firstDim);
    console.log("qdrant =", `${QDRANT_URL}/collections/${QDRANT_COLLECTION}`);
    return;
  }

  // 4. 确保集合存在（不存在则自动创建）
  await ensureCollection(firstDim);

  // 5. 分批 upsert：每批 UPSERT_BATCH_SIZE 条，避免请求体过大
  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    // 将每行转换为 Qdrant point 格式
    const points = batch.map((row, j) => toPoint(row, i + j));
    // 写入 Qdrant
    await upsertBatch(points);
    upserted += points.length;
    console.log(`upserted ${upserted}/${rows.length}`);
  }

  // 6. 打印最终结果
  console.log("done");
  console.log("collection =", QDRANT_COLLECTION);
  console.log("vectorDim =", firstDim);
  console.log("upserted =", upserted);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
