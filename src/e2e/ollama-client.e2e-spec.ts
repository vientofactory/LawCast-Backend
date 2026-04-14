import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ConfigModule } from '@nestjs/config';
import appConfig from '../config/app.config';
import { OllamaModule } from '../modules/ollama/ollama.module';
import { OllamaClientService } from '../modules/ollama/ollama-client.service';

const runOllamaE2E = process.env.RUN_OLLAMA_E2E === 'true';
const itIfOllama = runOllamaE2E ? it : it.skip;

describe('OllamaClientService (e2e)', () => {
  let moduleRef: TestingModule;
  let service: OllamaClientService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig],
          envFilePath: [
            '.env',
            '.env.local',
            '.env.development',
            '.env.production',
          ],
        }),
        OllamaModule,
      ],
    }).compile();

    service = moduleRef.get<OllamaClientService>(OllamaClientService);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  itIfOllama(
    'should summarize full legislative proposal with real Ollama API',
    async () => {
      const content = {
        title: '[2218288] 조세특례제한법 일부개정법률안(윤한홍의원 등 10인)',
        proposalReason:
          '소형모듈원자로(SMR)는 글로벌 에너지 전환과 미래 전력수요 증가에 대응할 핵심 저탄소 기술로 부상하고 있고, 우리나라는 「소형모듈원자로 개발 촉진 및 지원에 관한 특별법」 제정 등 연구개발, 실증, 특구 조성 등 제도적 기반을 마련하여 국가 차원의 전략적 육성을 추진 중임. 그러나 소형모듈원자로 산업의 상용화와 수출 경쟁력 확보를 위해 필수적인 제조 공급망의 설비투자와 전문기술 확보를 뒷받침할 세제 지원 체계는 아직 충분히 구축되지 못한 상황임. 현재 소형모듈원자로 관련 핵심 기술은 국가전략기술로 규정되어 있지 않아, 시설투자 및 연구ㆍ인력개발에 적용되는 세액공제율이 중소ㆍ중견기업의 선제적 투자 결정을 이끌기에는 제한적이고, 특히 소형모듈원자로 산업은 높은 초기 설비투자와 국제적 인증 충족이 필수임에도 수주가 확정되기 전까지 기업이 자체적으로 감당해야 하는 위험이 크기 때문에 공급망 내 기업들의 투자가 지연되는 구조적 문제가 지속되고 있음. 이에 국가전략기술의 범위에 소형모듈원자로를 추가해 세액공제율을 실질적으로 확대함으로써 수요 불확실성 하에서도 설비 확충ㆍ기술 고도화ㆍ전문인력 확보가 가능한 환경을 조성하여 글로벌 시장에서의 경쟁력을 강화하는 한편, 국가전략기술의 사업화시설 투자비용에 대한 세액공제의 일몰기한을 삭제하려는 것임(안 제10조제1항제2호 및 제24조제1항제2호).',
      };

      const summary = await service.summarizeProposal(
        content.title,
        content.proposalReason,
      );

      console.debug('[INPUT]', content);
      console.debug('[OUTPUT]', summary);

      expect(summary).toBeTruthy();
      expect(typeof summary).toBe('string');
      expect(summary!.length).toBeGreaterThanOrEqual(20);
      expect(summary!.length).toBeLessThanOrEqual(1200);
    },
    30000,
  );
});
