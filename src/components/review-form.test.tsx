import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Destination } from "@/lib/ai/types";
import type { ReviewStack } from "@/lib/capture/types";

vi.mock("@/lib/capture/actions", () => ({
  confirmReviewAction: async () => ({}),
  discardStackAction: async () => ({}),
  proposeReviewSplitAction: async () => ({}),
}));

import { ReviewForm } from "./review-form";

const destination: Destination = {
  role: "split",
  configured: true,
  leavesMachine: false,
  providerId: "ollama",
  providerName: "Ollama",
  providerKind: "ollama",
  model: "qwen3.5:9b",
  host: "127.0.0.1",
  label: "Ollama · qwen3.5:9b · 127.0.0.1 — stays on this machine",
};

const stack: ReviewStack = {
  id: "stack-1",
  leadId: "page-1",
  kind: "audio",
  status: "succeeded",
  sent: true,
  pages: [{ id: "page-1", kind: "audio" }],
  dreams: [
    {
      date: { value: "2026-08-25", confidence: null },
      title: { value: null, confidence: null },
      body: { value: "First dream. I woke up. Second dream.", confidence: null },
      tags: { value: [], confidence: null },
      lucidity: { value: null, confidence: null },
      raw: "",
      isFragment: false,
      pages: [1],
    },
  ],
};

describe("capture review form", () => {
  it("submits a split through its own form with the edited transcript", () => {
    const html = renderToStaticMarkup(
      <ReviewForm
        stack={stack}
        defaultDate="2026-08-25"
        csrfToken="csrf"
        splitDestination={destination}
      />,
    );

    expect(html.match(/<form/g)).toHaveLength(3);
    expect(html).toContain(
      'name="body-0" value="First dream. I woke up. Second dream."',
    );
    expect(html).toContain("Split into separate dreams");
  });
});
