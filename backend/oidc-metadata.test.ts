import { describe, expect, test } from "bun:test";
import {
  oidcDiscoveryUrl,
  parseOidcDiscoveryMetadata,
  requiresAuthorizationResponseIssuer,
} from "./oidc-metadata";

const issuer = "https://id.example.com/tenant";
const requiredMetadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/keys`,
};

describe("OIDC discovery metadata", () => {
  test("derives the standard discovery URL unless an explicit URL is configured", () => {
    expect(oidcDiscoveryUrl(`${issuer}/`, undefined)).toBe(`${issuer}/.well-known/openid-configuration`);
    expect(oidcDiscoveryUrl(issuer, " https://metadata.example.com/oidc ")).toBe("https://metadata.example.com/oidc");
  });

  test("accepts metadata only when required endpoints and the exact issuer match", () => {
    expect(parseOidcDiscoveryMetadata(requiredMetadata, issuer)).toEqual(requiredMetadata);
    expect(parseOidcDiscoveryMetadata({ ...requiredMetadata, issuer: `${issuer}/other` }, issuer)).toBeNull();
    expect(parseOidcDiscoveryMetadata({ ...requiredMetadata, jwks_uri: undefined }, issuer)).toBeNull();
  });

  test("requires the RFC 9207 response issuer only when the provider advertises support", () => {
    const unadvertised = parseOidcDiscoveryMetadata(requiredMetadata, issuer)!;
    const unsupported = parseOidcDiscoveryMetadata({ ...requiredMetadata, authorization_response_iss_parameter_supported: false }, issuer)!;
    const supported = parseOidcDiscoveryMetadata({ ...requiredMetadata, authorization_response_iss_parameter_supported: true }, issuer)!;

    expect(requiresAuthorizationResponseIssuer(unadvertised)).toBe(false);
    expect(requiresAuthorizationResponseIssuer(unsupported)).toBe(false);
    expect(requiresAuthorizationResponseIssuer(supported)).toBe(true);
  });
});
