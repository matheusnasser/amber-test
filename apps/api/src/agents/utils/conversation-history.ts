/**
 * Conversation history management utilities
 */

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { generateText } from "ai";
import { structurerModel } from "../../lib/ai";
import type { MessageData } from "../types";

/**
 * Format conversation history for display
 */
export function formatHistory(messages: MessageData[]): string {
  if (messages.length === 0) return "(No prior conversation.)";
  return messages
    .map((m) => {
      const speaker = m.role === "brand_agent" ? "You (Alex)" : "Supplier";
      return `${speaker}: ${m.content}`;
    })
    .join("\n\n");
}

/**
 * Summarize and trim conversation history using AI
 * Keep last 2 messages verbatim, summarize older messages
 */
export async function summarizeAndTrimHistory(
  messages: MessageData[],
): Promise<string> {
  if (messages.length === 0) return "(No prior conversation.)";
  if (messages.length <= 2) return formatHistory(messages);

  const olderMessages = messages.slice(0, -2);
  const recentMessages = messages.slice(-2);

  try {
    const olderText = olderMessages
      .map(
        (m) =>
          `${m.role === "brand_agent" ? "Alex" : "Supplier"}: ${m.content}`,
      )
      .join("\n");

    const { text: summary } = await generateText({
      model: structurerModel,
      prompt: `<role>You are a negotiation summarizer. Produce a concise recap of the conversation below.</role>

<conversation>
${olderText}
</conversation>

<instructions>
Summarize this negotiation conversation in 3-4 bullet points. Focus on: key offers made, concessions, sticking points, and any commitments. Be specific with numbers (dollar amounts, percentages, lead times).
</instructions>`,
      maxTokens: 300,
    });

    return `PRIOR CONVERSATION SUMMARY:\n${summary}\n\nLATEST EXCHANGE:\n${formatHistory(recentMessages)}`;
  } catch (err) {
    console.warn(
      "conversation-history: Summarization failed, using full history:",
      (err as Error).message?.slice(0, 100),
    );
    return formatHistory(messages);
  }
}

/**
 * Compress conversation history via truncation (no AI)
 * Keep last 2 messages verbatim, summarize older messages simply
 */
export function compressHistory(
  history: MessageData[],
): (HumanMessage | AIMessage)[] {
  if (history.length <= 2) {
    return history.map((m) =>
      m.role === "brand_agent"
        ? new HumanMessage(m.content)
        : new AIMessage(m.content),
    );
  }

  const older = history.slice(0, -2);
  const recent = history.slice(-2);

  // Build a compact recap of older exchanges
  const recap = older
    .map((m) => {
      const speaker = m.role === "brand_agent" ? "Buyer" : "You";
      // Truncate each older message to ~100 chars
      const short =
        m.content.length > 120 ? m.content.slice(0, 120) + "..." : m.content;
      return `${speaker}: ${short}`;
    })
    .join("\n");

  const recentMessages = recent.map((m) =>
    m.role === "brand_agent"
      ? new HumanMessage(m.content)
      : new AIMessage(m.content),
  );

  return [
    new HumanMessage(
      `[Prior conversation recap — do not respond to this, it is context only]\n${recap}`,
    ),
    new AIMessage(
      "Understood, I have the context from our prior exchange. Let me respond to the latest message.",
    ),
    ...recentMessages,
  ];
}
