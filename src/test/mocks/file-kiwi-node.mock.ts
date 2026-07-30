export interface GenerateKeysResult {
  secretKey: string;
  ske: string;
  encryptFilename: (value: string) => Promise<string>;
}

export async function generateKeys(): Promise<GenerateKeysResult> {
  return {
    secretKey: 'test-secret-key',
    ske: 'test-ske',
    encryptFilename: async (value: string) => `enc:${value}`,
  };
}

export async function encryptChunk(
  chunk: Buffer | Uint8Array,
  _secretKey: string,
): Promise<Uint8Array> {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }

  return new Uint8Array(chunk);
}
