export const MAX_AI_INPUT_CHARS = 20_000;

const PROMPT_INJECTION_PATTERN =
  /(ignore|disregard).{0,40}(instructions?|prompts?)|忽略(以上|上述|之前|前面).{0,30}(指令|提示)|系统提示词|system\s+prompt/i;

/** 明显试图覆盖系统指令的评论直接转人工，不交给模型单独判断 */
export function containsPromptInjection(text: string): boolean {
  return PROMPT_INJECTION_PATTERN.test(text);
}

export function truncateAiText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = "\n\n[内容已截断]";
  const keep = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, keep)}${suffix}`;
}
