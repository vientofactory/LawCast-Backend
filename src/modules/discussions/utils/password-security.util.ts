import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export class PasswordSecurityUtil {
  private static readonly KEY_LENGTH = 64;

  /**
   * Hashes a plain password using a newly generated random salt.
   */
  static hashPassword(password: string): { hash: string; salt: string } {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = scryptSync(password, salt, this.KEY_LENGTH);
    return {
      hash: derivedKey.toString('hex'),
      salt,
    };
  }

  /**
   * Verifies if the provided plain password matches the stored hash and salt.
   */
  static verifyPassword(password: string, salt: string, hash: string): boolean {
    try {
      const derivedKey = scryptSync(password, salt, this.KEY_LENGTH);
      const storedHashBuffer = Buffer.from(hash, 'hex');
      if (derivedKey.length !== storedHashBuffer.length) {
        return false;
      }
      return timingSafeEqual(derivedKey, storedHashBuffer);
    } catch {
      return false;
    }
  }
}
