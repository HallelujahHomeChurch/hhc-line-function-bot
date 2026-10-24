export interface RedisScanClient {
  scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<string[]>;
}

export async function* scanKeyBatches(
  client: RedisScanClient,
  prefix: string
): AsyncGenerator<string[]> {
  const match = `${prefix.replace(/[\\*?[\]]/g, "\\$&")}*`;
  for await (const keys of client.scanIterator({ MATCH: match, COUNT: 100 })) {
    // COUNT is a hint; bound follow-up commands even if Redis returns a larger page.
    for (let offset = 0; offset < keys.length; offset += 100) {
      yield keys.slice(offset, offset + 100);
    }
  }
}
