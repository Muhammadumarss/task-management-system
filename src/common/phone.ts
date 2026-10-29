import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js';
import { config } from '../config';

/** Returns the E.164 form, or null when the number is not valid. */
export function normalizePhone(input: string): string | null {
  const parsed = parsePhoneNumberFromString(input, config.DEFAULT_PHONE_COUNTRY as CountryCode);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}
