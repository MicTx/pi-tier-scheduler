import { describe, expect, it } from "vitest";

import {
  COMMAND_NAME,
  PACKAGE_NAME,
  PROVIDER_NAMESPACE,
  VIRTUAL_MODEL_ID,
} from "../src/shared/constants";

describe("pi-tier-scheduler package constants", () => {
  it("exposes the fixed package and command identity", () => {
    expect(PACKAGE_NAME).toBe("pi-tier-scheduler");
    expect(COMMAND_NAME).toBe("ts");
  });

  it("reserves the virtual-model namespace used by Phase 4", () => {
    expect(PROVIDER_NAMESPACE).toBe("ts");
    expect(VIRTUAL_MODEL_ID).toBe("auto");
    expect(`${PROVIDER_NAMESPACE}/${VIRTUAL_MODEL_ID}`).toBe("ts/auto");
  });
});
