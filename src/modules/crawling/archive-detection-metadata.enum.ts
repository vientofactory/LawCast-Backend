export enum SourceDeletionDetectedAs {
  SOURCE_DELETED = 'source_deleted',
  UNCONFIRMED = 'unconfirmed',
}

export enum SourceDeletionDetectionMethod {
  DETAIL_PAGE_HTTP_404 = 'detail-page-http-404',
  NSM_ERROR_WITHOUT_HTTP_PROBE_CONFIRMATION = 'nsm-error-without-http-probe-confirmation',
  NSM_ERROR_CONFIRMED_VIA_HTTP_PROBE = 'nsm-error-confirmed-via-http-probe',
  HTTP_PROBE_AFTER_TIMEOUT = 'http-probe-after-timeout',
}
