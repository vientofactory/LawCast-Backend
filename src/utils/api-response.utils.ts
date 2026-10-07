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
  private static isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  /**
   * Creates a success response.
   */
  static success<T>(data?: T, message?: string): ApiResponse<T> {
    return {
      success: true,
      ...(message && { message }),
      ...(data !== undefined && { data }),
    };
  }

  /**
   * Creates a webhook registration success response (with test outcome).
   */
  static webhookSuccess(testResult: {
    success: boolean;
    error?: Error | null;
  }): ApiResponse {
    const message = testResult.success
      ? '웹훅이 성공적으로 등록되고 테스트되었습니다'
      : '웹훅은 등록되었지만 테스트에 실패했습니다 (일시적 오류)';

    const normalizedTestResult = {
      success: testResult.success,
      error: testResult.error?.message || null,
    };

    return {
      success: true,
      message,
      data: {
        success: true,
        message,
        testResult: normalizedTestResult,
      },
      // Backward compatibility for clients that read testResult from top level
      testResult: normalizedTestResult,
    };
  }

  /**
   * Creates an error response.
   */
  static error(message: string, details?: string): ApiResponse {
    return {
      success: false,
      message,
      ...(details && { details }),
    };
  }

  /**
   * Rethrows known HTTP exceptions; any other error becomes an internal
   * server error response.
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

    const isProduction = this.isProduction();

    throw new HttpException(
      {
        success: false,
        message: `${context} 중 오류가 발생했습니다.`,
        error: isProduction
          ? '내부 서버 오류'
          : error instanceof Error
            ? error.message
            : '알 수 없는 오류',
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * Creates the proof-of-work verification failure exception.
   */
  static createPoWFailedException(): BadRequestException {
    return new BadRequestException({
      success: false,
      message: '작업증명 검증에 실패했습니다. 잠시 후 다시 시도해주세요.',
    });
  }

  /**
   * Creates the duplicate webhook registration exception.
   */
  static createDuplicateWebhookException(): BadRequestException {
    return new BadRequestException({
      success: false,
      message: '이미 등록된 웹훅 URL입니다.',
    });
  }

  /**
   * Creates the webhook limit exceeded exception.
   */
  static createWebhookLimitExceededException(): BadRequestException {
    return new BadRequestException({
      success: false,
      message: '최대 100개의 웹훅만 등록할 수 있습니다.',
    });
  }

  /**
   * Creates the webhook test failure exception.
   */
  static createWebhookTestFailedException(
    errorMessage?: string,
    errorType?: string,
  ): BadRequestException {
    const baseMessage = '웹훅 테스트에 실패했습니다.';
    let detailedMessage = baseMessage;

    if (errorType === 'INVALID_WEBHOOK') {
      detailedMessage = '유효하지 않은 Discord 웹훅 URL입니다.';
    } else if (errorType === 'UNAUTHORIZED') {
      detailedMessage = '웹훅에 대한 권한이 없습니다.';
    } else if (errorType === 'NOT_FOUND') {
      detailedMessage =
        '웹훅을 찾을 수 없습니다. 삭제되었거나 잘못된 URL입니다.';
    } else if (errorType === 'FORBIDDEN') {
      detailedMessage = '웹훅 사용이 차단되었습니다.';
    } else if (errorType === 'RATE_LIMITED') {
      detailedMessage = '요청이 제한되었습니다. 잠시 후 다시 시도해주세요.';
    } else if (errorType === 'NETWORK_ERROR') {
      detailedMessage = '네트워크 오류가 발생했습니다. 연결을 확인해주세요.';
    }

    const details = this.isProduction() ? undefined : errorMessage;

    return new BadRequestException({
      success: false,
      message: detailedMessage,
      details,
    });
  }
}
