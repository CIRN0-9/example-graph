/**
 * 通用 fetch 封装：超时控制 + 错误兜底 + JSON 响应解析
 *
 * 用法：
 *   const data = await safeFetch<MyData>("http://...", { method: "POST", body: "..." });
 *   // 成功 → { ok: true, data: MyData }
 *   // 失败 → { ok: false, error: "友好错误信息" }
 */

/** 统一的返回结构 */
export type SafeFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** 配置项 */
export interface SafeFetchOptions extends Omit<RequestInit, "signal"> {
  /** 超时时间（毫秒），默认 30000 */
  timeoutMs?: number;
  /** 自定义错误前缀，用于区分不同服务，如 "Ollama" / "Qdrant" */
  label?: string;
}

/**
 * 带超时的 fetch，返回原始 Response。
 * 内部使用 AbortController 实现超时中断。
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 安全的 JSON fetch 请求。
 *
 * - 自动设置 Content-Type: application/json（可覆盖）
 * - 超时控制（AbortController）
 * - HTTP 错误、网络错误、JSON 解析错误统一捕获
 * - 返回 SafeFetchResult，调用方无需 try-catch
 */
export async function safeFetch<T = unknown>(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult<T>> {
  const { timeoutMs = 30000, label = "请求", ...fetchOptions } = options;

  const headers = new Headers(fetchOptions.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    const res = await fetchWithTimeout(
      url,
      { ...fetchOptions, headers },
      timeoutMs,
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `${label}失败: HTTP ${res.status} ${detail}` };
    }

    const data: T = await res.json();
    return { ok: true, data };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        ok: false,
        error: `${label}超时（${timeoutMs}ms），请检查服务是否可用`,
      };
    }
    const message = error instanceof Error ? error.message : "未知错误";
    return { ok: false, error: `${label}异常: ${message}` };
  }
}
