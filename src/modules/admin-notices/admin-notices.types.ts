/**
 * Public shape of one admin notice as served by `GET /api/announcements`.
 * Field names mirror the Notion database properties (see
 * `admin-notices.constants.ts`).
 */
export interface AdminNotice {
  /** Notion page id */
  id: string;
  /** Notion `제목` — notice title */
  title: string;
  /** 공개 여부 — always true in responses (unpublished rows are filtered out) */
  published: boolean;
  /** 상태 (status/select option name), null when unset */
  status: string | null;
  /** 노출 순서, null when the property is empty */
  order: number | null;
  /** 긴급 checkbox — true when the operator marked the row urgent */
  urgent: boolean;
  /**
   * 내용 — plain text preview from the Notion rich text property,
   * newlines preserved. Serves as the list preview and as the body
   * fallback when the page has no block children.
   */
  content: string;
  /**
   * Markdown body converted from the page's Notion block tree
   * (notion-to-md). Empty when the page has no blocks or the
   * conversion failed — clients then fall back to `content`.
   */
  body: string;
}

export interface AdminNoticeListResponse {
  items: AdminNotice[];
}

/** Minimal Notion API shapes used by the query endpoint (read-only subset). */
export interface NotionRichTextItem {
  plain_text?: string;
}

export interface NotionPropertyObject {
  type?: string;
  title?: NotionRichTextItem[];
  checkbox?: boolean;
  rich_text?: NotionRichTextItem[];
  number?: number | null;
  status?: { name?: string } | null;
  select?: { name?: string } | null;
}

export interface NotionPageObject {
  id: string;
  properties?: Record<string, NotionPropertyObject>;
}

export interface NotionDatabaseQueryResponse {
  results?: NotionPageObject[];
  has_more?: boolean;
  next_cursor?: string | null;
}
