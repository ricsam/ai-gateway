declare const process: { env: Record<string, string | undefined> };

const baseUrl = process.env.BUN_PUBLIC_BASE_URL;
if (!baseUrl) {
  throw new Error("BASE_URL is not set");
}

const env = {
  BASE_URL: baseUrl,
  BUN_PUBLIC_BASE_URL: baseUrl,
};

export default env;
