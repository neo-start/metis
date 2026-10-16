// Private local launcher control. Never signal a PID obtained from a file.
import { request } from "node:http";
import { join, resolve } from "node:path";
import { readPrivateFile } from "./metisSharedService";

export async function requestMetisBackground(
  home: string,
  action: "status" | "stop",
): Promise<{ ready: boolean; stopped: boolean } | null> {
  const file = readPrivateFile(home, "metis-background.json");
  if (!file) return null;
  const state = JSON.parse(file.text) as Record<string, unknown>;
  if (
    typeof state.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.token) ||
    typeof state.socket !== "string" ||
    state.socket !== join(resolve(home), "run", "background.sock")
  )
    throw new Error("Invalid Metis background control state.");
  return new Promise((resolveRequest, reject) => {
    const req = request(
      {
        socketPath: state.socket as string,
        path: `/${action}`,
        method: action === "stop" ? "POST" : "GET",
        headers: { Authorization: `Bearer ${state.token}`, Connection: "close" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 4096) req.destroy(new Error("Invalid background response."));
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error("Metis background control refused the request."));
            return;
          }
          try {
            const result = JSON.parse(body) as { ready?: unknown; stopped?: unknown };
            if (typeof result.ready !== "boolean" || typeof result.stopped !== "boolean")
              throw new Error("Invalid background response.");
            resolveRequest({ ready: result.ready, stopped: result.stopped });
          } catch (error) {
            reject(error);
          }
        });
        response.on("error", reject);
      },
    );
    req.setTimeout(action === "stop" ? 40_000 : 1500, () => {
      req.destroy(new Error("Metis background control timed out."));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolveRequest(null);
      else reject(error);
    });
    req.end();
  });
}
