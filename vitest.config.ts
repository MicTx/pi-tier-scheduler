import { defineConfig } from "vitest/config";

/**
 * Coverage configuration lives here and only here (F8.1): the
 * `npm run test:coverage` script runs `vitest run --coverage` with no inline
 * flags, so this file is the single source of coverage truth. Baseline
 * numbers are recorded in the F8.1 package checklist; thresholds are
 * deliberately not configured before the first baseline is locked
 * (08-release.md §7.1 hook 8 keeps thresholds conditional).
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["extensions/**", "tests/**", "node_modules/**"],
    },
  },
});
