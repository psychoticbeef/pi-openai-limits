import { describe, expect, it } from "vitest";

import piOpenAiLimits from "../src/index.js";

describe("pi-openai-limits extension", () => {
  it("exports an extension factory", () => {
    expect(piOpenAiLimits).toBeTypeOf("function");
  });
});
