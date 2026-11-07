import { describe, expect, it } from '@jest/globals';
import {
  legalLookupPrefix,
  parseNoticeNumber,
  selectLegalIdentities,
} from './legal-search-identity.util';

describe('legal search identities', () => {
  const titles = [
    { noticeNum: 10, subject: '상가건물 임대차보호법 일부개정법률안' },
    {
      noticeNum: 9,
      subject: '주택임대차보호법 일부개정법률안(홍길동의원 등 10인)',
    },
    { noticeNum: 8, subject: '형법 일부개정법률안' },
    { noticeNum: 7, subject: '집회 및 시위에 관한 법률 일부개정법률안' },
    { noticeNum: 6, subject: '주택임대차보호법 전부개정법률안' },
    { noticeNum: 5, subject: '농작업재해 예방에 관한 법률안' },
  ];

  it('parses a complete assembly identifier without swallowing article numbers', () => {
    expect(parseNoticeNumber('의안번호: 2222564')).toBe(2222564);
    expect(parseNoticeNumber('2222564')).toBe(2222564);
    expect(parseNoticeNumber('제10조')).toBeUndefined();
    expect(parseNoticeNumber('2222564 개정')).toBeUndefined();
    expect(legalLookupPrefix('제10조')).toBeUndefined();
    expect(legalLookupPrefix('KIC')).toBeUndefined();
  });

  it('matches full law names and keeps notice order and cap', () => {
    expect(selectLegalIdentities('주택 임대차 보호법', titles, 1)).toEqual({
      noticeNums: [9],
    });
    expect(selectLegalIdentities('형법', titles, 100)).toEqual({
      noticeNums: [8],
    });
    expect(selectLegalIdentities('집회및시위에관한법률', titles, 100)).toEqual({
      noticeNums: [7],
    });
    expect(
      selectLegalIdentities('농작업재해 예방에 관한 법률', titles, 100),
    ).toEqual({ noticeNums: [5] });
    expect(selectLegalIdentities('임대차보호법', titles, 100)).toEqual({
      noticeNums: [],
    });
  });

  it('suggests a unique one-jamo replacement and abstains on ambiguity', () => {
    expect(selectLegalIdentities('주택임대차보호볍', titles, 100)).toEqual({
      noticeNums: [],
      suggestedQuery: '주택임대차보호법',
    });
    expect(
      selectLegalIdentities(
        '도로구통법',
        [
          { noticeNum: 1, subject: '도로교통법 일부개정법률안' },
          { noticeNum: 2, subject: '도로고통법 일부개정법률안' },
        ],
        100,
      ),
    ).toEqual({ noticeNums: [] });
  });
});
