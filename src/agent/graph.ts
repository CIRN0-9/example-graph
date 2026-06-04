/**
 * LangGraph.js Agent Graph
 * 支持 tool calling 的 ReAct 风格 agent
 */
import { StateGraph, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { SystemMessage } from "@langchain/core/messages";
import { StateAnnotation } from "./state.js";
import { model } from "./model.js";
import { searchComponentDocs } from "./retriever/retriever.js";

// 将所有工具收集到数组中，方便统一管理
const tools = [searchComponentDocs];

// 将工具绑定到 model 上，使 model 能够调用这些工具
const modelWithTools = model.bindTools(tools);

// 使用 LangGraph 内置的 ToolNode 来自动执行工具调用
const toolNode = new ToolNode(tools);

const SYSTEM_PROMPT = `你是一名前端开发助手。当用户提到组件、页面、表格、弹框等前端需求时，
请先调用 searchComponentDocs 工具搜索公司内部组件库文档，
然后基于搜索结果生成代码或回答问题。
不要凭空编造组件名称和用法。`;
/**
 * 模型调用节点：将消息发送给 LLM，由 LLM 决定是直接回复还是调用工具。
 */
const callModel = async (state: typeof StateAnnotation.State) => {
  const messages = [new SystemMessage(SYSTEM_PROMPT), ...state.messages];
  const response = await modelWithTools.invoke(messages);
  return {
    messages: [response],
  };
};

/**
 * 路由函数：判断 LLM 的响应是否包含 tool_calls。
 * - 如果有 tool_calls → 路由到 "tools" 节点执行工具
 * - 如果没有 tool_calls → 流程结束，LLM 已给出最终回复
 */
export const route = (
  state: typeof StateAnnotation.State,
): "tools" | typeof END => {
  const lastMessage = state.messages[state.messages.length - 1];
  // 检查最后一条消息是否包含工具调用（兼容 AIMessage 和 AIMessageChunk）
  // 注意：在 LangGraph 服务端中，由于流式处理，消息可能是 AIMessageChunk 而非 AIMessage，
  // 因此不能使用 instanceof AIMessage 检查
  const toolCalls =
    "tool_calls" in lastMessage
      ? (lastMessage as { tool_calls: unknown[] }).tool_calls
      : undefined;
  if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
    return "tools";
  }

  return END;
};

// 构建 ReAct 风格的 agent 图
const builder = new StateGraph(StateAnnotation)
  .addNode("callModel", callModel)
  .addNode("tools", toolNode)
  .addEdge("__start__", "callModel")
  // callModel 之后根据是否有 tool_calls 决定走向
  .addConditionalEdges("callModel", route)
  // 工具执行完毕后，回到 callModel 让 LLM 继续处理
  .addEdge("tools", "callModel");

export const graph = builder.compile();

graph.name = "New Agent";
