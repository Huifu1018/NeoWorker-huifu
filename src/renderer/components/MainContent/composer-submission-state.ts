export interface ComposerSubmissionState {
  isTaskWorking: boolean;
  /**
   * A follow-up has already been handed to the task runtime, but its IPC
   * promise may still be waiting for the whole turn to finish. That wait must
   * not disable the composer or block the next FIFO submission.
   */
  hasPendingFollowUpDispatch?: boolean;
  isUploadingAttachments: boolean;
  isPreparingMessage: boolean;
  isQueueingFollowUp: boolean;
}

export interface ComposerDraftAvailabilityState {
  hasLiveComposerDraft: boolean;
  inputValue: string;
  currentDraftValue?: string;
  pendingAttachmentCount: number;
  currentAttachmentCount?: number;
  isPromptComposing: boolean;
}

/**
 * A started task can keep the original send promise open for the whole turn.
 * That promise must not disable the composer: while the task is working, the
 * user is allowed to add another message to its FIFO follow-up queue.
 */
export function isComposerSubmissionBusy({
  isTaskWorking,
  hasPendingFollowUpDispatch = false,
  isUploadingAttachments,
  isPreparingMessage,
  isQueueingFollowUp,
}: ComposerSubmissionState): boolean {
  if (isQueueingFollowUp) return true;
  if (isTaskWorking || hasPendingFollowUpDispatch) return false;
  return isUploadingAttachments || isPreparingMessage;
}

export function hasComposerSendableDraft({
  hasLiveComposerDraft,
  inputValue,
  currentDraftValue,
  pendingAttachmentCount,
  currentAttachmentCount = pendingAttachmentCount,
  isPromptComposing,
}: ComposerDraftAvailabilityState): boolean {
  return (
    hasLiveComposerDraft ||
    Boolean(inputValue.trim()) ||
    Boolean(currentDraftValue?.trim()) ||
    pendingAttachmentCount > 0 ||
    currentAttachmentCount > 0 ||
    isPromptComposing
  );
}
