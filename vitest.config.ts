import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: { include: ["packages/**/*.test.ts", "apps/**/*.test.ts"], environment: "node" },
  resolve: {
    alias: {
      "@huxtrade/shared-types": `${root}packages/shared-types/src/index.ts`,
      "@huxtrade/config": `${root}packages/config/src/index.ts`,
      "@huxtrade/database": `${root}packages/database/src/index.ts`,
      "@huxtrade/indicators": `${root}packages/indicators/src/index.ts`,
      "@huxtrade/strategy-engine": `${root}packages/strategy-engine/src/index.ts`,
      "@huxtrade/exchange-clients": `${root}packages/exchange-clients/src/index.ts`
    }
  }
});

