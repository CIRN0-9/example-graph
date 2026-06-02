import { BaseMessage, BaseMessageLike } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

/**
 * 图的 StateAnnotation 主要定义三部分内容：
 * 1. 在节点之间传递的数据结构（要读写哪些“通道”及其类型）
 * 2. 每个字段的默认值
 * 3. 状态字段的 reducer。reducer 用于决定如何将更新应用到状态上。
 * 更多信息请参见 [Reducers](https://langchain-ai.github.io/langgraphjs/concepts/low_level/#reducers)。
 */

// 这是 agent 的主状态，你可以在这里存储任意需要的信息
export const StateAnnotation = Annotation.Root({
  /**
   * messages 用于跟踪 agent 的主要执行状态。
   *
   * 通常会按如下模式不断累积：
   *
   * 1. HumanMessage - 用户输入
   * 2. 含有 .tool_calls 的 AIMessage - agent 选择工具来收集
   *     信息
   * 3. ToolMessage（一个或多个）- 工具执行后的响应（或错误）
   *
   *     （... 按需重复步骤 2 和 3 ...）
   * 4. 不含 .tool_calls 的 AIMessage - agent 以非结构化
   *     形式回复用户。
   *
   * 5. HumanMessage - 用户给出下一轮对话输入。
   *
   *     （... 按需重复步骤 2-5 ...）
   *
   * 它会合并两组消息（或类消息对象，包含 role 与 content），
   * 并按 ID 更新已有消息。
   *
   * 类消息对象会被 `messagesStateReducer` 自动转换为
   * LangChain 的消息类。如果消息没有给定 id，
   * LangGraph 会自动分配一个。
   *
   * 默认情况下，这能保证状态是“仅追加（append-only）”的，除非
   * 新消息与已有消息拥有相同 ID。
   *
   * 返回：
   *     一个新的消息列表，将 \`right\` 中的消息合并到 \`left\` 中。
   *     如果 \`right\` 中某条消息与 \`left\` 中某条消息 ID 相同，
   *     则用 \`right\` 的消息替换 \`left\` 的消息。`
   */
  messages: Annotation<BaseMessage[], BaseMessageLike[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  /**
   * 你可以按需为状态添加更多属性。
   * 常见示例包括：检索到的文档、提取出的实体、API 连接等。
   *
   * 对于值应直接由节点返回结果覆盖的简单字段，
   * 你不需要为其定义 reducer 或默认值。
   */
  // additionalField: Annotation<string>,
});
