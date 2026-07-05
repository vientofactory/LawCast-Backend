import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restores archive snapshot rows whose NSM snapshot fields were overwritten by
 * the now-fixed detail sync bug.
 *
 * Affected rows are the ones that have at least one change event after the
 * initial archive snapshot was created for one of the tracked NSM snapshot
 * fields. Those rows are restored to the earliest values recorded in the
 * change chain.
 */
export class RestoreContaminatedProposalReasonSnapshots1751760001000 implements MigrationInterface {
  name = 'RestoreContaminatedProposalReasonSnapshots1751760001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "notice_archives"
      SET
        "subject" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'subject'
          ORDER BY e."event_height" ASC, d."id" ASC
          LIMIT 1
        ),
        "committee" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'committee'
          ORDER BY e."event_height" ASC, d."id" ASC
          LIMIT 1
        ),
        "proposalReason" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'proposalReason'
          ORDER BY e."event_height" ASC, d."id" ASC
          LIMIT 1
        ),
        "content_proposal_date" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'proposalDate'
          ORDER BY e."event_height" ASC, d."id" ASC
          LIMIT 1
        ),
        "content_committee" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'contentCommittee'
          ORDER BY e."event_height" ASC, d."id" ASC
          LIMIT 1
        ),
        "content_referral_date" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'referralDate'
          ORDER BY e."event_height" ASC, d."id" ASC
          LIMIT 1
        ),
        "content_notice_period" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'noticePeriod'
          ORDER BY e."event_height" ASC, d."id" ASC
          LIMIT 1
        ),
        "content_proposal_session" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'proposalSession'
          ORDER BY e."event_height" ASC, d."id" ASC
          LIMIT 1
        )
      WHERE EXISTS (
        SELECT 1
        FROM "notice_change_events" e
        JOIN "notice_change_details" d ON d."event_id" = e."id"
        WHERE e."notice_num" = "notice_archives"."noticeNum"
          AND d."field_path" IN (
            'subject',
            'committee',
            'proposalReason',
            'proposalDate',
            'contentCommittee',
            'referralDate',
            'noticePeriod',
            'proposalSession'
          )
          AND e."event_height" > 1
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "notice_archives"
      SET
        "subject" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'subject'
          ORDER BY e."event_height" DESC, d."id" DESC
          LIMIT 1
        ),
        "committee" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'committee'
          ORDER BY e."event_height" DESC, d."id" DESC
          LIMIT 1
        ),
        "proposalReason" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'proposalReason'
          ORDER BY e."event_height" DESC, d."id" DESC
          LIMIT 1
        ),
        "content_proposal_date" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'proposalDate'
          ORDER BY e."event_height" DESC, d."id" DESC
          LIMIT 1
        ),
        "content_committee" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'contentCommittee'
          ORDER BY e."event_height" DESC, d."id" DESC
          LIMIT 1
        ),
        "content_referral_date" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'referralDate'
          ORDER BY e."event_height" DESC, d."id" DESC
          LIMIT 1
        ),
        "content_notice_period" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'noticePeriod'
          ORDER BY e."event_height" DESC, d."id" DESC
          LIMIT 1
        ),
        "content_proposal_session" = (
          SELECT d."after_value"
          FROM "notice_change_events" e
          JOIN "notice_change_details" d ON d."event_id" = e."id"
          WHERE e."notice_num" = "notice_archives"."noticeNum"
            AND d."field_path" = 'proposalSession'
          ORDER BY e."event_height" DESC, d."id" DESC
          LIMIT 1
        )
      WHERE EXISTS (
        SELECT 1
        FROM "notice_change_events" e
        JOIN "notice_change_details" d ON d."event_id" = e."id"
        WHERE e."notice_num" = "notice_archives"."noticeNum"
          AND d."field_path" IN (
            'subject',
            'committee',
            'proposalReason',
            'proposalDate',
            'contentCommittee',
            'referralDate',
            'noticePeriod',
            'proposalSession'
          )
          AND e."event_height" > 1
      )
    `);
  }
}
