import { Effect, Option } from "effect";
import { ProviderService } from "./Services/ProviderService.ts";

/** Protect verified live hosts and explicitly fenced uncertain recovery from blind continuation. */
export const persistentSessionThreadIds = Effect.gen(function* () {
  const provider = Option.getOrUndefined(yield* Effect.serviceOption(ProviderService));
  const ids = yield* provider?.listPersistentSessionThreadIds?.() ?? Effect.succeed([]);
  const blocked = yield* provider?.listPersistentRecoveryBlockedThreadIds?.() ?? Effect.succeed([]);
  return new Set<string>([...ids, ...blocked]);
});
