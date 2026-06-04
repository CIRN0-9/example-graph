import { tool } from "@langchain/core/tools";
import { z } from "zod";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_COLLECTION =
  process.env.QDRANT_COLLECTION || "component_docs_chunks";

async function embed(text: string) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: text,
    }),
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Ollama embed failed: ${res.status} ${msg}`);
  }

  const data = await res.json();
  if (!Array.isArray(data.embeddings)) {
    throw new Error("Invalid Ollama response: embeddings missing");
  }
  return data.embeddings[0];
}

async function matchVector(vector: number[], topK: number) {
  const res = await fetch(
    `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        vector: vector,
        limit: topK,
        with_payload: true,
      }),
    },
  );

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`QDRANT search failed: ${res.status} ${msg}`);
  }

  return await res.json();
}

async function search(query: string, topK: number) {
  const vector = await embed(query); // 对query进行向量化
  const res = await matchVector(vector, topK); // 根据向量在向量数据库中检索相关文档
  return res;
}

export const searchComponentDocs = tool(
  async ({ query }) => {
    console.log("query", query);
    const results = await search(query, 5);
    console.log("results", results);
    return JSON.stringify(results);
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
