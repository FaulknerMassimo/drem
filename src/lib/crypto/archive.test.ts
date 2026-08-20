/**
 * The backup container.
 *
 * Part of the crypto gate, and held to the same standard as the rest of it: the
 * failure this suite exists to catch is an archive that looks encrypted and is
 * not, or one that can be opened by something other than its passphrase.
 *
 * The archive is the one place in the codebase protected by a single factor, so
 * the tests below also pin the guards that exist *because* of that — the length
 * floor, and the refusal to derive under cost parameters a file asks for.
 */
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_MAGIC,
  ArchiveError,
  MIN_PASSPHRASE_LENGTH,
  openArchive,
  readArchiveHeader,
  sealArchive,
} from "./archive";

/** OWASP's floor. The real default is 512 MiB, which no test suite wants. */
const FAST = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

const PASSPHRASE = "correct horse battery staple";
const SECRET = "I was flying over the cathedral again, and the clock had no hands.";

async function seal(plaintext = SECRET, passphrase = PASSPHRASE) {
  return sealArchive(passphrase, plaintext, { params: FAST });
}

describe("sealArchive", () => {
  it("round-trips through the passphrase", async () => {
    const file = await seal();
    expect((await openArchive(PASSPHRASE, file)).toString("utf8")).toBe(SECRET);
  });

  it("leaves no plaintext anywhere in the file", async () => {
    const file = await seal();
    const haystack = file.toString("latin1");
    for (const word of ["flying", "cathedral", "clock", "hands"]) {
      expect(haystack).not.toContain(word);
    }
    // The passphrase must not be recoverable from the file either.
    expect(haystack).not.toContain("battery");
  });

  it("is identifiable as an archive without being readable", async () => {
    const file = await seal();
    expect(file.subarray(0, ARCHIVE_MAGIC.length).toString("utf8")).toBe(ARCHIVE_MAGIC);

    const header = readArchiveHeader(file);
    expect(header.version).toBe(1);
    expect(header.kdf).toBe("argon2id");
    expect(header.params).toEqual(FAST);
  });

  it("never produces the same file twice for the same input", async () => {
    const [first, second] = await Promise.all([seal(), seal()]);
    // Fresh salt and fresh nonce: identical journals must not seal identically.
    expect(first.equals(second)).toBe(false);
    expect(readArchiveHeader(first).salt).not.toBe(readArchiveHeader(second).salt);
  });

  it("refuses a passphrase too short to be the only defence", async () => {
    await expect(sealArchive("short", SECRET, { params: FAST })).rejects.toBeInstanceOf(
      ArchiveError,
    );
    await expect(
      sealArchive("x".repeat(MIN_PASSPHRASE_LENGTH), SECRET, { params: FAST }),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it("refuses to seal under cost parameters below the floor", async () => {
    await expect(
      sealArchive(PASSPHRASE, SECRET, {
        params: { memoryCost: 8, timeCost: 1, parallelism: 1 },
      }),
    ).rejects.toThrow();
  });
});

describe("openArchive", () => {
  it("refuses the wrong passphrase", async () => {
    const file = await seal();
    await expect(openArchive("wrong passphrase entirely", file)).rejects.toBeInstanceOf(
      ArchiveError,
    );
  });

  it("cannot tell a wrong passphrase from a tampered file", async () => {
    const file = await seal();
    const tampered = Buffer.from(file);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;

    const wrongKey = await openArchive("wrong passphrase entirely", file).catch(
      (error: Error) => error.message,
    );
    const altered = await openArchive(PASSPHRASE, tampered).catch((error: Error) => error.message);
    expect(altered).toBe(wrongKey);
  });

  it("detects a header edited to weaken the derivation", async () => {
    const file = await seal();
    const header = readArchiveHeader(file);

    // Rewrite the recorded cost parameters, keeping the byte length identical
    // so the length prefix still lines up.
    const original = JSON.stringify(header);
    const forged = original.replace('"timeCost":2', '"timeCost":9');
    expect(forged).not.toBe(original);
    expect(forged.length).toBe(original.length);

    const start = ARCHIVE_MAGIC.length + 4;
    const tampered = Buffer.concat([
      file.subarray(0, start),
      Buffer.from(forged, "utf8"),
      file.subarray(start + original.length),
    ]);

    // The AAD is a digest of the header bytes, so the edit is caught rather
    // than obediently replayed at a different cost.
    await expect(openArchive(PASSPHRASE, tampered)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("refuses one archive's header spliced onto another's payload", async () => {
    const [first, second] = await Promise.all([seal("one"), seal("two")]);
    const firstHeaderLength = first.readUInt32BE(ARCHIVE_MAGIC.length);
    const secondHeaderLength = second.readUInt32BE(ARCHIVE_MAGIC.length);
    const start = ARCHIVE_MAGIC.length + 4;

    const spliced = Buffer.concat([
      first.subarray(0, start + firstHeaderLength),
      second.subarray(start + secondHeaderLength),
    ]);
    await expect(openArchive(PASSPHRASE, spliced)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("rejects a file that is not an archive at all", async () => {
    await expect(openArchive(PASSPHRASE, Buffer.from("hello"))).rejects.toBeInstanceOf(
      ArchiveError,
    );
    await expect(
      openArchive(PASSPHRASE, Buffer.from('{"dreams":[]}', "utf8")),
    ).rejects.toBeInstanceOf(ArchiveError);
  });

  it("rejects a truncated archive rather than reading past the end", async () => {
    const file = await seal();
    await expect(
      openArchive(PASSPHRASE, file.subarray(0, ARCHIVE_MAGIC.length + 6)),
    ).rejects.toBeInstanceOf(ArchiveError);
  });

  it("refuses a header demanding parameters below the floor", async () => {
    // A hand-built file claiming trivial work: opening it must not derive under
    // what it asks for, because that is a downgrade attack on the only factor.
    const header = JSON.stringify({
      version: 1,
      kdf: "argon2id",
      params: { memoryCost: 8, timeCost: 1, parallelism: 1 },
      salt: Buffer.alloc(16).toString("base64"),
      id: "00000000-0000-0000-0000-000000000000",
      createdAt: new Date().toISOString(),
    });
    const length = Buffer.alloc(4);
    length.writeUInt32BE(Buffer.byteLength(header));
    const forged = Buffer.concat([
      Buffer.from(ARCHIVE_MAGIC, "utf8"),
      length,
      Buffer.from(header, "utf8"),
      Buffer.alloc(64),
    ]);

    await expect(openArchive(PASSPHRASE, forged)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("round-trips binary content untouched", async () => {
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 0, 0, 10]);
    const file = await sealArchive(PASSPHRASE, bytes, { params: FAST });
    expect((await openArchive(PASSPHRASE, file)).equals(bytes)).toBe(true);
  });
});
