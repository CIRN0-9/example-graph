/**
 * LangGraph.js 入门模板
 * 让这份代码成为你自己的实现！
 */
import { StateGraph } from "@langchain/langgraph";
import { RunnableConfig } from "@langchain/core/runnables";
import { StateAnnotation } from "./state.js";
import { model } from "./model.js";

/**
 * 定义一个节点：节点负责执行图中的实际工作，通常应承载主要业务逻辑。
 * 该函数必须返回 StateAnnotation 中定义字段的一个子集。
 * @param state 图当前的状态。
 * @param config 传入状态图的额外参数。
 * @returns 图状态字段的一个子集，用于更新状态，供后续边与节点执行使用。
 */
const callModel = async (
  state: typeof StateAnnotation.State,
  _config: RunnableConfig,
): Promise<typeof StateAnnotation.Update> => {
  const response = await model.invoke(state.messages);

  return {
    messages: [response],
  };
};

/**
 * 路由函数：决定继续执行还是结束当前构建流程。
 * 该函数用于判断当前信息是否已满足要求，或是否需要继续处理。
 *
 * @param state - 当前构建流程的状态
 * @returns 返回 "callModel" 表示继续执行，或返回 END 表示结束流程
 */
export const route = (
  state: typeof StateAnnotation.State,
): "__end__" | "callModel" => {
  if (state.messages.length > 0) {
    return "__end__";
  }
  // 回到模型调用节点继续执行
  return "callModel";
};

// 最后，创建图本身。
const builder = new StateGraph(StateAnnotation)
  // 添加用于执行逻辑的节点。
  // 采用这种链式方式组织节点时，
  // 会同步更新 StateGraph 实例的类型，
  // 从而在后续添加边时
  // 获得静态类型检查。
  .addNode("callModel", callModel)
  // 普通边表示“节点 A 执行完成后总是流转到节点 B”。
  // "__start__" 与 "__end__" 是始终存在的“虚拟”节点，
  // 分别表示流程的起点与终点。
  .addEdge("__start__", "callModel")
  // 条件边可按条件路由到不同节点（或直接结束）
  .addConditionalEdges("callModel", route);

export const graph = builder.compile();

graph.name = "New Agent";
