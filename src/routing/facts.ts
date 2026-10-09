import type { Message } from "@earendil-works/pi-ai";
import {
  type ComplexityBand,
  type MessageShapeFacts,
  type RouteFacts,
  type ToolEvidence,
  type WorkPhase,
} from "./types";

const MAX_USER_TEXT = 16_000;
const HIGH_SCOPE_MARKERS = [
  "architecture", "distributed", "concurrency", "protocol", "migration", "security",
  "performance", "production", "multi-file", "schema", "database", "integration", "deployment",
  "架构", "分布式", "并发", "协议", "迁移", "安全", "性能", "生产", "多文件", "数据库", "集成", "部署",
];
const PLANNING_MARKERS = [
  "plan", "design", "architecture", "decompose", "decomposition", "analy[sz]e", "analysis",
  "compare", "comparison", "requirements", "clarify", "规划", "设计", "架构", "拆解", "分析", "比较", "需求",
];
const IMPLEMENTATION_MARKERS = [
  "create", "implement", "add", "change", "fix", "refactor", "migrat", "wire", "delete", "update",
  "write", "build", "实现", "新增", "添加", "修改", "修复", "重构", "迁移", "接入", "删除", "编写",
];
const VERIFICATION_MARKERS = [
  "test", "tests", "testing", "build", "compile", "lint", "check", "verify", "validate", "reproduce",
  "debug", "regression", "测试", "构建", "编译", "检查", "验证", "复现", "调试", "回归",
];
const CONVERSATION_MARKERS = [
  "what is", "what are", "why ", "how does", "explain", "define", "translate", "meaning",
  "是什么", "为什么", "怎么", "解释", "定义", "翻译",
];

function hasMarker(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => {
    if (/^[\u0080-\uFFFF]/.test(marker)) return text.includes(marker);
    return new RegExp(`(?:^|[^a-z0-9])${marker}(?:$|[^a-z0-9])`, "i").test(text);
  });
}

function countMarkers(text: string, markers: readonly string[]): number {
  return markers.reduce((count, marker) => count + (hasMarker(text, [marker]) ? 1 : 0), 0);
}

function textFromContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join(" ");
}

function hasImage(content: Message["content"]): boolean {
  return typeof content !== "string" && content.some((part) => part.type === "image");
}

function latestUser(messages: readonly Message[]): { text: string; index: number; image: boolean } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return { text: textFromContent(message.content).slice(0, MAX_USER_TEXT), index, image: hasImage(message.content) };
    }
  }
  return { text: "", index: -1, image: false };
}

function toolEvidenceSince(messages: readonly Message[], userIndex: number): ToolEvidence[] {
  const evidence: ToolEvidence[] = [];
  for (let index = Math.max(0, userIndex + 1); index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "toolResult") evidence.push({ name: message.toolName, success: !message.isError });
  }
  return evidence;
}

function nonWhitespaceLength(value: string): number {
  return value.replace(/\s/g, "").length;
}

function codeFenceChars(text: string): number {
  let total = 0;
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) total += nonWhitespaceLength(match[1] ?? "");
  return total;
}

function pathLikeTokenCount(text: string): number {
  const matches = text.match(/(?:^|\s)(?:\.?\.?\/)?[\w.-]+\/[\w./-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|rs|go|py|java|sql|css|html)\b/g);
  return Math.min(matches?.length ?? 0, 8);
}

function listItemCount(text: string): number {
  return Math.min((text.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) ?? []).length, 8);
}

function implementationVerbCount(text: string): number {
  return Math.min(countMarkers(text, IMPLEMENTATION_MARKERS), 8);
}

function shapeFor(text: string, image: boolean, evidence: readonly ToolEvidence[]): MessageShapeFacts {
  const lowered = text.toLocaleLowerCase();
  const fenceChars = codeFenceChars(text);
  const paths = pathLikeTokenCount(text);
  const lists = listItemCount(text);
  const implementationCount = implementationVerbCount(text);
  const verification = hasMarker(lowered, VERIFICATION_MARKERS);
  return {
    hasImageInput: image,
    pathLikeTokenCount: paths,
    codeFenceChars: fenceChars,
    listItemCount: lists,
    implementationVerbCount: implementationCount,
    hasVerificationVerb: verification,
    hasExplicitImplementationVerb: implementationCount > 0,
    hasHighScopeMarker: hasMarker(lowered, HIGH_SCOPE_MARKERS),
    hasMultiStepPhrase: /\b(?:multi[- ]step|step by step|in stages)\b|分步骤|多步骤/i.test(text),
  };
}

export function classifyWorkPhase(text: string, evidence: readonly ToolEvidence[] = []): WorkPhase {
  const normalized = text.toLocaleLowerCase();
  const successfulVerificationTool = evidence.some((item) =>
    item.success && /^(?:test|build|compile|lint|check|verify|validate|debug|bash|shell)$/i.test(item.name),
  );
  if (hasMarker(normalized, VERIFICATION_MARKERS) || successfulVerificationTool) return "verification";
  const hasImplementation = hasMarker(normalized, IMPLEMENTATION_MARKERS);
  if (hasMarker(normalized, PLANNING_MARKERS) && !hasImplementation) return "planning";
  if (hasImplementation || evidence.some((item) => item.success && /^(?:edit|write|apply_patch|patch)$/i.test(item.name))) {
    return "implementation";
  }
  if (hasMarker(normalized, CONVERSATION_MARKERS) || /[?？]/.test(text)) return "conversation";
  return "unknown";
}

export function classifyComplexity(text: string, shape: MessageShapeFacts): ComplexityBand {
  const scopeSignalCount = [
    shape.listItemCount >= 3,
    shape.implementationVerbCount >= 2,
    shape.codeFenceChars > 0,
    shape.pathLikeTokenCount >= 2,
    shape.hasMultiStepPhrase,
  ].filter(Boolean).length;
  const high =
    shape.hasHighScopeMarker && scopeSignalCount > 0 ||
    text.length > 1_600 ||
    shape.pathLikeTokenCount >= 3 ||
    (shape.codeFenceChars >= 80 && shape.hasExplicitImplementationVerb);
  if (high) return "high";
  const low =
    text.length <= 240 &&
    !shape.hasHighScopeMarker &&
    shape.codeFenceChars === 0 &&
    shape.pathLikeTokenCount === 0 &&
    shape.listItemCount < 1 &&
    !shape.hasMultiStepPhrase &&
    !shape.hasExplicitImplementationVerb &&
    !shape.hasVerificationVerb;
  return low ? "low" : "standard";
}

export function deriveRouteFacts(messages: readonly Message[]): RouteFacts {
  const latest = latestUser(messages);
  const evidence = toolEvidenceSince(messages, latest.index);
  const shape = shapeFor(latest.text, latest.image, evidence);
  return {
    phase: classifyWorkPhase(latest.text, evidence),
    complexity: classifyComplexity(latest.text, shape),
    hasImageInput: latest.image,
    successfulEditEvidence: evidence.some((item) => item.success && /^(?:edit|write|apply_patch|patch)$/i.test(item.name)),
    userMessageLength: latest.text.length,
    shape,
  };
}

export const ROUTING_TEXT_LIMIT = MAX_USER_TEXT;
