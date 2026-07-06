import { Logger } from '@nestjs/common';

export class LoggerUtils {
  private static readonly isDevelopment =
    process.env.NODE_ENV === 'development';
  private static readonly isProduction = process.env.NODE_ENV === 'production';
  private static readonly loggers = new Map<string, Logger>();

  private static getLogger(context: string): Logger {
    if (!this.loggers.has(context)) {
      this.loggers.set(context, new Logger(context));
    }
    return this.loggers.get(context)!;
  }

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

  static log(context: string, message?: any, ...optionalParams: any[]): void {
    const logger = this.getLogger(context);
    logger.log(message, ...optionalParams);
  }

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

  static warn(context: string, message?: any, ...optionalParams: any[]): void {
    const logger = this.getLogger(context);
    logger.warn(message, ...optionalParams);
  }

  static error(context: string, message?: any, ...optionalParams: any[]): void {
    const logger = this.getLogger(context);
    logger.error(message, ...optionalParams);
  }

  static verbose(
    context: string,
    message?: any,
    ...optionalParams: any[]
  ): void {
    const logger = this.getLogger(context);
    logger.verbose(message, ...optionalParams);
  }

  static debug(context: string, message?: any, ...optionalParams: any[]): void {
    const logger = this.getLogger(context);
    logger.debug(message, ...optionalParams);
  }

  static get isDev(): boolean {
    return this.isDevelopment;
  }

  static get isProd(): boolean {
    return this.isProduction;
  }

  static getContextLogger(context: string): Logger {
    return this.getLogger(context);
  }
}
