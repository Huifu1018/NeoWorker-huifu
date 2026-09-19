import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export const HISTORY_READING_EVENT = "timeline-history-reading";

// A visible sentinel alone is not intent: opening a short task must not drain
// pages of internal tool events. Only an upward reading gesture requests a page.
export function useHistoryPagination({
  taskKey, containerRef, flowRef, hasMore, loading, error, loadMore, rows,
}: {
  taskKey: string;
  containerRef: RefObject<HTMLDivElement | null>;
  flowRef: RefObject<HTMLDivElement | null>;
  hasMore: boolean;
  loading: boolean;
  error?: string | null;
  loadMore?: () => void | Promise<void>;
  rows: unknown;
}) {
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState(false);
  const [completion, setCompletion] = useState(0);
  const requestRef = useRef<object | null>(null);
  const anchorRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const intentUntil = useRef(0);
  const lastRequestAt = useRef(0);
  const latest = useRef({ hasMore, loading, error, loadMore, localError });
  useLayoutEffect(() => {
    latest.current = { hasMore, loading, error, loadMore, localError };
  });

  useLayoutEffect(() => {
    requestRef.current = null;
    anchorRef.current = null;
    intentUntil.current = 0;
    lastRequestAt.current = 0;
    setPending(false);
    setLocalError(false);
    return () => { requestRef.current = null; anchorRef.current = null; };
  }, [taskKey]);

  const requestPage = useCallback(async (retry = false) => {
    const state = latest.current;
    if (requestRef.current || state.loading || !state.hasMore || !state.loadMore) return;
    if (!retry && (state.error || state.localError || Date.now() - lastRequestAt.current < 400)) return;
    const container = containerRef.current;
    const flow = flowRef.current;
    if (!container || !flow) return;
    const top = container.getBoundingClientRect().top;
    const element = Array.from(flow.querySelectorAll<HTMLElement>(
      ".assistant-message p, .assistant-message, .user-message, .action-block",
    )).find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > top && rect.top < top + container.clientHeight;
    });
    anchorRef.current = element ? { element, top: element.getBoundingClientRect().top } : null;
    const request = {};
    requestRef.current = request;
    lastRequestAt.current = Date.now();
    intentUntil.current = 0;
    container.dispatchEvent(new Event(HISTORY_READING_EVENT));
    setPending(true);
    setLocalError(false);
    try {
      await state.loadMore();
    } catch {
      if (requestRef.current === request) setLocalError(true);
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        setPending(false);
        setCompletion((value) => value + 1);
      }
    }
  }, [containerRef, flowRef]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const container = containerRef.current;
    if (anchor?.element.isConnected && container) {
      // The DOM anchor also accounts for native scroll anchoring and avoids
      // counting unrelated streamed text appended below the reader.
      container.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
    }
    if (!pending && !loading) anchorRef.current = null;
  }, [rows, pending, loading, completion, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let previousTop = container.scrollTop;
    let touchY: number | undefined;
    const nearStart = () => {
      const flow = flowRef.current;
      if (!flow) return false;
      const bounds = container.getBoundingClientRect();
      const start = flow.getBoundingClientRect().top;
      return start >= bounds.top - 160 && start <= bounds.bottom;
    };
    const upward = () => {
      intentUntil.current = Date.now() + 1000;
      if (nearStart()) void requestPage();
    };
    const nestedScroller = (target: EventTarget | null) => {
      let node = target instanceof Element ? target : null;
      while (node && node !== container) {
        if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return true;
        node = node.parentElement;
      }
      return false;
    };
    const wheel = (event: WheelEvent) => {
      if (requestRef.current && ((event.deltaY < 0 && container.scrollTop > 0) || event.deltaY > 0)) anchorRef.current = null;
      if (event.deltaY < 0 && !nestedScroller(event.target)) upward();
      else intentUntil.current = 0;
    };
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (requestRef.current && container.scrollTop > 0) anchorRef.current = null;
      if (y !== undefined && touchY !== undefined && y > touchY && !nestedScroller(event.target)) upward();
      else intentUntil.current = 0;
      touchY = y;
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable=true]"))) return;
      if (requestRef.current && container.scrollTop > 0) anchorRef.current = null;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) && !nestedScroller(event.target)) upward();
      else intentUntil.current = 0;
    };
    const pointer = () => { intentUntil.current = Date.now() + 1000; anchorRef.current = null; };
    const scroll = () => {
      const movingUp = container.scrollTop < previousTop;
      previousTop = container.scrollTop;
      if (movingUp && Date.now() < intentUntil.current && nearStart()) void requestPage();
    };
    container.addEventListener("wheel", wheel, { passive: true });
    container.addEventListener("touchstart", touchStart, { passive: true });
    container.addEventListener("touchmove", touchMove, { passive: true });
    container.addEventListener("keydown", key);
    container.addEventListener("pointerdown", pointer);
    container.addEventListener("scroll", scroll, { passive: true });
    return () => {
      container.removeEventListener("wheel", wheel);
      container.removeEventListener("touchstart", touchStart);
      container.removeEventListener("touchmove", touchMove);
      container.removeEventListener("keydown", key);
      container.removeEventListener("pointerdown", pointer);
      container.removeEventListener("scroll", scroll);
    };
  }, [containerRef, flowRef, requestPage, taskKey]);

  const retry = useCallback(() => { void requestPage(true); }, [requestPage]);
  return { pending: pending || loading, failed: Boolean(error) || localError, retry };
}
