import { describe, expect, it } from "vitest";
import {
  hasComposerSendableDraft,
  isComposerSubmissionBusy,
} from "../composer-submission-state";

describe("composer submission state", () => {
  it("keeps the composer available while an earlier task turn is running", () => {
    expect(
      isComposerSubmissionBusy({
        isTaskWorking: true,
        isUploadingAttachments: false,
        isPreparingMessage: true,
        isQueueingFollowUp: false,
      }),
    ).toBe(false);
  });

  it("blocks duplicate queue clicks until the current enqueue finishes", () => {
    expect(
      isComposerSubmissionBusy({
        isTaskWorking: true,
        isUploadingAttachments: false,
        isPreparingMessage: true,
        isQueueingFollowUp: true,
      }),
    ).toBe(true);
  });

  it("still blocks overlapping preparation before a task has started", () => {
    expect(
      isComposerSubmissionBusy({
        isTaskWorking: false,
        isUploadingAttachments: false,
        isPreparingMessage: true,
        isQueueingFollowUp: false,
      }),
    ).toBe(true);
  });

  it("keeps the composer available while a follow-up IPC call waits for the turn", () => {
    expect(
      isComposerSubmissionBusy({
        isTaskWorking: false,
        hasPendingFollowUpDispatch: true,
        isUploadingAttachments: false,
        isPreparingMessage: true,
        isQueueingFollowUp: false,
      }),
    ).toBe(false);
  });

  it("treats synchronously tracked draft text as sendable before React state catches up", () => {
    expect(
      hasComposerSendableDraft({
        hasLiveComposerDraft: false,
        inputValue: "",
        currentDraftValue: "/ppt-master 帮我优化一下PPT",
        pendingAttachmentCount: 0,
        isPromptComposing: false,
      }),
    ).toBe(true);
  });

  it("treats synchronously tracked attachments as sendable before React state catches up", () => {
    expect(
      hasComposerSendableDraft({
        hasLiveComposerDraft: false,
        inputValue: "",
        pendingAttachmentCount: 0,
        currentAttachmentCount: 1,
        isPromptComposing: false,
      }),
    ).toBe(true);
  });
});
