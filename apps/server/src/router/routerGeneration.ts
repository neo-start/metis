import { mkdir } from "node:fs/promises";
import { Effect } from "effect";
import type { RouterGenerationInput, TextGenerationShape } from "../git/Services/TextGeneration.ts";

/** Every Router presentation uses the same isolated, tool-free provider path. */
export function generateRouterMessage(service: TextGenerationShape, input: RouterGenerationInput) {
  return Effect.gen(function* () {
    if (!service.routeMessage)
      return yield* Effect.fail(new Error("Router generation unavailable."));
    yield* Effect.tryPromise(() => mkdir(input.cwd, { recursive: true, mode: 0o700 }));
    return yield* service.routeMessage(input).pipe(Effect.timeout("30 seconds"));
  });
}
