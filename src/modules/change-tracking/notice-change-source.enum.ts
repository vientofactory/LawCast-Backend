export enum NoticeChangeSource {
  ARCHIVE_UPSERT = 'archive:upsert',
  ARCHIVE_IS_DONE_SYNC = 'archive:isDoneSync',
  ARCHIVE_RENUMBERED = 'archive:renumbered',
  ARCHIVE_SOURCE_MISSING = 'archive:source-missing',
  ARCHIVE_UPDATE_SOURCE_HTML = 'archive:updateSourceHtml',
  ARCHIVE_UPDATE_NSM_HTML_AND_DETAIL = 'archive:updateNsmHtmlAndDetail',
  ARCHIVE_UPDATE_LIKMS_PROPOSAL_REASON = 'archive:likmsProposalReason',
  BOOTSTRAP_LEGACY_SEED = 'bootstrap:legacy-seed',
}

export enum NoticeChangeSourcePrefix {
  BOOTSTRAP = 'bootstrap:',
}
