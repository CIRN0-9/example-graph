/**
 * LangGraph.js Agent Graph
 * 支持 tool calling 的 ReAct 风格 agent
 */
import { StateGraph, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  AIMessage,
  AIMessageChunk,
  SystemMessage,
} from "@langchain/core/messages";
import { StateAnnotation } from "./state.js";
import { model } from "./model.js";
import { searchComponentDocs } from "./retriever/retriever.js";

// 将所有工具收集到数组中，方便统一管理
const tools = [searchComponentDocs];

// 将工具绑定到 model 上，使 model 能够调用这些工具
const modelWithTools = model.bindTools(tools);

// 使用 LangGraph 内置的 ToolNode 来自动执行工具调用
const toolNode = new ToolNode(tools);

const SYSTEM_PROMPT = `你是一名专业的前端开发助手，专精于公司内部 Vue 2 组件库的使用。

## 组件库概览

公司内部有两个独立的 Vue 2 组件库：
- **@lw/common**：通用组件库（CardBase、DrawerContainer、Empty、Popover、TableContainer、Tree 等）
- **@lw/bsm**：业务组件库（ContextMenu、Popper、Topology 等）

两个库均通过 pnpm 安装，支持全局注册和按需引入。

## 工具使用策略

你拥有 searchComponentDocs 工具来搜索组件库文档。请遵循以下规则：

1. **必须调用工具的场景**：用户提到具体组件名、组件用法、组件属性/事件、表格/弹框/树等 UI 需求、设计规范
2. **无需调用工具的场景**：通用前端知识（CSS、JavaScript、Vue 基础）、与公司组件库无关的问题
3. 调用工具时，将用户的原始需求完整填入 query 参数，不要简化或改写
4. 如果首次搜索结果不够，可以换一种描述方式再次搜索

## 回复规范

1. **基于文档回答**：严格依据搜索结果中的组件用法、属性、事件来回答，不要凭空编造组件名称、属性或事件
2. **搜索无结果时**：明确告知用户"未在组件库文档中找到相关内容"，并建议用户确认组件名称或提供更多上下文
3. **代码示例**：
   - 使用 Vue 2 Options API 风格（data、methods、computed）
   - 使用 .sync 修饰符处理双向绑定（如 :show.sync、:active-tool-item.sync）
   - 标注组件来源包名（@lw/common 或 @lw/bsm）
4. **超出能力范围时**：诚实告知，不要猜测或编造不存在的组件`;
/**
 * 模型调用节点：将消息发送给 LLM，由 LLM 决定是直接回复还是调用工具。
 */
const callModel = async (state: typeof StateAnnotation.State) => {
  const messages = [new SystemMessage(SYSTEM_PROMPT), ...state.messages];
  try {
    const response = await modelWithTools.invoke(messages);
    return {
      messages: [response],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "未知错误";
    console.error("LLM 调用失败:", errorMsg);
    return {
      messages: [
        new AIMessage(`抱歉，模型调用出现问题（${errorMsg}），请稍后重试。`),
      ],
    };
  }
};

/**
 * 路由函数：判断 LLM 的响应是否包含 tool_calls。
 * - 如果有 tool_calls → 路由到 "tools" 节点执行工具
 * - 如果没有 tool_calls → 流程结束，LLM 已给出最终回复
 *
 * 注意：LangGraph 服务端中消息可能是 AIMessageChunk 而非 AIMessage，
 * 因此使用 AIMessage.isInstance()（同时匹配两者）而非 instanceof。
 */
export const route = (
  state: typeof StateAnnotation.State,
): "tools" | typeof END => {
  const lastMessage = state.messages[state.messages.length - 1];

  if (
    (AIMessage.isInstance(lastMessage) ||
      AIMessageChunk.isInstance(lastMessage)) &&
    lastMessage.tool_calls &&
    lastMessage.tool_calls.length > 0
  ) {
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
