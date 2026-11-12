import cronstrue from 'cronstrue/i18n';

const MAX_DESCRIPTIONS = 64;
const descriptions = new Map<string, string>();

/** Cache immutable presentation text, never crawler status or runtime schedule selection. */
export function describeCron(expression: string): string {
  const cached = descriptions.get(expression);
  if (cached !== undefined) return cached;
  let description: string;
  try {
    description = cronstrue.toString(expression, {
      locale: 'ko',
      use24HourTimeFormat: true,
    });
  } catch {
    description = expression;
  }
  if (descriptions.size >= MAX_DESCRIPTIONS)
    descriptions.delete(descriptions.keys().next().value);
  descriptions.set(expression, description);
  return description;
}
