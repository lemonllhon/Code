import { type LCodeAccountAccess, type LCodeProviderAccountAccess } from "@lcode/shared";

export interface AccountRequestAuthMaterial {
  routingFeedback?: boolean;
  baseURL?: string;
  protocol?: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface AccountRequestAuthInput {
  providerId: string;
  modelId?: string;
  accountAccess: LCodeProviderAccountAccess | LCodeAccountAccess;
  reason: "model-request" | "usage";
}

export interface AccountAccessIdentityInput {
  providerId: string;
  accountAccess: LCodeProviderAccountAccess | LCodeAccountAccess;
}

export interface AccountRequestAuthResolver {
  resolveAccessCurrent(access: LCodeProviderAccountAccess): Promise<LCodeAccountAccess | null>;
  resolveCurrent(input: AccountRequestAuthInput): Promise<AccountRequestAuthMaterial>;
  assertCurrent(input: AccountAccessIdentityInput): Promise<void>;
}
