import { HttpException, HttpStatus, BadRequestException } from '@nestjs/common';

export enum ErrorContext {
  WEBHOOK_REGISTRATION = '웹훅 등록',
  WEBHOOK_TEST = '웹훅 테스트',
  CRAWLING = '크롤링',
  NOTIFICATION = '알림',
  CACHE = '캐시',
  DATABASE = '데이터베이스',
  DEFAULT = '작업',
}

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
  details?: string;
  errors?: string[];
  testResult?: {
    success: boolean;
    error: string | null;
  };
}

export class ApiResponseUtils {
  /**
   * 성공 응답을 생성합니다.
   */
  static success<T>(data?: T, message?: string): ApiResponse<T> {
    return {
      success: true,
      ...(message && { message }),
      ...(data !== undefined && { data }),
    };
  }

  /**
   * 웹훅 등록 성공 응답을 생성합니다.
   */
  static webhookSuccess(testResult: {
    success: boolean;
    error?: Error | null;
  }): ApiResponse {
    return {
      success: true,
      message: testResult.success
        ? '웹훅이 성공적으로 등록되고 테스트되었습니다'
        : '웹훅은 등록되었지만 테스트에 실패했습니다 (일시적 오류)',
      testResult: {
        success: testResult.success,
        error: testResult.error?.message || null,
      },
    };
  }

  /**
   * 에러 응답을 생성합니다.
   */
  static error(message: string, details?: string): ApiResponse {
    return {
      success: false,
      message,
      ...(details && { details }),
    };
  }

  /**
   * 알려진 예외를 다시 던집니다. 알려지지 않은 예외는 내부 서버 오류로 처리합니다.
   */
  static handleError(
    error: unknown,
    context: ErrorContext = ErrorContext.DEFAULT,
  ): never {
    if (
      error instanceof BadRequestException ||
      error instanceof HttpException
    ) {
      throw error;
    }

    throw new HttpException(
      {
        success: false,
        message: `${context} 중 오류가 발생했습니다.`,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * reCAPTCHA 검증 실패 예외를 생성합니다.
   */
  static createRecaptchaFailedException(): BadRequestException {
    return new BadRequestException({
      success: false,
      message: 'reCAPTCHA 인증에 실패했습니다. 다시 시도해주세요.',
    });
  }

  /**
   * 웹훅 테스트 실패 예외를 생성합니다.
   */
  static createWebhookTestFailedException(
    errorMessage?: string,
  ): BadRequestException {
    return new BadRequestException({
      success: false,
      message: '웹훅 테스트에 실패했습니다. URL을 확인해주세요.',
      details: errorMessage,
    });
  }
}
