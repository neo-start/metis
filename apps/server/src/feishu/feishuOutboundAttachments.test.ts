import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeFeishuAttachmentSender,
  resolveFeishuAttachmentTarget,
} from "./feishuOutboundAttachments.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "feishu-outbound-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const config = {
    appId: "cli_test",
    appSecret: "test-secret-placeholder-long",
    allowedOpenIds: ["ou_owner"],
  };
  await writeFile(path.join(root, "feishu-app.json"), JSON.stringify(config));
  await writeFile(path.join(workspaceRoot, "result.png"), Buffer.from("test image bytes"));
  const send = vi.fn<NonNullable<Parameters<typeof makeFeishuAttachmentSender>[0]["send"]>>(
    async () => ({ messageId: "om_receipt" }),
  );
  const options = {
    baseDir: root,
    stateDir: root,
    send,
    resolveTarget: async () => ({
      chatId: "oc_private",
      senderId: "ou_owner",
      replyTo: "om_request",
    }),
  };
  const input = {
    threadId: "task",
    workspaceRoot,
    filePath: "result.png",
    kind: "image" as const,
    idempotencyKey: "image-1",
  };
  return { root, config, options, input, send };
}
describe("Feishu outbound attachments", () => {
  it("uploads image bytes and retains the receipt across process restarts", async () => {
    const f = await fixture();
    await expect(makeFeishuAttachmentSender(f.options)(f.input)).resolves.toMatchObject({
      messageId: "om_receipt",
      kind: "image",
    });
    await expect(makeFeishuAttachmentSender(f.options)(f.input)).resolves.toMatchObject({
      messageId: "om_receipt",
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[2]).toMatchObject({
      kind: "image",
      fileName: "result.png",
      bytes: Buffer.from("test image bytes"),
    });
  });
  it("uses the native file variant and refuses same-key changed bytes", async () => {
    const f = await fixture();
    const sender = makeFeishuAttachmentSender(f.options);
    await sender({ ...f.input, kind: "file" });
    expect(f.send.mock.calls[0]?.[2]).toMatchObject({ kind: "file" });
    await writeFile(path.join(f.input.workspaceRoot, "result.png"), "changed");
    await expect(sender({ ...f.input, kind: "file" })).rejects.toThrow("different content");
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("does not repeat a delivery after a lost acknowledgement", async () => {
    const f = await fixture();
    f.send.mockRejectedValueOnce(new Error("lost response"));
    await expect(makeFeishuAttachmentSender(f.options)(f.input)).rejects.toThrow("unknown");
    await expect(makeFeishuAttachmentSender(f.options)(f.input)).rejects.toThrow("unknown");
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("rejects workspace escapes including symlinks before upload", async () => {
    const f = await fixture();
    const sender = makeFeishuAttachmentSender(f.options);
    await symlink(
      path.join(f.root, "feishu-app.json"),
      path.join(f.input.workspaceRoot, "escape.json"),
    );
    for (const filePath of ["../feishu-app.json", "escape.json"])
      await expect(sender({ ...f.input, filePath })).rejects.toThrow("inside");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("checks the current allowlist and active turn before sending", async () => {
    const f = await fixture();
    const sender = makeFeishuAttachmentSender(f.options);
    await expect(
      sender(f.input, async () => {
        throw new Error("inactive");
      }),
    ).rejects.toThrow("inactive");
    await writeFile(
      path.join(f.root, "feishu-app.json"),
      JSON.stringify({ ...f.config, allowedOpenIds: ["ou_other"] }),
    );
    await expect(sender(f.input)).rejects.toThrow("no longer allowed");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects empty or oversized media before upload", async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.input.workspaceRoot, "result.png"),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    );
    await expect(makeFeishuAttachmentSender(f.options)(f.input)).rejects.toThrow("size limit");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("binds to the caller's task and refuses multiple recipients", async () => {
    const f = await fixture();
    const directory = path.join(f.root, "feishu-router-delivery");
    await mkdir(directory);
    const record = {
      workerId: "task",
      command: { threadId: "controller" },
      chatId: "oc_private",
      senderId: "ou_owner",
      replyTo: "om_request",
    };
    await writeFile(path.join(directory, `${"a".repeat(64)}.json`), JSON.stringify(record));
    await expect(resolveFeishuAttachmentTarget(f.root, "task")).resolves.toMatchObject({
      chatId: "oc_private",
    });
    await expect(resolveFeishuAttachmentTarget(f.root, "unrelated")).rejects.toThrow("binding");
    await writeFile(
      path.join(directory, `${"b".repeat(64)}.json`),
      JSON.stringify({ ...record, chatId: "oc_other" }),
    );
    await expect(resolveFeishuAttachmentTarget(f.root, "task")).rejects.toThrow("binding");
  });
});
