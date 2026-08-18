import type { Viewport } from "next";
import { CaptureForm } from "@/components/capture-form";
import { CsrfField } from "@/components/csrf-field";
import { nightDateFor } from "@/lib/journal/dates";

export const dynamic = "force-dynamic";

/** Overrides the app's theme colour so the browser chrome goes dark too. */
export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
};

export default function CapturePage() {
  return (
    <CaptureForm serverNightDate={nightDateFor()}>
      <CsrfField />
    </CaptureForm>
  );
}
