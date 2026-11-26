import { APP_CONSTANTS } from '../../config/app.config';
import { isLikmsNsmSourceEnabled } from '../../utils/crawler-activation.utils';

interface CrawlerSourcePresentation {
  id: 'pal' | 'nsm';
  name: string;
  source: string;
  url: string;
  description: string;
  schedule: {
    id: string;
    name: string;
    expression: string;
    description: string;
  };
}

/** Resolve runtime source selection once for each response, never at module load. */
export function resolveRuntimeCrawlerSources() {
  const pal: CrawlerSourcePresentation = {
    id: 'pal',
    name: '국회 입법예고 크롤러',
    source: 'pal.assembly.go.kr',
    url: 'https://pal.assembly.go.kr',
    description: '국회에서 발의된 법률안과 입법예고 정보를 수집합니다.',
    schedule: {
      id: 'pal-crawl',
      name: '국회 입법예고 수집',
      expression: APP_CONSTANTS.CRON.EXPRESSIONS.CRAWLING_CHECK,
      description:
        '국회 입법예고 게시판을 주기적으로 확인하여 신규·변경 의안을 감지합니다.',
    },
  };
  const nsm: CrawlerSourcePresentation & { transferFlowDescription: string } =
    isLikmsNsmSourceEnabled()
      ? {
          id: 'nsm',
          name: '국회 의안정보시스템 계류의안 크롤러',
          source: 'likms.assembly.go.kr',
          url: 'https://likms.assembly.go.kr',
          description: '국회 의안정보시스템의 계류의안 목록을 수집합니다.',
          schedule: {
            id: 'nsm-pending',
            name: '국회 의안정보시스템 계류의안 수집',
            expression: APP_CONSTANTS.CRON.EXPRESSIONS.PENDING_CRAWLING_CHECK,
            description:
              '국회 의안정보시스템의 계류의안 목록을 주기적으로 수집합니다.',
          },
          transferFlowDescription:
            '국회 의안정보시스템의 계류의안이 국회입법현황으로 이관되면, 크롤러가 이를 자동으로 감지하여 동기화합니다.',
        }
      : {
          id: 'nsm',
          name: '국민참여입법센터 입법진행현황 크롤러',
          source: 'opinion.lawmaking.go.kr',
          url: 'https://opinion.lawmaking.go.kr',
          description:
            '국민참여입법센터의 입법진행현황(국회입법현황)을 수집합니다.',
          schedule: {
            id: 'nsm-pending',
            name: '국민참여입법센터 입법진행현황 수집',
            expression: APP_CONSTANTS.CRON.EXPRESSIONS.PENDING_CRAWLING_CHECK,
            description:
              '국민참여입법센터의 입법진행현황(국회입법현황)을 주기적으로 수집합니다.',
          },
          transferFlowDescription:
            '국민참여입법센터의 입법진행현황에서 국회입법현황으로 이관된 의안이 있으면, 크롤러가 이를 자동으로 감지하여 동기화합니다.',
        };
  return { pal, nsm };
}
