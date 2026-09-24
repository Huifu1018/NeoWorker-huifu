import { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon } from "lucide-react";
import type {
  PaperNewsCover as Cover,
  PaperNewsItem,
} from "../../shared/paper-news";

const names = { arxiv: "arXiv", huggingface: "Hugging Face", github: "GitHub" };
export function PaperNewsCover({
  item,
  language,
  onOpen,
}: {
  item: PaperNewsItem;
  language: string;
  onOpen: () => void;
}) {
  const element = useRef<HTMLButtonElement>(null);
  const [cover, setCover] = useState<Cover | null>(null);
  const [loading, setLoading] = useState(true);
  const zh = language === "zh-CN";
  useEffect(() => {
    let disposed = false;
    setCover(null);
    setLoading(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        void window.electronAPI
          .getPaperNewsCover(item.id)
          .then((value) => {
            if (!disposed) setCover(value);
          })
          .catch(() => {})
          .finally(() => {
            if (!disposed) setLoading(false);
          });
      },
      { rootMargin: "160px" },
    );
    if (element.current) observer.observe(element.current);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [item.id, item.date, item.imageUrl, item.pdfUrl, item.title]);
  const caption =
    cover?.kind === "pdf-page"
      ? zh
        ? "PDF 首页"
        : "PDF first page"
      : cover
        ? zh
          ? "来源配图"
          : "Source image"
        : loading
          ? zh
            ? "封面加载中"
            : "Loading cover"
          : zh
            ? "文字封面"
            : "Text cover";
  return (
    <button
      ref={element}
      className={`pn-cover ${cover ? "has-image" : "is-text"} ${cover?.kind === "pdf-page" ? "is-pdf" : ""}`}
      onClick={onOpen}
      aria-label={`${zh ? "打开来源" : "Open source"}：${item.title}`}
    >
      {cover ? (
        <img
          src={cover.dataUrl}
          alt=""
          decoding="async"
          onError={() => {
            setCover(null);
            setLoading(false);
          }}
        />
      ) : (
        <span className="pn-cover-text">
          <span className="pn-cover-source">
            {names[item.source]}{" "}
            <span>
              {item.source === "github"
                ? zh
                  ? "开源项目"
                  : "REPOSITORY"
                : zh
                  ? "论文"
                  : "PAPER"}
            </span>
          </span>
          <strong>{item.title}</strong>
          <span className="pn-cover-subtitle">
            {item.authors[0] || item.tags[0] || names[item.source]}
          </span>
        </span>
      )}
      <span className="pn-cover-caption">
        {cover?.kind === "source-image" ? (
          <ImageIcon size={11} />
        ) : (
          <FileText size={11} />
        )}
        {caption}
      </span>
    </button>
  );
}
