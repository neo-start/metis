// FILE: pairingBootstrap.ts
// Purpose: Exchanges one-time remote pairing links before the application opens a WebSocket.
// Manual code entry and per-cause errors adapted from T3 Code's PairingRouteSurface;
// see THIRD_PARTY_NOTICES.md.

const PAIRING_PATH = "/pair";

interface PairingLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  replace(url: string): void;
}

interface PairingHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/** Why an exchange did not produce a session. Never carries the credential. */
export type PairingFailure =
  | { readonly kind: "missing-token" }
  | { readonly kind: "rejected"; readonly status: number }
  | { readonly kind: "blocked"; readonly status: number }
  | { readonly kind: "server"; readonly status: number }
  | { readonly kind: "network" };

interface PairingBootstrapDependencies {
  readonly location: PairingLocation;
  readonly history: PairingHistory;
  readonly fetch: typeof globalThis.fetch;
  readonly renderFailure: (failure: PairingFailure, retryCredential?: string) => void;
}

export type PairingBootstrapResult = "not-pairing" | "redirecting" | "failed";

/** Accepts a typed code ("abcd efgh-jkmn") or a pasted full pairing link. */
export function normalizePairingCredential(value: string): string {
  const trimmed = value.trim();
  const fromLink = /[#?&]token=([^&\s]+)/u.exec(trimmed)?.[1];
  return (fromLink ?? trimmed).replace(/[\s-]+/gu, "").toUpperCase();
}

export function classifyPairingResponse(status: number | undefined): PairingFailure {
  if (status === 401) return { kind: "rejected", status };
  if (status !== undefined && status >= 500) return { kind: "server", status };
  return { kind: "blocked", status: status ?? 0 };
}

export async function exchangePairingCredential(
  fetchImpl: typeof globalThis.fetch,
  credential: string,
): Promise<PairingFailure | null> {
  try {
    const response = await fetchImpl("/api/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    return response.ok ? null : classifyPairingResponse(response.status);
  } catch {
    return { kind: "network" };
  }
}

function describeFailure(failure: PairingFailure): {
  readonly title: string;
  readonly body: string;
  readonly diagnostic: string;
} {
  switch (failure.kind) {
    case "missing-token":
      return {
        title: "输入配对码",
        body: "这个地址没有带上配对码，可能是聊天软件截掉了链接中 # 之后的部分。在电脑上的 Metis 打开“设置 → 连接”，生成配对链接后，把显示的配对码输入到下方。",
        diagnostic: "未检测到配对码",
      };
    case "rejected":
      return {
        title: "配对码无效或已失效",
        body: "配对码只能使用一次，有效期为 5 分钟。请在电脑上重新生成，再在下方输入新的配对码。",
        diagnostic: `HTTP ${failure.status}`,
      };
    case "blocked":
      return {
        title: "配对请求被拦截",
        body: "请求没有通过 Metis 的配对校验，可能是网络、代理或 Cloudflare 安全设置拦截了它。可以换个网络后重试；如果配对码仍在有效期内，可继续使用。",
        diagnostic: failure.status ? `HTTP ${failure.status}` : "无响应状态",
      };
    case "server":
      return {
        title: "暂时连不上电脑",
        body: "电脑可能离线、休眠，或远程隧道断开了。请确认电脑上的 Metis 仍在运行后重试；如果配对码仍在有效期内，可继续使用。",
        diagnostic: `HTTP ${failure.status}`,
      };
    case "network":
      return {
        title: "网络请求失败",
        body: "请求没有发出，或者没有收到回应。请检查手机能否打开这个地址，然后重试；配对码仍可使用。",
        diagnostic: "网络错误",
      };
  }
}

const PAIRING_STYLES = `
  .metis-pair-button{min-height:44px;padding:0 20px;border:1px solid #d6ff55;background:#d6ff55;color:#10110f;font:600 16px/1 system-ui,-apple-system,sans-serif;cursor:pointer;transition:background-color 180ms ease-out,border-color 180ms ease-out,transform 180ms ease-out,box-shadow 180ms ease-out}
  .metis-pair-button:hover{background:#e3ff85;border-color:#e3ff85;transform:translateY(-2px);box-shadow:0 4px 0 #080907}
  .metis-pair-button:active{background:#c4ec3f;transform:translateY(0);box-shadow:none}
  .metis-pair-button:focus-visible,.metis-pair-input:focus-visible{outline:2px solid #fffdf7;outline-offset:3px}
  .metis-pair-button:disabled{opacity:.6;cursor:progress;transform:none;box-shadow:none}
  .metis-pair-input{width:100%;min-height:48px;box-sizing:border-box;padding:0 14px;border:1px solid #4a4e46;background:#10110f;color:#fffdf7;font:600 18px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;transition:border-color 180ms ease-out}
  .metis-pair-input:hover{border-color:#6b7065}
  @media (prefers-reduced-motion: reduce){.metis-pair-button,.metis-pair-input{transition:none}.metis-pair-button:hover{transform:none}}
`;

function renderPairingFailure(failure: PairingFailure, retryCredential?: string): void {
  const root = document.getElementById("root");
  if (!root) return;

  document.title = "Pairing · Metis";
  root.innerHTML = `
    <style>${PAIRING_STYLES}</style>
    <main style="min-height:100vh;box-sizing:border-box;display:grid;place-items:center;padding:32px 16px;background:#10110f;color:#f3f0e8;font-family:system-ui,-apple-system,sans-serif">
      <section style="width:min(100%,520px);box-sizing:border-box;border:1px solid #373a34;background:#171915;padding:clamp(24px,6vw,52px);box-shadow:12px 12px 0 #080907">
        <p style="margin:0 0 22px;color:#d6ff55;font:600 12px/1.2 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase">Metis 配对</p>
        <div role="alert" aria-live="assertive">
          <h1 tabindex="-1" data-pair="title" style="margin:0;color:#fffdf7;font-size:clamp(28px,7vw,44px);font-weight:600;line-height:1.05;letter-spacing:-.03em"></h1>
          <p data-pair="body" style="margin:20px 0 0;color:#b8bbb2;font-size:16px;line-height:1.6"></p>
          <p data-pair="diagnostic" style="margin:12px 0 0;color:#80847b;font:500 12px/1.4 'JetBrains Mono',ui-monospace,monospace"></p>
        </div>
        <form data-pair="form" style="margin:28px 0 0;display:grid;gap:12px">
          <label for="metis-pairing-code" style="color:#f3f0e8;font-size:14px;font-weight:600">配对码</label>
          <input id="metis-pairing-code" class="metis-pair-input" name="code" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="512" placeholder="12 位字母数字" />
          <button class="metis-pair-button" type="submit">连接</button>
        </form>
      </section>
    </main>`;

  const title = root.querySelector<HTMLElement>('[data-pair="title"]');
  const body = root.querySelector<HTMLElement>('[data-pair="body"]');
  const diagnostic = root.querySelector<HTMLElement>('[data-pair="diagnostic"]');
  const form = root.querySelector<HTMLFormElement>('[data-pair="form"]');
  const input = root.querySelector<HTMLInputElement>("#metis-pairing-code");
  const button = root.querySelector<HTMLButtonElement>(".metis-pair-button");
  if (!title || !body || !diagnostic || !form || !input || !button) return;

  const show = (next: PairingFailure) => {
    const text = describeFailure(next);
    title.textContent = text.title;
    body.textContent = text.body;
    diagnostic.textContent = `诊断：${text.diagnostic}`;
  };
  show(failure);
  // A transient failure never reached the one-time check, so the same code may be retried.
  if (retryCredential) {
    input.value = retryCredential;
    button.textContent = "重试";
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const credential = normalizePairingCredential(input.value);
    if (!credential) {
      input.focus();
      return;
    }
    button.disabled = true;
    button.textContent = "正在连接…";
    void exchangePairingCredential(globalThis.fetch, credential).then((result) => {
      if (!result) {
        window.location.replace("/");
        return;
      }
      show(result);
      button.disabled = false;
      const retryable = result.kind === "network" || result.kind === "server";
      button.textContent = retryable ? "重试" : "连接";
      if (!retryable) input.value = "";
      title.focus();
    });
  });

  if (failure.kind === "missing-token") input.focus();
  else title.focus();
}

export async function bootstrapPairingSession(
  dependencies: PairingBootstrapDependencies = {
    location: window.location,
    history: window.history,
    fetch: globalThis.fetch,
    renderFailure: renderPairingFailure,
  },
): Promise<PairingBootstrapResult> {
  if (dependencies.location.pathname !== PAIRING_PATH) {
    return "not-pairing";
  }

  const credential = new URLSearchParams(dependencies.location.hash.slice(1)).get("token");
  dependencies.history.replaceState(
    null,
    "",
    `${dependencies.location.pathname}${dependencies.location.search}`,
  );

  if (!credential) {
    dependencies.renderFailure({ kind: "missing-token" });
    return "failed";
  }

  const failure = await exchangePairingCredential(dependencies.fetch, credential);
  if (failure) {
    const retryable = failure.kind === "network" || failure.kind === "server";
    dependencies.renderFailure(failure, retryable ? credential : undefined);
    return "failed";
  }

  dependencies.location.replace("/");
  return "redirecting";
}
