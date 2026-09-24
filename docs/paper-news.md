# Paper News

Paper News is available in the current source tree. Existing v0.2.3 installers do not include it.

## Discover and save

Open **Paper News** in the sidebar, choose **Topics**, and enter up to five comma-separated search phrases. English terms work best with these sources. The available time windows are 7, 14, and 30 days.

| Source | Content and date | Fetch limit |
| --- | --- | --- |
| arXiv | Title/abstract topic search; original publication date | 60 recent matches |
| Hugging Face | Daily paper selection; selection date | Up to 100 selected papers, filtered by the time window |
| GitHub | Repository keyword search; last code push date | 60 recently active repositories, fetched by star count |

These are bounded feeds, not exhaustive literature searches. A paper can appear under both arXiv and Hugging Face. Daily selections are not restricted to topic matches. GitHub search semantics differ from exact local keyword matching.

The recommendation score uses literal, case-insensitive topic matches (70%) and recency within the selected window (30%). It does not measure scientific rigor, correctness, or reproducibility. Stars and upvotes are shown separately as source-provided popularity counts.

Search filters the results already fetched. Bookmark up to 200 items to retain them independently of subsequent refreshes or topic changes. Source titles and abstracts remain in their original language; controls follow the application's Chinese/English setting.

The feed uses three cards per row on wide panels, two on medium panels, and one on narrow panels. Each source has a consistent color and icon in its overview and paper cards. Ranking details are available under **About ranking and sources**.

## Read, translate, research

Card actions create a fresh task draft containing the original source links. Review and send it to run with the model and permissions configured in NeoWorker:

- **Read:** retrieve the full paper or repository documentation and produce a cited explanation.
- **Translate:** translate the full paper into the interface language, preserving figures, tables, equations, and numbering in a final PDF. Repository cards request a translated Markdown README instead.
- **Research:** compare the source with related work and implementations and produce a cited research report.

No model request runs merely from fetching a feed or opening a draft. Drafts treat source metadata as reference data rather than instructions. Full-text retrieval, translation, and research still depend on source accessibility, the selected model, and the existing document tools; feed success does not prove task completion.

## Refresh and storage

Opening the page refreshes sources whose successful results are older than 30 minutes, or whose failed attempt is eligible for retry. **Refresh** requests new data manually, with a persisted per-source cooldown. Temporary connection failures receive at most one retry after three seconds; rate limits and access denials are not immediately retried. Server Retry-After and GitHub quota reset deadlines are respected across restarts and topic changes. While the page is visible, eligible transient failures are retried automatically. Leaving the page does not restart an in-flight fetch. A source failure retains its prior results and last successful fetch time; the other sources can still update. An unavailable source with no cache displays a dash, not a misleading zero-result count.

Configuration, fetched metadata, and bookmarks are stored in `paper-news.json` under the application's user-data directory. Papers and repository code are not downloaded during feed refresh. Fetches use the application's existing system-proxy-aware network transport and require no API token. GitHub public search quotas and regional network restrictions can limit availability.

## Implementation

The implementation is independent TypeScript code integrated with NeoWorker's desktop IPC and design system. It uses official source APIs; no reference-project source code or third-party feed mirrors are embedded.
