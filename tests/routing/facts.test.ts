import { describe, expect, it } from "vitest";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { classifyComplexity, classifyWorkPhase, deriveRouteFacts } from "../../src/routing";

const user = (text: string, content?: string | (TextContent | ImageContent)[]): Message => ({
  role: "user",
  content: content ?? text,
  timestamp: 0,
});
const tool = (toolName: string, isError = false): Message => ({
  role: "toolResult",
  toolCallId: "1",
  toolName,
  content: [],
  isError,
  timestamp: 0,
});

describe("bounded route facts", () => {
  it("applies verification, planning, implementation, conversation precedence", () => {
    expect(classifyWorkPhase("design a plan for the architecture")).toBe("planning");
    expect(classifyWorkPhase("implement the plan and add tests")).toBe("verification");
    expect(classifyWorkPhase("create the parser")).toBe("implementation");
    expect(classifyWorkPhase("what is a parser?")).toBe("conversation");
    expect(classifyWorkPhase("hello there")).toBe("unknown");
  });

  it("uses only successful tool metadata as evidence", () => {
    expect(deriveRouteFacts([user("continue"), tool("edit")]).successfulEditEvidence).toBe(true);
    expect(deriveRouteFacts([user("continue"), tool("edit", true)]).successfulEditEvidence).toBe(false);
    expect(classifyWorkPhase("continue", [{ name: "test", success: true }])).toBe("verification");
  });

  it("detects image input and caps user text", () => {
    const facts = deriveRouteFacts([
      user("x".repeat(20_000), [{ type: "text", text: "x".repeat(20_000) }, { type: "image", data: "secret", mimeType: "image/png" }]),
    ]);
    expect(facts.userMessageLength).toBe(16_000);
    expect(facts.hasImageInput).toBe(true);
  });

  it("keeps complexity bands deterministic", () => {
    const low = deriveRouteFacts([user("how are you?")]);
    expect(low.complexity).toBe("low");
    expect(deriveRouteFacts([user("fix src/a.ts and src/b.ts and src/c.ts")]).complexity).toBe("high");
    expect(classifyComplexity("ordinary change", {
      hasImageInput: false, pathLikeTokenCount: 0, codeFenceChars: 0, listItemCount: 0,
      implementationVerbCount: 1, hasVerificationVerb: false, hasExplicitImplementationVerb: true,
      hasHighScopeMarker: false, hasMultiStepPhrase: false,
    })).toBe("standard");
  });
});
