import {
  extractProposerName,
  extractProposerFromSubject,
} from './proposer.utils';

describe('proposer.utils', () => {
  describe('extractProposerName', () => {
    it('returns empty array for null, undefined, or empty string', () => {
      expect(extractProposerName(null)).toEqual([]);
      expect(extractProposerName(undefined)).toEqual([]);
      expect(extractProposerName('')).toEqual([]);
      expect(extractProposerName('   ')).toEqual([]);
    });

    it('extracts primary lawmaker name from "OOO의원 등 O인" format', () => {
      expect(extractProposerName('윤한홍의원 등 10인')).toEqual(['윤한홍']);
      expect(extractProposerName('윤한홍 의원 등 10인')).toEqual(['윤한홍']);
      expect(extractProposerName('윤한홍의원등 10인')).toEqual(['윤한홍']);
      expect(extractProposerName('윤한홍의원등10인')).toEqual(['윤한홍']);
      expect(extractProposerName('김철수 의원 등 1인')).toEqual(['김철수']);
    });

    it('extracts primary lawmaker name from "OOO의원 외 O인/명" format', () => {
      expect(extractProposerName('김철수 의원 외 12인')).toEqual(['김철수']);
      expect(extractProposerName('이영희의원 등 5명')).toEqual(['이영희']);
      expect(extractProposerName('박찬대 의원 외 10명')).toEqual(['박찬대']);
    });

    it('extracts multiple co-representative proposers from "OOO의원ㆍOOO의원 등 O인" format', () => {
      expect(extractProposerName('김용민의원ㆍ박은정의원 등 12인')).toEqual([
        '김용민',
        '박은정',
      ]);
      expect(extractProposerName('김용민의원ㆍ박은정의원 외 5인')).toEqual([
        '김용민',
        '박은정',
      ]);
      expect(
        extractProposerName('홍길동의원ㆍ김철수의원ㆍ이영희의원 등 20인'),
      ).toEqual(['홍길동', '김철수', '이영희']);
    });

    it('extracts lawmaker name from single lawmaker string "OOO의원"', () => {
      expect(extractProposerName('홍길동의원')).toEqual(['홍길동']);
      expect(extractProposerName('홍길동 의원')).toEqual(['홍길동']);
    });

    it('strips unnecessary prefixes such as "제안자목록" and "발의자:"', () => {
      expect(extractProposerName('제안자목록 윤한홍의원 등 10인')).toEqual([
        '윤한홍',
      ]);
      expect(extractProposerName('제안자: 홍길동 의원 등 10인')).toEqual([
        '홍길동',
      ]);
      expect(extractProposerName('발의자: 김철수의원')).toEqual(['김철수']);
    });

    it('handles non-lawmaker proposers like "정부", "법무부장관", "환경노동위원장"', () => {
      expect(extractProposerName('정부')).toEqual(['정부']);
      expect(extractProposerName('법무부장관')).toEqual(['법무부장관']);
      expect(extractProposerName('환경노동위원장')).toEqual(['환경노동위원장']);
      expect(extractProposerName('위원장')).toEqual(['위원장']);
      expect(extractProposerName('대통령')).toEqual(['대통령']);
    });
  });

  describe('extractProposerFromSubject', () => {
    it('returns empty array for null, undefined, or empty string', () => {
      expect(extractProposerFromSubject(null)).toEqual([]);
      expect(extractProposerFromSubject(undefined)).toEqual([]);
      expect(extractProposerFromSubject('')).toEqual([]);
    });

    it('extracts proposer name from subject with trailing parentheses', () => {
      expect(
        extractProposerFromSubject(
          '[2218288] 조세특례제한법 일부개정법률안(윤한홍의원 등 10인)',
        ),
      ).toEqual(['윤한홍']);
      expect(
        extractProposerFromSubject('상법 일부개정법률안 (김철수의원 외 5명)'),
      ).toEqual(['김철수']);
      expect(
        extractProposerFromSubject('지방세법 일부개정법률안(정부)'),
      ).toEqual(['정부']);
      expect(
        extractProposerFromSubject('환경보건법 일부개정법률안(환경노동위원장)'),
      ).toEqual(['환경노동위원장']);
    });

    it('extracts multiple co-representative proposers from subject', () => {
      expect(
        extractProposerFromSubject(
          '형사소송법 일부개정법률안(김용민의원ㆍ박은정의원 등 12인)',
        ),
      ).toEqual(['김용민', '박은정']);
    });

    it('extracts proposer name when subject has trailing (수정) tag', () => {
      expect(
        extractProposerFromSubject(
          '무결성 보존에 관한 법률안(김철수 의원 등 10인)(수정)',
        ),
      ).toEqual(['김철수']);
    });

    it('returns empty array if parentheses do not contain proposer information', () => {
      expect(
        extractProposerFromSubject('초·중등교육법 일부개정법률안'),
      ).toEqual([]);
    });
  });
});
