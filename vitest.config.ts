import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Never collect from build/. Until now tests compiled to build/__tests__,
    // and because `npm run build` runs before `npm test` both in CI and in
    // CLAUDE.md's documented loop, vitest picked up the .ts source *and* the
    // compiled .js copy and ran all 129 tests twice — main reported "258
    // passed" for 129 distinct tests. The tsconfig change stops the emit, so a
    // fresh checkout would be fine, but a stale build/ in an existing
    // working tree would still double-count. This makes it structural.
    exclude: ["**/node_modules/**", "build/**"],
  },
});
