import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { prepareImage } from "./image";

const CANARY = "zarquon-flying-over-the-cathedral-of-bees";

describe("image preparation", () => {
  it("strips EXIF so a description cannot hide in the stored bytes", async () => {
    const withExif = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 20, g: 20, b: 40 } },
    })
      .jpeg()
      .withExif({ IFD0: { ImageDescription: CANARY } })
      .toBuffer();

    expect(withExif.toString("utf8")).toContain(CANARY);

    const prepared = await prepareImage(withExif);
    expect(prepared.mimeType).toBe("image/jpeg");
    expect(prepared.bytes.toString("utf8")).not.toContain(CANARY);
  });

  it("refuses an empty buffer that is not an image", async () => {
    await expect(prepareImage(Buffer.from("not an image"))).rejects.toThrow(/not supported|could not be read/i);
  });
});
