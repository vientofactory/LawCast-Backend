import { Logger } from '@nestjs/common';

/**
 * 환경별 로거 유틸리티
 */
export class LoggerUtils {
  private static readonly isDevelopment =
    process.env.NODE_ENV === 'development';
  private static readonly isProduction = process.env.NODE_ENV === 'production';
  private static readonly loggers = new Map<string, Logger>();

  /**
   * 컨텍스트별 로거 인스턴스를 가져오거나 생성합니다.
   */
  private static getLogger(context: string): Logger {
    if (!this.loggers.has(context)) {
      this.loggers.set(context, new Logger(context));
    }
    return this.loggers.get(context)!;
  }

  /**
   * 개발 환경에서만 디버그 로그를 출력합니다.
   */
  static debugDev(
    context: string,
    message?: any,
    ...optionalParams: any[]
  ): void {
    if (this.isDevelopment) {
      const logger = this.getLogger(context);
      logger.debug(message, ...optionalParams);
    }
  }

  /**
   * 개발 환경에서만 일반 로그를 출력합니다.
   */
  static logDev(
    context: string,
    message?: any,
    ...optionalParams: any[]
  ): void {
    if (this.isDevelopment) {
      const logger = this.getLogger(context);
      logger.log(message, ...optionalParams);
    }
  }

  /**
   * 모든 환경에서 일반 로그를 출력합니다.
   */
  static log(context: string, message?: any, ...optionalParams: any[]): void {
    const logger = this.getLogger(context);
    logger.log(message, ...optionalParams);
  }

  /**
   * 프로덕션과 개발 환경에서 다른 메시지를 출력합니다.
   */
  static logConditional(
    context: string,
    productionMessage: any,
    developmentMessage?: any,
    ...optionalParams: any[]
  ): void {
    const logger = this.getLogger(context);
    if (this.isProduction) {
      logger.log(productionMessage, ...optionalParams);
    } else if (this.isDevelopment && developmentMessage !== undefined) {
      logger.log(developmentMessage, ...optionalParams);
    } else {
      logger.log(productionMessage, ...optionalParams);
    }
  }

  /**
   * 환경에 관계없이 경고 로그를 출력합니다.
   */
  static warn(context: string, message?: any, ...optionalParams: any[]): void {
    const logger = this.getLogger(context);
    logger.warn(message, ...optionalParams);
  }

  /**
   * 환경에 관계없이 에러 로그를 출력합니다.
   */
  static error(context: string, message?: any, ...optionalParams: any[]): void {
    const logger = this.getLogger(context);
    logger.error(message, ...optionalParams);
  }

  /**
   * 환경에 관계없이 상세(verbose) 로그를 출력합니다.
   */
  static verbose(
    context: string,
    message?: any,
    ...optionalParams: any[]
  ): void {
    const logger = this.getLogger(context);
    logger.verbose(message, ...optionalParams);
  }

  /**
   * 환경에 관계없이 디버그 로그를 출력합니다.
   */
  static debug(context: string, message?: any, ...optionalParams: any[]): void {
    const logger = this.getLogger(context);
    logger.debug(message, ...optionalParams);
  }

  /**
   * 현재 환경이 개발 환경인지 확인합니다.
   */
  static get isDev(): boolean {
    return this.isDevelopment;
  }

  /**
   * 현재 환경이 프로덕션 환경인지 확인합니다.
   */
  static get isProd(): boolean {
    return this.isProduction;
  }

  /**
   * 특정 컨텍스트의 로거를 직접 반환합니다.
   */
  static getContextLogger(context: string): Logger {
    return this.getLogger(context);
  }
}
