export class QuoteDetectionUtil {
  private static readonly quoteReferencePattern = /(?:>>|>)\s*#?(\d+)\b/g;

  static extractReferencedSequences(content: string): number[] {
    const sequences = new Set<number>();

    for (const match of content.matchAll(this.quoteReferencePattern)) {
      const sequence = Number.parseInt(match[1], 10);
      if (Number.isSafeInteger(sequence) && sequence > 0) {
        sequences.add(sequence);
      }
    }

    return [...sequences];
  }
}
