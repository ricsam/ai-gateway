import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { decodeImageDataUrl, ImageInputError, imageUrlKind, sniffImageFormat } from "./images";
import { fetchRemoteImage, fetchRemoteImages, isPublicIpAddress, type RemoteImageFetchOptions } from "./remote-image";

// 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const WEBP = Uint8Array.from([...new TextEncoder().encode("RIFF"), 0x1a, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);

describe("image format detection", () => {
  test("recognizes Bedrock-supported formats by magic bytes", () => {
    expect(sniffImageFormat(PNG)).toBe("png");
    expect(sniffImageFormat(JPEG)).toBe("jpeg");
    expect(sniffImageFormat(GIF)).toBe("gif");
    expect(sniffImageFormat(WEBP)).toBe("webp");
    expect(sniffImageFormat(new TextEncoder().encode("<svg xmlns"))).toBeNull();
    expect(sniffImageFormat(new Uint8Array())).toBeNull();
  });

  test("classifies image URL schemes", () => {
    expect(imageUrlKind("data:image/png;base64,AAAA")).toBe("data");
    expect(imageUrlKind("HTTPS://example.com/cat.png")).toBe("remote");
    expect(imageUrlKind("http://example.com/cat.png")).toBe("remote");
    expect(imageUrlKind("file:///etc/passwd")).toBeNull();
    expect(imageUrlKind("s3://bucket/key.png")).toBeNull();
  });
});

describe("image data URLs", () => {
  test("decodes base64 images and uses the detected format", () => {
    const image = decodeImageDataUrl(`data:image/png;base64,${PNG_BASE64}`);
    expect(image.format).toBe("png");
    expect(Buffer.from(image.bytes).equals(Buffer.from(PNG))).toBe(true);
  });

  test("tolerates mislabeled media types, image/jpg, parameters, whitespace, and URL-safe base64", () => {
    expect(decodeImageDataUrl(`data:image/jpeg;base64,${PNG_BASE64}`).format).toBe("png");
    const jpeg = Buffer.from(JPEG).toString("base64");
    expect(decodeImageDataUrl(`data:image/jpg;base64,${jpeg}`).format).toBe("jpeg");
    expect(decodeImageDataUrl(`DATA:IMAGE/PNG;name=shot.png;base64,${PNG_BASE64.slice(0, 20)}\n${PNG_BASE64.slice(20)}`).format).toBe("png");
    const urlSafe = Buffer.from(WEBP).toString("base64url");
    expect(decodeImageDataUrl(`data:image/webp;base64,${urlSafe}`).format).toBe("webp");
  });

  test("rejects malformed, non-base64, non-image, and unsupported data", () => {
    const failures = [
      "data:image/png;base64",
      `data:image/png,${PNG_BASE64}`,
      `data:text/plain;base64,${PNG_BASE64}`,
      "data:image/png;base64,***",
      `data:image/heic;base64,${Buffer.from("ftypheic").toString("base64")}`,
      `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
    ];
    for (const url of failures) expect(() => decodeImageDataUrl(url)).toThrow(ImageInputError);
  });
});

describe("remote image address policy", () => {
  const cases: Array<[string, boolean]> = [
    ["93.184.215.14", true], ["8.8.8.8", true], ["2606:4700:4700::1111", true], ["2a00:1450:4001:80b::200e", true],
    ["127.0.0.1", false], ["10.43.0.1", false], ["172.16.5.4", false], ["192.168.1.10", false], ["169.254.169.254", false],
    ["100.64.0.1", false], ["0.0.0.0", false], ["224.0.0.1", false], ["255.255.255.255", false], ["198.18.0.1", false],
    ["192.0.2.1", false], ["::", false], ["::1", false], ["fe80::1", false], ["fe80::1%eth0", false], ["fc00::1", false],
    ["fd12:3456::1", false], ["ff02::1", false], ["2001:db8::1", false], ["2001::1", false], ["2002:c000:0204::1", false],
    ["::ffff:127.0.0.1", false], ["::ffff:10.0.0.1", false], ["::ffff:8.8.8.8", true], ["::ffff:808:808", true],
    ["64:ff9b::a00:1", false], ["64:ff9b::8.8.8.8", true], ["not-an-ip", false], ["", false],
  ];
  for (const [address, expected] of cases) {
    test(`${address || "(empty)"} is ${expected ? "public" : "blocked"}`, () => {
      expect(isPublicIpAddress(address)).toBe(expected);
    });
  }

  test("rejects disallowed URLs before any network access", async () => {
    const blocked = [
      "ftp://example.com/cat.png", "https://user:secret@example.com/cat.png", "https://example.com:8443/cat.png",
      "http://127.0.0.1/cat.png", "http://[::1]/cat.png", "http://169.254.169.254/latest/meta-data",
      "http://0x7f.1/cat.png", "http://2130706433/cat.png", "http://10.1.2.3/cat.png", "not a url",
    ];
    for (const url of blocked) {
      const error = await fetchRemoteImage(url).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ImageInputError);
      expect((error as ImageInputError).code).toBe("invalid_image_url");
    }
  });

  test("rejects hostnames that resolve to private addresses", async () => {
    const error = await fetchRemoteImage("http://localhost/cat.png").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ImageInputError);
    expect((error as Error).message).toContain("public address");
    const mixed: RemoteImageFetchOptions["resolve"] = (_host, _options, callback) => callback(null, [
      { address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 },
    ] as LookupAddress[]);
    const rebinding = await fetchRemoteImage("http://mixed.example/cat.png", { resolve: mixed }).catch((reason: unknown) => reason);
    expect((rebinding as Error).message).toContain("public address");
  });
});

describe("remote image downloads", () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  const big = new Uint8Array(4 * 1024 * 1024);
  big.set(PNG.slice(0, 8));

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/png") return new Response(PNG, { headers: { "content-type": "image/png" } });
        if (pathname === "/mislabeled") return new Response(JPEG, { headers: { "content-type": "text/plain" } });
        if (pathname === "/html") return new Response("<html>nope</html>", { headers: { "content-type": "text/html" } });
        if (pathname === "/missing") return new Response("missing", { status: 404 });
        if (pathname === "/big") return new Response(big, { headers: { "content-type": "image/png" } });
        if (pathname === "/big-stream") {
          return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 8; i++) controller.enqueue(big.slice(0, 1024 * 1024)); controller.close(); } }));
        }
        if (pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "/png" } });
        if (pathname === "/loop") return new Response(null, { status: 302, headers: { location: "/loop" } });
        if (pathname === "/to-private") return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/png" } });
        if (pathname === "/to-file") return new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } });
        if (pathname === "/slow") { await Bun.sleep(1500); return new Response(PNG); }
        return new Response("not found", { status: 404 });
      },
    });
    origin = `http://images.test:${server.port}`;
  });
  afterAll(() => server.stop(true));

  const testOptions = (): RemoteImageFetchOptions => ({
    allowNonDefaultPorts: true,
    isAllowedAddress: (address) => address === "127.0.0.1",
    resolve: (hostname, _options, callback) => hostname === "images.test"
      ? callback(null, [{ address: "127.0.0.1", family: 4 }] as LookupAddress[])
      : callback(Object.assign(new Error("not found"), { code: "ENOTFOUND" }), []),
  });

  test("downloads and sniffs images, ignoring the declared content type", async () => {
    const png = await fetchRemoteImage(`${origin}/png`, testOptions());
    expect(png.format).toBe("png");
    expect(Buffer.from(png.bytes).equals(Buffer.from(PNG))).toBe(true);
    expect((await fetchRemoteImage(`${origin}/mislabeled`, testOptions())).format).toBe("jpeg");
  });

  test("follows bounded redirects and re-validates every hop", async () => {
    expect((await fetchRemoteImage(`${origin}/redirect`, testOptions())).format).toBe("png");
    await expect(fetchRemoteImage(`${origin}/loop`, testOptions())).rejects.toThrow("too many redirects");
    await expect(fetchRemoteImage(`${origin}/to-private`, testOptions())).rejects.toThrow("not allowed");
    await expect(fetchRemoteImage(`${origin}/to-file`, testOptions())).rejects.toThrow("not allowed");
  });

  test("rejects non-images, HTTP errors, oversized bodies, and slow servers", async () => {
    await expect(fetchRemoteImage(`${origin}/html`, testOptions())).rejects.toThrow("did not return");
    await expect(fetchRemoteImage(`${origin}/missing`, testOptions())).rejects.toThrow("HTTP 404");
    await expect(fetchRemoteImage(`${origin}/big`, testOptions())).rejects.toThrow("exceeds");
    await expect(fetchRemoteImage(`${origin}/big-stream`, testOptions())).rejects.toThrow("exceeds");
    await expect(fetchRemoteImage(`${origin}/slow`, { ...testOptions(), timeoutMs: 200 })).rejects.toThrow("timed out");
    await expect(fetchRemoteImage(`http://unknown.test:${server.port}/png`, testOptions())).rejects.toThrow("resolved");
  });

  test("honors caller cancellation", async () => {
    const controller = new AbortController();
    const pending = fetchRemoteImage(`${origin}/slow`, { ...testOptions(), signal: controller.signal });
    controller.abort(new Error("client went away"));
    await expect(pending).rejects.toThrow("client went away");
  });

  test("downloads several URLs and reports the failing parameter", async () => {
    const images = await fetchRemoteImages(new Map([
      [`${origin}/png`, "messages[0].content[0].image_url.url"],
      [`${origin}/mislabeled`, "messages[0].content[1].image_url.url"],
    ]), testOptions());
    expect([...images.values()].map((image) => image.format)).toEqual(["png", "jpeg"]);
    const error = await fetchRemoteImages(new Map([
      [`${origin}/png`, "messages[0].content[0].image_url.url"],
      [`${origin}/html`, "messages[2].content[1].image_url.url"],
    ]), testOptions()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ImageInputError);
    expect((error as ImageInputError).param).toBe("messages[2].content[1].image_url.url");
  });

  test("limits the number of distinct URLs per request", async () => {
    const urls = new Map(Array.from({ length: 21 }, (_, index) => [`${origin}/png?${index}`, `p${index}`] as [string, string]));
    await expect(fetchRemoteImages(urls, testOptions())).rejects.toThrow("at most 20");
  });
});
