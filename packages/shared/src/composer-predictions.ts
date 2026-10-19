import { z } from "zod";

export const COMPOSER_PREDICTION_QUERY_SOURCE = "composer_prediction";
export const COMPOSER_PREDICTION_TIMEOUT_MS = 20_000;
export const COMPOSER_PREDICTION_MAX_CHARACTERS = 240;
export const composerPredictionRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    boundaryMessageId: z.string().min(1).max(256),
  })
  .strict();
export type ComposerPredictionRequest = z.infer<typeof composerPredictionRequestSchema>;
export function isComposerPredictionText(text: unknown): text is string {
  return (
    typeof text === "string" &&
    text.length <= COMPOSER_PREDICTION_MAX_CHARACTERS &&
    Array.from(text).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127 && code !== 0x2028 && code !== 0x2029;
    })
  );
}
export const composerPredictionResponseSchema = z
  .object({
    suggestion: z.string().max(COMPOSER_PREDICTION_MAX_CHARACTERS).refine(isComposerPredictionText),
  })
  .strict();
