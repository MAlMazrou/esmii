import { describe, expect, it } from "vitest";

import { CapturedEmailTransport } from "../src/index.js";

describe("CapturedEmailTransport", () => {
  it("captures messages without opening an external transport", async () => {
    const transport = new CapturedEmailTransport();
    const receipt = await transport.send({
      messageId: "synthetic-message-1",
      subject: "Synthetic notification",
      text: "Synthetic body",
      to: { address: "person-1@example.test" },
    });

    expect(receipt.transportReference).toBe("capture:1");
    expect(transport.messages).toHaveLength(1);
  });
});
