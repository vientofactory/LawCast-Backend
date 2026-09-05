import { PasswordSecurityUtil } from './password-security.util';

describe('PasswordSecurityUtil', () => {
  it('should hash a password and produce a random salt and 128-char hex hash', () => {
    const result = PasswordSecurityUtil.hashPassword('testPassword123!');
    expect(result.salt).toBeDefined();
    expect(result.salt.length).toBe(32); // 16 bytes = 32 hex chars
    expect(result.hash).toBeDefined();
    expect(result.hash.length).toBe(128); // 64 bytes = 128 hex chars
  });

  it('should verify correct password successfully', () => {
    const password = 'mySecretPassword456';
    const { hash, salt } = PasswordSecurityUtil.hashPassword(password);
    const isValid = PasswordSecurityUtil.verifyPassword(password, salt, hash);
    expect(isValid).toBe(true);
  });

  it('should fail verification for incorrect password', () => {
    const password = 'mySecretPassword456';
    const { hash, salt } = PasswordSecurityUtil.hashPassword(password);
    const isValid = PasswordSecurityUtil.verifyPassword(
      'wrongPassword',
      salt,
      hash,
    );
    expect(isValid).toBe(false);
  });
});
