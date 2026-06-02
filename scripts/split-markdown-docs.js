import fs from "fs/promises";
import path from "path";

// 默认扫描的 Markdown 文档根目录。脚本通常从 new-project 根目录运行，
// 因此这里会落到 docs-repo/design-docs/docs/component。
const DEFAULT_SOURCE_ROOT = path.resolve(
  process.cwd(),
  "docs-repo",
  "design-docs",
  "docs",
  "component",
);
// 默认输出目录，拆分后的 chunk 数据会写入这里。
const DEFAULT_OUTPUT_DIR = path.resolve(
  process.cwd(),
  "data",
  "component-docs",
);

// 允许通过环境变量覆盖输入目录，便于复用脚本处理别的 Markdown 源。
const SOURCE_ROOT = path.resolve(
  process.env.MARKDOWN_SOURCE_ROOT || DEFAULT_SOURCE_ROOT,
);
// 允许通过环境变量覆盖输出目录。
const OUTPUT_DIR = path.resolve(
  process.env.MARKDOWN_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
);
// 按行写出的 chunk 数据文件，每一行都是一个 JSON 对象。
const OUTPUT_JSONL = path.join(OUTPUT_DIR, "chunks.jsonl");
// 汇总统计信息文件，记录 chunk 数量、来源目录和生成时间等元数据。
const OUTPUT_INDEX = path.join(OUTPUT_DIR, "chunks.index.json");
// 单个 chunk 的硬上限，超过后必须进一步拆分。
const MAX_CHUNK_CHARS = Number(process.env.MARKDOWN_MAX_CHUNK_CHARS || 1800);
// 期望 chunk 接近的目标大小。脚本会尽量按这个大小聚合段落，
// 但不会为了凑满而打散结构化内容。
const TARGET_CHUNK_CHARS = Number(
  process.env.MARKDOWN_TARGET_CHUNK_CHARS || 1200,
);

// 仅处理 Markdown 文件。
function isMarkdownFile(filePath) {
  return filePath.toLowerCase().endsWith(".md");
}

// 统一换行符，避免 Windows/Unix 换行差异影响后续按行和按段落切分。
function normalizeText(text) {
  return text.replace(/\r\n/g, "\n");
}

// 去掉 YAML front matter，避免文档元数据进入检索内容。
// 这里只处理最常见的 --- ... --- 形式。
function stripFrontMatter(lines) {
  if (lines.length < 3 || lines[0].trim() !== "---") {
    return lines;
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      return lines.slice(index + 1);
    }
  }

  return lines;
}

// 解析 Markdown 标题行，只识别标准的 # 到 ###### 形式。
// 返回标题层级和标题文本，供后续维护标题栈。
function parseHeading(line) {
  const match = line.match(/^(#{1,6})\s+(.*)$/);
  if (!match) {
    return null;
  }

  return {
    level: match[1].length,
    title: match[2].trim(),
  };
}

// 根据新标题刷新标题栈。
// 例如当前栈为 H1 > H2，遇到新的 H2 时会替换旧的 H2；
// 遇到 H3 时则会在其后追加，形成 H1 > H2 > H3。
function updateHeadingStack(stack, level, title) {
  const next = stack.filter((item) => item.level < level);
  next.push({ level, title });
  return next;
}

// 将当前标题栈展开成可读路径，便于后续检索或展示上下文。
function getSectionPath(stack) {
  return stack.map((item) => item.title).join(" > ");
}

// 将较长的正文切成多个 chunk。
// 策略是优先以“段落”为单位聚合，尽量保持语义完整；
// 只有段落本身超长时，才按字符长度硬切。
function splitLargeText(
  text,
  maxChars = MAX_CHUNK_CHARS,
  targetChars = TARGET_CHUNK_CHARS,
) {
  // 在上限以内时直接保留为一个 chunk。
  if (text.length <= maxChars) {
    return [text.trim()].filter(Boolean);
  }

  // 以空行分段，减少把相邻语义块拆散的概率。
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let buffer = [];
  let bufferLength = 0;

  // 将当前缓冲区输出为一个 chunk。
  const flush = () => {
    const joined = buffer.join("\n\n").trim();
    if (joined) {
      chunks.push(joined);
    }
    buffer = [];
    bufferLength = 0;
  };

  for (const paragraph of paragraphs) {
    const block = paragraph.trim();
    if (!block) {
      continue;
    }

    // 段落本身已经超过上限时，先把已有缓冲区落盘，再单独处理这个大段。
    if (block.length > maxChars) {
      flush();
      // 代码块或 :::demo 这类结构化内容尽量整体保留，
      // 即使偏大，也避免在中间截断造成内容不可用。
      if (block.includes("```") || block.includes(":::demo")) {
        chunks.push(block);
        continue;
      }

      // 普通长文本才按目标大小做硬切分。
      for (let offset = 0; offset < block.length; offset += targetChars) {
        chunks.push(block.slice(offset, offset + targetChars).trim());
      }
      continue;
    }

    // 如果当前段落再加入缓冲区会超过目标大小，则先输出已有 chunk。
    const nextLength =
      bufferLength + block.length + (buffer.length > 0 ? 2 : 0);
    if (nextLength > targetChars && buffer.length > 0) {
      flush();
    }

    buffer.push(block);
    bufferLength += block.length + (buffer.length > 1 ? 2 : 0);
  }

  flush();
  return chunks;
}

// 提取完整的 :::demo ... ::: 块。
// 该类块通常携带示例源码或演示描述，需要作为独立 chunk 保留。
function extractDemoBlock(lines, startIndex) {
  const collected = [lines[startIndex]];
  let index = startIndex + 1;
  while (index < lines.length) {
    collected.push(lines[index]);
    if (lines[index].trim() === ":::") {
      return {
        block: collected.join("\n"),
        endIndex: index,
      };
    }
    index += 1;
  }

  return {
    block: collected.join("\n"),
    endIndex: lines.length - 1,
  };
}

// 将当前缓存的普通正文输出为一个或多个文本 chunk。
// 这里会附带当前标题路径等元数据。
function finalizeTextChunk(state, chunks, relPath, filePath) {
  const rawText = state.buffer.join("\n").trim();
  if (!rawText) {
    state.buffer = [];
    return;
  }

  const sectionPath = getSectionPath(state.headings);
  const title =
    state.headings[state.headings.length - 1]?.title ||
    path.basename(filePath, ".md");
  const pieces = splitLargeText(rawText);

  for (const piece of pieces) {
    chunks.push({
      sourceFile: filePath,
      relPath,
      title,
      sectionPath,
      chunkType: "section-text",
      content: piece,
    });
  }

  state.buffer = [];
}

// 追加一个 demo 类型 chunk。demo 与普通 section-text 分开存储，
// 方便下游按类型做过滤或区别处理。
function addDemoChunk(
  chunks,
  relPath,
  filePath,
  headings,
  demoBlock,
  demoIndex,
) {
  const sectionPath = getSectionPath(headings);
  const title =
    headings[headings.length - 1]?.title || path.basename(filePath, ".md");
  chunks.push({
    sourceFile: filePath,
    relPath,
    title,
    sectionPath,
    chunkType: "demo",
    demoIndex,
    content: demoBlock,
  });
}

// 拆分单个 Markdown 文件。
// 主流程：
// 1. 预处理文本；
// 2. 按行扫描；
// 3. 遇到标题时结算之前的正文并更新标题栈；
// 4. 遇到 :::demo 时提取为独立 chunk；
// 5. 最后补上剩余正文。
function splitMarkdown(content, filePath, relPath) {
  const lines = stripFrontMatter(normalizeText(content).split("\n"));
  const chunks = [];
  const state = {
    headings: [],
    buffer: [],
  };
  let demoIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = parseHeading(line);

    if (heading) {
      // 标题本身也保留在正文 buffer 中，这样每个 section-text chunk
      // 都会带上所属小节标题，便于后续检索命中后直接展示上下文。
      finalizeTextChunk(state, chunks, relPath, filePath);
      state.headings = updateHeadingStack(
        state.headings,
        heading.level,
        heading.title,
      );
      state.buffer.push(line);
      continue;
    }

    if (line.trim() === ":::demo") {
      // demo 开始前，先把前面的普通正文输出，避免两类内容混在同一 chunk 中。
      finalizeTextChunk(state, chunks, relPath, filePath);
      const demo = extractDemoBlock(lines, index);
      addDemoChunk(
        chunks,
        relPath,
        filePath,
        state.headings,
        demo.block,
        demoIndex,
      );
      demoIndex += 1;
      index = demo.endIndex;
      continue;
    }

    state.buffer.push(line);
  }

  finalizeTextChunk(state, chunks, relPath, filePath);

  // 为每个 chunk 补充稳定的标识和统计字段。
  // id 由相对路径、chunk 类型和顺序组合而成，便于增量处理和去重。
  return chunks
    .map((chunk, chunkIndex) => ({
      id: Buffer.from(`${relPath}::${chunk.chunkType}::${chunkIndex}`).toString(
        "base64url",
      ),
      ...chunk,
      order: chunkIndex,
      charCount: chunk.content.length,
    }))
    .filter((chunk) => chunk.content.trim().length > 0);
}

// 递归收集根目录下的全部 Markdown 文件，并按路径排序，
// 保证每次生成结果顺序稳定。
async function walkMarkdownFiles(rootDir) {
  const result = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && isMarkdownFile(fullPath)) {
        result.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return result.sort();
}

// 主入口：扫描文档、逐个拆分、输出 jsonl 和 index 两个结果文件。
async function main() {
  const files = await walkMarkdownFiles(SOURCE_ROOT);
  if (files.length === 0) {
    throw new Error(`No markdown files found under ${SOURCE_ROOT}`);
  }

  // 输出目录不存在时自动创建。
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const chunks = [];
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    // 统一把相对路径转换成 / 分隔，避免 Windows 和 Unix 平台表现不一致。
    const relPath = path
      .relative(SOURCE_ROOT, filePath)
      .split(path.sep)
      .join("/");
    const fileChunks = splitMarkdown(content, filePath, relPath);
    chunks.push(...fileChunks);
  }

  // 生成索引文件，汇总这次构建的关键统计信息。
  const index = {
    sourceRoot: SOURCE_ROOT,
    totalFiles: files.length,
    totalChunks: chunks.length,
    maxChunkChars: MAX_CHUNK_CHARS,
    targetChunkChars: TARGET_CHUNK_CHARS,
    generatedAt: new Date().toISOString(),
    chunkTypes: {
      "section-text": chunks.filter(
        (chunk) => chunk.chunkType === "section-text",
      ).length,
      demo: chunks.filter((chunk) => chunk.chunkType === "demo").length,
    },
  };

  // JSONL 更适合流式读取和后续批量导入；
  // index.json 则方便人读和脚本快速查看摘要。
  const jsonl = chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
  await fs.writeFile(OUTPUT_JSONL, jsonl + (jsonl ? "\n" : ""), "utf8");
  await fs.writeFile(OUTPUT_INDEX, JSON.stringify(index, null, 2), "utf8");

  console.log("Markdown splitting complete");
  console.log("sourceRoot =", SOURCE_ROOT);
  console.log("files =", files.length);
  console.log("chunks =", chunks.length);
  console.log("jsonl =", OUTPUT_JSONL);
  console.log("index =", OUTPUT_INDEX);
}

// 统一捕获异常并以非 0 状态码退出，方便在 CI 或 yarn script 中感知失败。
main().catch((error) => {
  console.error("Markdown splitting failed:", error);
  process.exit(1);
});
