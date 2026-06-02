import fs from "fs/promises";
import path from "path";

const INPUT = path.resolve(
  process.cwd(),
  "data",
  "component-docs",
  "chunks.jsonl",
);
const OUTPUT = path.resolve(
  process.cwd(),
  "data",
  "component-docs",
  "chunks.vectors.jsonl",
);

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const BATCH_SIZE = Number(process.env.OLLAMA_BATCH_SIZE || 32);

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function embedBatch(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      input: texts, // 一次传数组，减少请求次数
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
  return data.embeddings;
}

async function main() {
  const chunks = await readJsonl(INPUT);
  const output = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.content || "");
    const vectors = await embedBatch(texts);

    for (let j = 0; j < batch.length; j += 1) {
      output.push({
        ...batch[j],
        embeddingModel: MODEL,
        embeddingDim: vectors[j]?.length || 0,
        embedding: vectors[j],
      });
    }

    console.log(
      `embedded ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`,
    );
  }

  const jsonl = output.map((x) => JSON.stringify(x)).join("\n");
  await fs.writeFile(OUTPUT, jsonl + "\n", "utf8");

  console.log("done");
  console.log("input =", INPUT);
  console.log("output =", OUTPUT);
  console.log("chunks =", output.length);
  console.log("dim =", output[0]?.embeddingDim || 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
