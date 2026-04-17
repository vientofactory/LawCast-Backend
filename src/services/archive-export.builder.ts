import { NoticeArchive } from '../entities/notice-archive.entity';

export interface ArchiveVerificationScript {
  fileName: string;
  content: string;
}

export interface ArchiveIntegrityState {
  checkedAt: Date | null;
  passed: boolean | null;
  calculatedSha256: string | null;
}

export interface ArchiveExportBuilderInput {
  noticeNum: number;
  generatedAt: Date;
  row: NoticeArchive;
  integrity: ArchiveIntegrityState;
  httpMetadata: Record<string, unknown>;
  dbRecord: Record<string, unknown>;
}

export interface ArchiveExportArtifacts {
  zipFileName: string;
  jsonFileName: string;
  jsonContent: string;
  integrityFileName: string;
  integrityContent: string;
  verificationScripts: ArchiveVerificationScript[];
}

export const buildArchiveExportArtifacts = (
  params: ArchiveExportBuilderInput,
): ArchiveExportArtifacts => {
  const { noticeNum, generatedAt, row, integrity, httpMetadata, dbRecord } =
    params;

  const exportPayload = {
    exportMeta: {
      generatedAt,
      formatVersion: '1.0',
      recordType: 'lawcast_notice_archive',
      noticeNum,
    },
    dbRecord,
    integritySnapshot: {
      checkedAt: integrity.checkedAt,
      passed: integrity.passed,
      storedSha256: row.sourceHtmlSha256,
      calculatedSha256: integrity.calculatedSha256,
    },
    httpMetadata,
  };

  const fileStamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  const baseFileName = `lawcast-archive-${noticeNum}-${fileStamp}`;
  const jsonFileName = `${baseFileName}.json`;
  const integrityFileName = `${baseFileName}.integrity.txt`;

  return {
    zipFileName: `${baseFileName}.zip`,
    jsonFileName,
    jsonContent: JSON.stringify(exportPayload, null, 2),
    integrityFileName,
    integrityContent: buildIntegrityMetadataText({
      noticeNum,
      generatedAt,
      row,
      integrity,
      httpMetadata,
    }),
    verificationScripts: buildVerificationScripts({
      jsonFileName,
      integrityFileName,
    }),
  };
};

const buildIntegrityMetadataText = (params: {
  noticeNum: number;
  generatedAt: Date;
  row: NoticeArchive;
  integrity: ArchiveIntegrityState;
  httpMetadata: Record<string, unknown>;
}): string => {
  const { noticeNum, generatedAt, row, integrity, httpMetadata } = params;

  const lines = [
    'LawCast Archive Integrity Metadata',
    '=================================',
    `noticeNum: ${noticeNum}`,
    `generatedAt: ${generatedAt.toISOString()}`,
    `archivedAt: ${row.archivedAt?.toISOString() ?? 'N/A'}`,
    `sourceHtmlSizeBytes: ${row.sourceHtml ? Buffer.byteLength(row.sourceHtml, 'utf8') : 0}`,
    `storedSha256: ${row.sourceHtmlSha256 ?? 'N/A'}`,
    `calculatedSha256: ${integrity.calculatedSha256 ?? 'N/A'}`,
    `integrityPassed: ${integrity.passed === null ? 'N/A' : integrity.passed ? 'true' : 'false'}`,
    `integrityCheckedAt: ${integrity.checkedAt?.toISOString() ?? 'N/A'}`,
    `httpFetchedAt: ${row.httpFetchedAt?.toISOString() ?? 'N/A'}`,
    `httpStatusCode: ${row.httpStatusCode ?? 'N/A'}`,
    `httpContentType: ${row.httpContentType ?? 'N/A'}`,
    `httpEtag: ${row.httpEtag ?? 'N/A'}`,
    `httpLastModified: ${row.httpLastModified ?? 'N/A'}`,
    `httpRequestUrl: ${typeof httpMetadata.requestUrl === 'string' ? httpMetadata.requestUrl : 'N/A'}`,
    `httpResponseUrl: ${typeof httpMetadata.responseUrl === 'string' ? httpMetadata.responseUrl : 'N/A'}`,
  ];

  return `${lines.join('\n')}\n`;
};

const buildVerificationScripts = (params: {
  jsonFileName: string;
  integrityFileName: string;
}): ArchiveVerificationScript[] => {
  const { jsonFileName, integrityFileName } = params;

  const bashScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `JSON_FILE="${jsonFileName}"`,
    `INTEGRITY_FILE="${integrityFileName}"`,
    '',
    'if ! command -v jq >/dev/null 2>&1; then',
    '  echo "jq is required. Please install jq first." >&2',
    '  exit 1',
    'fi',
    '',
    'if [ ! -f "$JSON_FILE" ]; then',
    '  echo "JSON file not found: $JSON_FILE" >&2',
    '  exit 1',
    'fi',
    '',
    'if [ ! -f "$INTEGRITY_FILE" ]; then',
    '  echo "Integrity metadata file not found: $INTEGRITY_FILE" >&2',
    '  exit 1',
    'fi',
    '',
    "stored_sha=$(awk -F': ' '/^storedSha256:/ {print $2}' \"$INTEGRITY_FILE\" | tr -d '\\r')",
    'if [ -z "$stored_sha" ] || [ "$stored_sha" = "N/A" ]; then',
    '  echo "storedSha256 is missing in integrity metadata." >&2',
    '  exit 1',
    'fi',
    '',
    'calculated_sha=$(jq -rj ".dbRecord.sourceHtml" "$JSON_FILE" | shasum -a 256 | cut -d " " -f1)',
    '',
    'echo "storedSha256:     $stored_sha"',
    'echo "calculatedSha256: $calculated_sha"',
    '',
    'if [ "$stored_sha" = "$calculated_sha" ]; then',
    '  echo "Integrity check: PASSED"',
    '  exit 0',
    'fi',
    '',
    'echo "Integrity check: FAILED" >&2',
    'exit 2',
    '',
  ].join('\n');

  const powerShellScript = [
    '$ErrorActionPreference = "Stop"',
    '',
    `$JsonFile = "${jsonFileName}"`,
    `$IntegrityFile = "${integrityFileName}"`,
    '',
    'if (!(Test-Path -LiteralPath $JsonFile)) {',
    '  Write-Error "JSON file not found: $JsonFile"',
    '}',
    '',
    'if (!(Test-Path -LiteralPath $IntegrityFile)) {',
    '  Write-Error "Integrity metadata file not found: $IntegrityFile"',
    '}',
    '',
    '$integrityLine = Select-String -Path $IntegrityFile -Pattern "^storedSha256:\\s*(.+)$" | Select-Object -First 1',
    'if ($null -eq $integrityLine) {',
    '  Write-Error "storedSha256 is missing in integrity metadata."',
    '}',
    '',
    '$storedSha = $integrityLine.Matches[0].Groups[1].Value.Trim()',
    'if ([string]::IsNullOrWhiteSpace($storedSha) -or $storedSha -eq "N/A") {',
    '  Write-Error "storedSha256 is empty in integrity metadata."',
    '}',
    '',
    '$payload = Get-Content -Raw -LiteralPath $JsonFile | ConvertFrom-Json',
    '$sourceHtml = [string]$payload.dbRecord.sourceHtml',
    '$bytes = [System.Text.Encoding]::UTF8.GetBytes($sourceHtml)',
    '$hashBytes = [System.Security.Cryptography.SHA256]::HashData($bytes)',
    '$calculatedSha = ([Convert]::ToHexString($hashBytes)).ToLowerInvariant()',
    '',
    'Write-Host "storedSha256:     $storedSha"',
    'Write-Host "calculatedSha256: $calculatedSha"',
    '',
    'if ($storedSha -eq $calculatedSha) {',
    '  Write-Host "Integrity check: PASSED"',
    '  exit 0',
    '}',
    '',
    'Write-Error "Integrity check: FAILED"',
    'exit 2',
    '',
  ].join('\n');

  return [
    {
      fileName: 'verify-integrity.sh',
      content: bashScript,
    },
    {
      fileName: 'verify-integrity.ps1',
      content: powerShellScript,
    },
  ];
};
