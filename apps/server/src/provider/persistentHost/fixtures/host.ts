import { runPersistentCodexHost } from "../server.ts";
const directory = process.argv[2]!;
const host = await runPersistentCodexHost(
  directory,
  process.env.METIS_FAKE_SMALL_JOURNAL ? { journalBytes: 64 * 1024, receiptCount: 12 } : undefined,
);
await host.closed;
