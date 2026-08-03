import { describe, expect, test } from "bun:test";
import {
  assertAdministratorUpdateIsSafe,
  normalizeEmail,
  shouldBootstrapAdmin,
} from "./auth-policy";

const policy = {
  subjects: new Set(["subject-admin"]),
  emails: new Set(["admin@example.com"]),
};

describe("bootstrap administrator policy", () => {
  test("prefers immutable OIDC subject matches", () => {
    expect(shouldBootstrapAdmin({
      subject: "subject-admin",
      email: "someone@example.com",
      emailVerified: false,
    }, policy)).toBe(true);
  });

  test("accepts only verified normalized email matches", () => {
    expect(normalizeEmail(" Admin@Example.COM ")).toBe("admin@example.com");
    expect(shouldBootstrapAdmin({
      subject: null,
      email: " Admin@Example.COM ",
      emailVerified: true,
    }, policy)).toBe(true);
    expect(shouldBootstrapAdmin({
      subject: null,
      email: "admin@example.com",
      emailVerified: false,
    }, policy)).toBe(false);
  });
});

describe("final administrator safeguard", () => {
  test("rejects disabling or demoting the final enabled administrator", () => {
    expect(() => assertAdministratorUpdateIsSafe(
      { role: "admin", enabled: true },
      { role: "user" },
      0,
    )).toThrow("final enabled administrator");
    expect(() => assertAdministratorUpdateIsSafe(
      { role: "admin", enabled: true },
      { enabled: false },
      0,
    )).toThrow("final enabled administrator");
  });

  test("allows the update when another enabled administrator exists", () => {
    expect(() => assertAdministratorUpdateIsSafe(
      { role: "admin", enabled: true },
      { enabled: false },
      1,
    )).not.toThrow();
  });
});
