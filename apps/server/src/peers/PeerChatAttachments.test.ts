import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { describe, it, expect } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PeerChatRequest,
  PEER_ATTACHMENT_CHUNK_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@synara/contracts";
import { makeManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments";
import { makePeerChatAttachments, peerAttachmentPrincipal } from "./PeerChatAttachments";

describe("peer attachment storage", () => {
  it("resumes scoped chunks, verifies content, protects claims and previews only sent images", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "peer-attachments-"));
    const runtime = ManagedRuntime.make(
      makeManagedAttachmentRepositoryLive().pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      const repository = await runtime.runPromise(Effect.service(ManagedAttachmentRepository));
      let upload = makePeerChatAttachments(repository, root);
      const begin = {
        action: "chat.attachment.begin",
        chatId: "chat",
        type: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 6,
      } as const;
      const attachmentId = (await upload("peer-a", "thread-a", begin)).attachment!.id;
      const chunk = {
        action: "chat.attachment.chunk",
        chatId: "chat",
        attachmentId,
        offset: 0,
        data: Buffer.from("abc").toString("base64"),
      } as const;
      await expect(upload("peer-b", "thread-a", chunk)).rejects.toThrow("不属于");
      await expect(upload("peer-a", "thread-b", chunk)).rejects.toThrow("不属于");
      await expect(upload("peer-a", "thread-a", { ...chunk, offset: 3 })).rejects.toThrow("顺序");
      await upload("peer-a", "thread-a", chunk);
      upload = makePeerChatAttachments(repository, root);
      await upload("peer-a", "thread-a", chunk);
      await expect(
        upload("peer-a", "thread-a", { ...chunk, data: Buffer.from("xyz").toString("base64") }),
      ).rejects.toThrow("不一致");
      await expect(
        upload("peer-a", "thread-a", {
          ...chunk,
          offset: 3,
          data: Buffer.from("defg").toString("base64"),
        }),
      ).rejects.toThrow("大小");
      await upload("peer-a", "thread-a", {
        ...chunk,
        offset: 3,
        data: Buffer.from("def").toString("base64"),
      });
      const finish = {
        action: "chat.attachment.finish",
        chatId: "chat",
        attachmentId,
        sha256: createHash("sha256").update("abcdef").digest("hex"),
      } as const;
      await expect(
        upload("peer-a", "thread-a", { ...finish, sha256: "0".repeat(64) }),
      ).rejects.toThrow("校验");
      const staged = await upload("peer-a", "thread-a", finish);
      expect(await upload("peer-a", "thread-a", finish)).toEqual(staged);
      const read = {
        action: "chat.attachment.read",
        chatId: "chat",
        attachmentId,
        offset: 0,
      } as const;
      await expect(upload("peer-a", "thread-a", read)).rejects.toThrow("尚未发送");
      const claim = await runtime.runPromise(
        repository.claimForAcceptedTurn({
          attachmentIds: [attachmentId],
          ownerThreadId: "thread-a",
          ...peerAttachmentPrincipal("peer-a"),
          commandId: "send",
          messageId: "message",
          now: new Date().toISOString(),
        }),
      );
      expect(claim.status).toBe("claimed");
      expect((await upload("peer-a", "thread-a", read)).attachmentData).toBe(
        Buffer.from("abcdef").toString("base64"),
      );
      await expect(upload("peer-b", "thread-a", read)).rejects.toThrow("不属于");
      await expect(upload("peer-a", "thread-a", chunk)).rejects.toThrow("完成上传");
      await upload("peer-a", "thread-a", {
        action: "chat.attachment.cancel",
        chatId: "chat",
        attachmentId,
      });
      expect(
        Option.isSome(await runtime.runPromise(repository.findClaimedById({ attachmentId }))),
      ).toBe(true);
      const cancelled = (await upload("peer-a", "thread-a", begin)).attachment!;
      await upload("peer-a", "thread-a", {
        action: "chat.attachment.cancel",
        chatId: "chat",
        attachmentId: cancelled.id,
      });
      await expect(
        upload("peer-a", "thread-a", { ...chunk, attachmentId: cancelled.id }),
      ).rejects.toThrow("不存在");
      await expect(
        upload("peer-a", "thread-a", {
          ...begin,
          sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
        }),
      ).rejects.toThrow("限制");
      await expect(upload("peer-a", "thread-a", { ...begin, name: "bad\nname" })).rejects.toThrow();
    } finally {
      await runtime.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid IDs and oversized chunks before they reach transport or storage", () => {
    const decode = Schema.decodeUnknownSync(PeerChatRequest);
    const base = {
      action: "chat.attachment.chunk",
      chatId: "chat",
      attachmentId: `att_v2_${"a".repeat(32)}`,
      offset: 0,
      data: "YQ==",
    };
    expect(decode(base)).toEqual(base);
    expect(() => decode({ ...base, attachmentId: "../../etc/passwd" })).toThrow();
    expect(() =>
      decode({ ...base, data: "A".repeat((PEER_ATTACHMENT_CHUNK_BYTES * 4) / 3 + 1) }),
    ).toThrow();
    expect(() => decode({ ...base, offset: -1 })).toThrow();
    expect(() => decode({ ...base, offset: 0.5 })).toThrow();
  });
});
