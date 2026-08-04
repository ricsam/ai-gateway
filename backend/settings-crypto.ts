import env from "./env";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENVELOPE_VERSION = "v1";

export type SecretWrite =
  | { operation: "preserve" }
  | { operation: "clear" }
  | { operation: "replace"; value: string };

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64ToBytes(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  return bytes.buffer as ArrayBuffer;
}

async function getKey(): Promise<CryptoKey> {
  const bytes = Uint8Array.from(Buffer.from(env.SETTINGS_ENCRYPTION_KEY.slice(3), "base64"));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSetting(value: string, context: string): Promise<string> {
  if (!value) throw new Error("Secret cannot be empty");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(`${ENVELOPE_VERSION}:${context}`) },
    await getKey(),
    encoder.encode(value),
  );
  return `${ENVELOPE_VERSION}.${bytesToBase64(nonce)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSetting(envelope: string, context: string): Promise<string> {
  const [version, nonce, ciphertext, extra] = envelope.split(".");
  if (version !== ENVELOPE_VERSION || !nonce || !ciphertext || extra) throw new Error("Unsupported encrypted setting envelope");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(nonce), additionalData: encoder.encode(`${version}:${context}`) },
      await getKey(),
      base64ToBytes(ciphertext),
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error("Could not decrypt setting; verify SETTINGS_ENCRYPTION_KEY and database backup belong together");
  }
}

export async function applySecretWrite(current: string | null, write: SecretWrite | undefined, context: string): Promise<string | null> {
  if (!write || write.operation === "preserve") return current;
  if (write.operation === "clear") return null;
  return encryptSetting(write.value, context);
}

export function secretStatus(envelope: string | null): { configured: boolean; value?: never } {
  return { configured: Boolean(envelope) };
}

export function maskAccessKey(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
