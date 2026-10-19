/**
 * Single source of truth for the AI summary generation prompt.
 *
 * `OllamaClientService` builds its request with `buildAiSummaryPrompt`, and
 * the crawling-transparency endpoint reports `getAiSummaryPromptTemplate`
 * so the UI always shows the exact template the model receives.
 */
export const AI_SUMMARY_MODEL_TEMPERATURE = 0.2;
export const AI_SUMMARY_MODEL_NUM_PREDICT = 220;

/** Placeholder labels used when the template is displayed without real input. */
export const AI_SUMMARY_TITLE_PLACEHOLDER = '{{법률안명}}';
export const AI_SUMMARY_REASON_PLACEHOLDER = '{{제안이유 및 주요내용}}';

/**
 * Builds the full summarization prompt sent to the model.
 * @param title The legislative proposal title.
 * @param proposalReason The proposal reason and main content.
 * @returns The formatted prompt string.
 */
export function buildAiSummaryPrompt(
  title: string,
  proposalReason: string,
): string {
  const prompt = [
    '당신은 국회 입법예고 요약 도우미입니다. 아래 규칙을 위반하지 마세요.',
    '',
    '[출력 규칙]',
    '1) 한국어 한 문장만 출력합니다.',
    '2) 줄바꿈 없이 평문으로만 출력합니다.',
    '3) "요약:", "설명:", "참고:" 같은 머리말을 금지합니다.',
    '4) 목록 기호, 마크다운, 따옴표, 코드블록을 금지합니다.',
    '5) 법률안명은 반복하지 말고 핵심 정책 변화와 영향만 씁니다.',
    '',
    '[출력 형식]',
    '반드시 요약 문장 하나만 출력',
    '',
    `법률안명: ${title}`,
    `제안이유 및 주요내용: ${proposalReason}`,
  ].join('\n');

  return prompt;
}

/**
 * Returns the prompt template with placeholders instead of real input.
 * @returns The displayable template shown on the transparency page.
 */
export function getAiSummaryPromptTemplate(): string {
  return buildAiSummaryPrompt(
    AI_SUMMARY_TITLE_PLACEHOLDER,
    AI_SUMMARY_REASON_PLACEHOLDER,
  );
}

export interface AiSummaryTransparencyInfo {
  /** User-facing policy describing how summaries stay value-neutral. */
  policy: string;
  /** Full prompt template actually sent to the model (with placeholders). */
  prompt: string;
  generationOptions: {
    temperature: number;
    numPredict: number;
  };
  /** Source fields fed into the prompt placeholders. */
  inputFields: string[];
}

/**
 * Returns the AI summary block reported by the transparency endpoint.
 * @returns The policy, prompt template, and generation options.
 */
export function getAiSummaryTransparencyInfo(): AiSummaryTransparencyInfo {
  return {
    policy:
      'AI 요약은 제안이유 및 주요내용 원문에 근거해 핵심 정책 변화와 영향만을 한 문장으로 전달합니다. ' +
      '찬반 평가나 가치 판단을 덧붙이지 않으며, 원문에 없는 사실이나 전망을 생성하지 않습니다.',
    prompt: getAiSummaryPromptTemplate(),
    generationOptions: {
      temperature: AI_SUMMARY_MODEL_TEMPERATURE,
      numPredict: AI_SUMMARY_MODEL_NUM_PREDICT,
    },
    inputFields: ['법률안명', '제안이유 및 주요내용'],
  };
}
