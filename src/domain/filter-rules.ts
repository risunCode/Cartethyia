import type { ContentBlock, NormalizedProviderRequest, NormalizedMessage, NormalizedTool } from "./contracts";

/** Active filter rule as resolved for the request pipeline. */
export interface ResolvedFilterRule {
  readonly pattern: string;
  readonly replacement: string;
  readonly isRegex: boolean;
}

export interface FilterRuleConfig {
  readonly enabled: boolean;
  readonly rules: readonly ResolvedFilterRule[];
}

/**
 * Pre-request content sanitizer. Applies pattern → replacement rules to all
 * text fields in the normalized request: message content blocks, reasoning
 * content, and tool descriptions. Non-text blocks (images, tool results)
 * are passed through unchanged.
 *
 * Rules are applied in sort order. Regex rules use the global flag; literal
 * rules use plain string replacement (all occurrences). An empty pattern or
 * empty replacement is valid (strips matching text).
 *
 * This module is pure — no side effects, no network, no logging. It mirrors
 * the token-saver boundary: the pipeline applies it after normalization and
 * before cache/token-saver planning.
 */
export function applyFilterRules(request: NormalizedProviderRequest, config: FilterRuleConfig): NormalizedProviderRequest {
  if (!config.enabled || config.rules.length === 0 || request.messages.length === 0) return request;

  const hasText = request.messages.some((message) =>
    message.content.some((block) => block.type === "text" && block.text !== undefined && block.text.length > 0)
  ) || request.tools.some((tool) => tool.description !== null && tool.description.length > 0);
  if (!hasText) return request;

  const compiled = config.rules.map((rule) => {
    if (rule.isRegex) {
      try {
        return { regex: new RegExp(rule.pattern, "gi"), replacement: rule.replacement, isRegex: true as const };
      } catch {
        // Skip invalid regex patterns silently — don't break the request
        return null;
      }
    }
    return { pattern: rule.pattern, replacement: rule.replacement, isRegex: false as const };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (compiled.length === 0) return request;

  const filterText = (text: string): string => {
    let result = text;
    for (const rule of compiled) {
      if (rule.isRegex) {
        result = result.replace(rule.regex, rule.replacement);
      } else if (rule.pattern.length > 0) {
        result = result.split(rule.pattern).join(rule.replacement);
      }
    }
    return result;
  };

  const filterBlock = (block: ContentBlock): ContentBlock => {
    if (block.type === "text" && block.text !== undefined && block.text.length > 0) {
      const filtered = filterText(block.text);
      return filtered === block.text ? block : { ...block, text: filtered };
    }
    return block;
  };

  const filterMessage = (message: NormalizedMessage): NormalizedMessage => {
    const content = message.content.map(filterBlock);
    const contentChanged = content.some((block, i) => block !== message.content[i]);
    const reasoning = message.reasoningContent !== undefined && message.reasoningContent.length > 0 ? filterText(message.reasoningContent) : message.reasoningContent;
    const reasoningChanged = reasoning !== message.reasoningContent;
    if (!contentChanged && !reasoningChanged) return message;
    return { ...message, content, ...(reasoningChanged ? { reasoningContent: reasoning } : {}) };
  };

  const filterTool = (tool: NormalizedTool): NormalizedTool => {
    if (tool.description === null || tool.description.length === 0) return tool;
    const filtered = filterText(tool.description);
    return filtered === tool.description ? tool : { ...tool, description: filtered };
  };

  const messages = request.messages.map(filterMessage);
  const tools = request.tools.map(filterTool);
  const messagesChanged = messages.some((message, i) => message !== request.messages[i]);
  const toolsChanged = tools.some((tool, i) => tool !== request.tools[i]);

  if (!messagesChanged && !toolsChanged) return request;
  return { ...request, messages, tools };
}
