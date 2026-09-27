/**
 * Resolves a turn's attachments for the provider: staged uploads (opaque
 * `staged:` references) through the staging authority, legacy path
 * attachments from the agent's allowed roots. The result keeps the input
 * order; anything that could not be read comes back as a skipped entry.
 */
import type { AgentHomeStore } from "../execution/home.js";
import { providerSupportsImages } from "../providers/capabilities.js";
import { defaultAttachmentRoots, readTurnAttachments, type ExtractedAttachment } from "../rpc/attachments.js";
import type { TurnRunnerOptions } from "../rpc/send.js";
import { STAGED_PATH_PREFIX, type AttachmentStagingStore } from "./staging.js";

export function createTurnAttachmentReader({ homes, attachmentStaging }: {
  homes: Pick<AgentHomeStore, "pathFor"> | undefined;
  attachmentStaging: Pick<AttachmentStagingStore, "resolveForSend">;
}): NonNullable<TurnRunnerOptions["readAttachments"]> {
  return async (agentId, attachments, signal, extras) => {
    const home = homes?.pathFor(agentId);
    const provider = extras?.provider;
    const model = extras?.model;
    // The turn decides image support (live catalog first); the static matrix
    // is only the fallback for callers that do not pass it.
    const supportsImages = extras?.supportsImages
      ?? (provider !== undefined && model !== undefined ? providerSupportsImages(provider, model) : false);
    const source = attachments ?? [];
    const indexed = source.map((attachment, inputIndex) => ({ attachment, inputIndex }));
    const opaque = indexed.filter(({ attachment }) => attachment.path.startsWith(STAGED_PATH_PREFIX));
    const legacy = indexed.filter(({ attachment }) => !attachment.path.startsWith(STAGED_PATH_PREFIX));
    const result: Array<ExtractedAttachment | undefined> = new Array(source.length);
    if (legacy.length > 0) {
      const { extracted } = await readTurnAttachments(
        legacy.map(({ attachment }) => attachment),
        defaultAttachmentRoots(home),
        signal,
      );
      for (const [legacyIndex, item] of extracted.entries()) {
        const original = legacy[legacyIndex];
        if (original) result[original.inputIndex] = item;
      }
    }
    if (opaque.length > 0) {
      const outcome = await attachmentStaging.resolveForSend(
        agentId,
        opaque.map(({ attachment }) => attachment.path),
        { conversationId: extras?.conversationId, providerSupportsImages: supportsImages, retry: extras?.retry, deferConsumption: true },
      );
      const resolvedById = new Map(outcome.attachments.map((item) => [item.id, item]));
      const usedIds = new Set<string>();
      const skippedByRef = new Map<string, string[]>();
      for (const skipped of outcome.skipped) {
        const reasons = skippedByRef.get(skipped.ref) ?? [];
        reasons.push(skipped.reason);
        skippedByRef.set(skipped.ref, reasons);
      }
      for (const { attachment, inputIndex } of opaque) {
        const id = attachment.path.slice(STAGED_PATH_PREFIX.length);
        const item = usedIds.has(id) ? undefined : resolvedById.get(id);
        if (item) {
          usedIds.add(id);
          result[inputIndex] = {
            name: item.displayName,
            path: STAGED_PATH_PREFIX + item.id,
            kind: item.kind,
            ...(item.text !== undefined ? { text: item.text } : {}),
            ...(item.imageDataUrl !== undefined ? { imageDataUrl: item.imageDataUrl } : {}),
          };
        } else {
          const reasons = skippedByRef.get(attachment.path);
          result[inputIndex] = {
            name: attachment.name,
            path: attachment.path,
            skipped: reasons?.shift() ?? "não processado",
          };
        }
      }
    }
    return source.map((attachment, inputIndex) => result[inputIndex] ?? {
      name: attachment.name,
      path: attachment.path,
      skipped: "não processado",
    });
  };
}
