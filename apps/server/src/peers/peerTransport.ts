import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import https from "node:https";
import tls from "node:tls";
import type { IncomingMessage } from "node:http";

export interface PeerIdentity {
  cert: string;
  private: string;
}

export function instanceId(cert: string | Buffer): string {
  return `metis-${createHash("sha256").update(new X509Certificate(cert).raw).digest("hex").slice(0, 32)}`;
}

export function isLanAddress(value: string): boolean {
  const ip = value.replace(/^::ffff:/, "");
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return isIP(ip) === 6 && (ip === "::1" || /^(fc|fd|fe[89ab])/i.test(ip));
}

export function peerAddress(host: string, port: number): string {
  const clean = host.replace(/^::ffff:/, "");
  if (!isLanAddress(clean) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("需要有效的局域网 IP 和端口。");
  return `https://${isIP(clean) === 6 ? `[${clean}]` : clean}:${port}`;
}

export function parsePeerAddress(address: string): URL {
  const url = new URL(address.includes("://") ? address : `https://${address}`);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !url.port
  )
    throw new Error("请输入局域网 IP:端口。");
  peerAddress(hostname, Number(url.port));
  return url;
}

/** Bootstrap discloses no application data. The entered ID pins the certificate
 * before a pairing request or any message is sent. Normal calls use CA validation. */
export function discoverCertificate(
  address: string,
  expectedId: string,
  identity: PeerIdentity,
): Promise<string> {
  const url = parsePeerAddress(address);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port),
      rejectUnauthorized: false,
      cert: identity.cert,
      key: identity.private,
      minVersion: "TLSv1.3",
    });
    socket.setTimeout(5000, () => socket.destroy(new Error("连接设备超时。")));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      try {
        const raw = socket.getPeerCertificate().raw;
        if (!raw || instanceId(raw) !== expectedId) throw new Error("设备证书与实例 ID 不匹配。");
        resolve(new X509Certificate(raw).toString());
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}

export async function readPeerJson(request: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("通信内容过大。");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function peerRequest(
  address: string,
  cert: string,
  identity: PeerIdentity,
  path: string,
  body: unknown,
): Promise<unknown> {
  const url = parsePeerAddress(address);
  return new Promise((resolve, reject) => {
    const req = https.request(
      new URL(path, url),
      {
        method: "POST",
        ca: cert,
        cert: identity.cert,
        key: identity.private,
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        agent: false,
        checkServerIdentity: (_host, presented) =>
          presented.raw && instanceId(presented.raw) === instanceId(cert)
            ? undefined
            : new Error("设备身份不匹配。"),
        headers: { "content-type": "application/json" },
      },
      (response) => {
        void readPeerJson(response, 8 * 1024 * 1024).then((value) => {
          if (response.statusCode !== 200) {
            const message =
              typeof value === "object" && value !== null && "error" in value
                ? String(value.error)
                : "设备拒绝了请求。";
            reject(new Error(message));
          } else resolve(value);
        }, reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("设备响应超时，请稍后重试。")), 10000);
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
}
