import { describe, expect, test } from "bun:test";
import { normalizeEmail, normalizeUsername, validateLocalAccount } from "./setup";

describe("local account validation", () => {
  test("normalizes unique identifiers", () => {
    expect(normalizeUsername(" Admin.User ")).toBe("admin.user");
    expect(normalizeEmail(" ADMIN@Example.COM ")).toBe("admin@example.com");
  });
  test("enforces username and password policy", () => {
    expect(() => validateLocalAccount({ username: "a", email: "x@example.com", name: "X", password: "Password1234" })).toThrow("Username");
    expect(() => validateLocalAccount({ username: "valid", email: "x@example.com", name: "X", password: "no-number-here" })).toThrow("letter and a number");
    expect(validateLocalAccount({ username: "Valid_User", email: "X@Example.com", name: " X ", password: "Password1234" })).toMatchObject({ username: "valid_user", email: "x@example.com", name: "X" });
  });
});
