import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeFetch } from "@/utils/safe-fetch";

const OLLAMA_URL = process.env["OLLAMA_URL"] || "http://localhost:11434";
const MODEL = process.env["OLLAMA_EMBED_MODEL"] || "nomic-embed-text";

const QDRANT_URL = process.env["QDRANT_URL"] || "http://localhost:6333";
const QDRANT_COLLECTION =
  process.env["QDRANT_COLLECTION"] || "component_docs_chunks";

async function embed(text: string) {
  const res = await safeFetch<{ embeddings: number[][] }>(
    `${OLLAMA_URL}/api/embed`,
    {
      method: "POST",
      label: "Ollama 向量化",
      timeoutMs: 30_000,
      body: JSON.stringify({ model: MODEL, input: text }),
    },
  );

  if (!res.ok) {
    throw new Error(res.error);
  }

  if (!Array.isArray(res.data.embeddings)) {
    throw new Error("Ollama 响应格式异常: embeddings 字段缺失");
  }

  const embedding = res.data.embeddings[0];
  if (!embedding) {
    throw new Error("Ollama 响应格式异常: embeddings 为空");
  }
  return embedding;
}

interface QdrantSearchPoint {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

interface QdrantSearchResponse {
  result: QdrantSearchPoint[];
}

async function matchVector(
  vector: number[],
  topK: number,
): Promise<QdrantSearchPoint[]> {
  const res = await safeFetch<QdrantSearchResponse>(
    `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/search`,
    {
      method: "POST",
      label: "Qdrant 向量检索",
      timeoutMs: 15_000,
      body: JSON.stringify({ vector, limit: topK, with_payload: true }),
    },
  );

  if (!res.ok) {
    throw new Error(res.error);
  }
  return res.data.result ?? [];
}

async function search(query: string, topK: number) {
  const vector = await embed(query);
  return matchVector(vector, topK);
}

export const searchComponentDocs = tool(
  async ({ query }) => {
    try {
      const results = await search(query, 5);
      return JSON.stringify(results);
    } catch (error) {
      console.error("Error in searchComponentDocs:", error);
      return JSON.stringify({ error: "Failed to search component docs" });
    }
  },
  {
    name: "searchComponentDocs",
    description:
      "搜索公司内部组件库文档，查找与用户需求匹配的组件用法。调用时必须将用户的原始问题完整填入 query 参数。",
    schema: z.object({
      query: z.string().describe("搜索查询文本"),
    }),
  },
);
