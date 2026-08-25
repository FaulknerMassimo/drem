import { describe, expect, it } from "vitest";
import {
  PUBLIC_DEV_MASTER_KEY,
  databaseMismatch,
  databaseName,
  masterKeyMismatch,
  parseDremEnvironment,
} from "./db-environment";

const PROD = "postgresql://drem:pw@localhost:5433/drem";
const DEV = "postgresql://drem:drem@localhost:5432/drem_dev";
const TEST = "postgresql://drem:drem@localhost:5432/drem_test";

describe("databaseName", () => {
  it("reads the database out of a connection string", () => {
    expect(databaseName(DEV)).toBe("drem_dev");
  });

  it("returns null for a string that names no database", () => {
    expect(databaseName("postgresql://drem:drem@localhost:5432")).toBeNull();
    expect(databaseName("not a url")).toBeNull();
  });
});

describe("databaseMismatch", () => {
  it("accepts each environment pointed at its own database", () => {
    expect(databaseMismatch(PROD, "production")).toBeNull();
    expect(databaseMismatch(DEV, "development")).toBeNull();
    expect(databaseMismatch(TEST, "test")).toBeNull();
  });

  it("refuses a development process pointed at the real journal", () => {
    expect(databaseMismatch(PROD, "development")).toMatch(/ending in "_dev"/);
  });

  it("refuses an integration suite pointed at the real journal", () => {
    expect(databaseMismatch(PROD, "test")).toMatch(/ending in "_test"/);
  });

  it("refuses an integration suite pointed at the development journal", () => {
    // The suites truncate. A seeded dev journal disappearing mid-run is a
    // confusing morning, even though nothing irreplaceable is lost.
    expect(databaseMismatch(DEV, "test")).toMatch(/ending in "_test"/);
  });

  it("refuses production pointed at a scratch database", () => {
    expect(databaseMismatch(DEV, "production")).toMatch(/must not name a scratch database/);
    expect(databaseMismatch(TEST, "production")).toMatch(/must not name a scratch database/);
  });

  it("does not mistake a database that merely contains the suffix", () => {
    expect(databaseMismatch("postgresql://h/drem_development", "development")).not.toBeNull();
    expect(databaseMismatch("postgresql://h/drem_dev_archive", "production")).toBeNull();
  });

  it("says which database it was handed", () => {
    expect(databaseMismatch(PROD, "development")).toContain("drem");
  });
});

describe("masterKeyMismatch", () => {
  it("refuses the published development key in production", () => {
    expect(masterKeyMismatch(PUBLIC_DEV_MASTER_KEY, "production")).toMatch(/public/);
  });

  it("allows it everywhere else", () => {
    expect(masterKeyMismatch(PUBLIC_DEV_MASTER_KEY, "development")).toBeNull();
    expect(masterKeyMismatch(PUBLIC_DEV_MASTER_KEY, "test")).toBeNull();
  });

  it("allows a real key in production", () => {
    expect(masterKeyMismatch("d2hhdGV2ZXIgMzIgYnl0ZXMgb2Yga2V5IG1hdGVyaWFs", "production")).toBeNull();
  });

  it("is a key nobody would mistake for a secret", () => {
    expect(Buffer.from(PUBLIC_DEV_MASTER_KEY, "base64").toString()).toBe(
      "drem dev key - not a secret ----",
    );
  });
});

describe("parseDremEnvironment", () => {
  it("narrows the three names and rejects everything else", () => {
    expect(parseDremEnvironment("development")).toBe("development");
    expect(parseDremEnvironment("prod")).toBeNull();
    expect(parseDremEnvironment(undefined)).toBeNull();
  });
});
