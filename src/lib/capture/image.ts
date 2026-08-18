/**
 * Strips GPS and other EXIF from an upload, and bounds its size.
 *
 * Re-encoding is the point: writing a fresh JPEG/PNG/WebP drops the metadata
 * block, so a photographed journal page cannot smuggle a home coordinate into
 * the encrypted store. Orientation is applied first so the page is upright
 * in the review UI.
 */
import sharp from "sharp";

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 4096;
export const MODEL_IMAGE_EDGE = 1600;

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface PreparedImage {
  bytes: Buffer;
  mimeType: ImageMime;
  width: number;
  height: number;
}

const INPUT_TYPES = new Set(["jpeg", "png", "webp", "gif", "tiff"]);

export function isImageMime(value: string): boolean {
  return value.startsWith("image/");
}

/**
 * Returns a metadata-free image, or throws a short public error.
 *
 * The thrown message is safe to show: it names a format, never the file.
 */
export async function prepareImage(input: Buffer): Promise<PreparedImage> {
  if (input.length > MAX_IMAGE_BYTES) {
    throw new Error("That photo is too large to store (12 MB limit).");
  }

  let pipeline = sharp(input, { failOn: "none", sequentialRead: true }).rotate();

  let meta;
  try {
    meta = await pipeline.metadata();
  } catch {
    throw new Error("That file could not be read as an image.");
  }
  const format = meta.format ?? "";
  if (!INPUT_TYPES.has(format)) {
    throw new Error("That image format is not supported. Use JPEG, PNG or WebP.");
  }

  pipeline = pipeline.resize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, {
    fit: "inside",
    withoutEnlargement: true,
  });

  let bytes: Buffer;
  let mimeType: ImageMime;
  if (format === "png" || format === "gif") {
    bytes = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    mimeType = "image/png";
  } else if (format === "webp") {
    bytes = await pipeline.webp({ quality: 85 }).toBuffer();
    mimeType = "image/webp";
  } else {
    bytes = await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    mimeType = "image/jpeg";
  }

  const out = await sharp(bytes).metadata();
  return {
    bytes,
    mimeType,
    width: out.width ?? 0,
    height: out.height ?? 0,
  };
}

/** A smaller copy for the vision model; the stored blob stays at review size. */
export async function imageForModel(bytes: Buffer, mimeType: ImageMime): Promise<Buffer> {
  const pipeline = sharp(bytes).resize(MODEL_IMAGE_EDGE, MODEL_IMAGE_EDGE, {
    fit: "inside",
    withoutEnlargement: true,
  });
  if (mimeType === "image/png") return pipeline.png().toBuffer();
  if (mimeType === "image/webp") return pipeline.webp({ quality: 80 }).toBuffer();
  return pipeline.jpeg({ quality: 80 }).toBuffer();
}
