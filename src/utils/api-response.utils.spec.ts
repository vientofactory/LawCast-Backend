import { HttpException, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiResponseUtils } from '../utils/api-response.utils';

describe('ApiResponseUtils', () => {
  describe('success', () => {
    it('should create success response without data and message', () => {
      const result = ApiResponseUtils.success();

      expect(result).toEqual({
        success: true,
      });
    });

    it('should create success response with data only', () => {
      const data = { id: 1, name: 'test' };
      const result = ApiResponseUtils.success(data);

      expect(result).toEqual({
        success: true,
        data,
      });
    });

    it('should create success response with data and message', () => {
      const data = { id: 1, name: 'test' };
      const message = 'Operation successful';
      const result = ApiResponseUtils.success(data, message);

      expect(result).toEqual({
        success: true,
        message,
        data,
      });
    });

    it('should handle undefined data', () => {
      const result = ApiResponseUtils.success(undefined, 'Success');

      expect(result).toEqual({
        success: true,
        message: 'Success',
      });
    });
  });

  describe('webhookSuccess', () => {
    it('should create response for successful webhook test result', () => {
      const testResult = { success: true, error: null };
      const result = ApiResponseUtils.webhookSuccess(testResult);

      expect(result).toEqual({
        success: true,
        message: '웹훅이 성공적으로 등록되고 테스트되었습니다',
        testResult: {
          success: true,
          error: null,
        },
      });
    });

    it('should create response for failed webhook test result', () => {
      const testResult = {
        success: false,
        error: new Error('Connection failed'),
      };
      const result = ApiResponseUtils.webhookSuccess(testResult);

      expect(result).toEqual({
        success: true,
        message: '웹훅은 등록되었지만 테스트에 실패했습니다 (일시적 오류)',
        testResult: {
          success: false,
          error: 'Connection failed',
        },
      });
    });

    it('should handle failed test result without error', () => {
      const testResult = { success: false };
      const result = ApiResponseUtils.webhookSuccess(testResult);

      expect(result).toEqual({
        success: true,
        message: '웹훅은 등록되었지만 테스트에 실패했습니다 (일시적 오류)',
        testResult: {
          success: false,
          error: null,
        },
      });
    });
  });

  describe('error', () => {
    it('should create error response with message only', () => {
      const message = 'Something went wrong';
      const result = ApiResponseUtils.error(message);

      expect(result).toEqual({
        success: false,
        message,
      });
    });

    it('should create error response with message and details', () => {
      const message = 'Something went wrong';
      const details = 'Detailed error information';
      const result = ApiResponseUtils.error(message, details);

      expect(result).toEqual({
        success: false,
        message,
        details,
      });
    });
  });

  describe('handleError', () => {
    it('should rethrow BadRequestException', () => {
      const exception = new BadRequestException('Bad request');

      expect(() => {
        ApiResponseUtils.handleError(exception, 'Test');
      }).toThrow(BadRequestException);
    });

    it('should rethrow HttpException', () => {
      const exception = new HttpException(
        'Server error',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

      expect(() => {
        ApiResponseUtils.handleError(exception, 'Test');
      }).toThrow(HttpException);
    });

    it('should wrap unknown Error as HttpException', () => {
      const error = new Error('Unknown error');

      expect(() => {
        ApiResponseUtils.handleError(error, 'Test');
      }).toThrow(HttpException);

      try {
        ApiResponseUtils.handleError(error, 'Test');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
        expect((e as HttpException).getResponse()).toMatchObject({
          success: false,
          message: 'Test 중 오류가 발생했습니다.',
          error: 'Unknown error',
        });
      }
    });

    it('should wrap unknown object as HttpException', () => {
      const error = { unknown: 'error' };

      try {
        ApiResponseUtils.handleError(error, 'Test');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getResponse()).toMatchObject({
          success: false,
          message: 'Test 중 오류가 발생했습니다.',
          error: '알 수 없는 오류',
        });
      }
    });

    it('should use default context', () => {
      const error = new Error('Test error');

      try {
        ApiResponseUtils.handleError(error);
      } catch (e) {
        expect((e as HttpException).getResponse()).toMatchObject({
          message: '작업 중 오류가 발생했습니다.',
        });
      }
    });
  });

  describe('createRecaptchaFailedException', () => {
    it('should create reCAPTCHA failure exception', () => {
      const exception = ApiResponseUtils.createRecaptchaFailedException();

      expect(exception).toBeInstanceOf(BadRequestException);
      expect(exception.getResponse()).toEqual({
        success: false,
        message: 'reCAPTCHA 인증에 실패했습니다. 다시 시도해주세요.',
      });
    });
  });

  describe('createWebhookTestFailedException', () => {
    it('should create webhook test failure exception without error message', () => {
      const exception = ApiResponseUtils.createWebhookTestFailedException();

      expect(exception).toBeInstanceOf(BadRequestException);
      expect(exception.getResponse()).toEqual({
        success: false,
        message: '웹훅 테스트에 실패했습니다. URL을 확인해주세요.',
      });
    });

    it('should create webhook test failure exception with error message', () => {
      const errorMessage = 'Connection timeout';
      const exception =
        ApiResponseUtils.createWebhookTestFailedException(errorMessage);

      expect(exception).toBeInstanceOf(BadRequestException);
      expect(exception.getResponse()).toEqual({
        success: false,
        message: '웹훅 테스트에 실패했습니다. URL을 확인해주세요.',
        details: errorMessage,
      });
    });
  });
});
