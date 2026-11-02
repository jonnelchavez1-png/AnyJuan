// Password rules for staff accounts (checked on the screen; Supabase enforces its own minimum as well).
const COMMON = ['password', 'passw0rd', 'qwertyui', 'qwerty123', '12345678', '123456789', '1234567890', 'iloveyou', 'letmein1', 'welcome1', 'abc12345', '11111111', '00000000'];

/** Returns a message saying what is wrong, or null when the password is acceptable. */
export function checkPassword(password, email = '') {
  const p = String(password || '');
  if (p.length < 8) return 'Use at least 8 characters.';
  if (/^\d+$/.test(p)) return 'Do not use only numbers. Add letters.';
  if (new Set(p).size < 4) return 'That password is too repetitive. Mix different characters.';
  if (COMMON.includes(p.toLowerCase())) return 'That password is too common. Choose a different one.';
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && p.toLowerCase().includes(local)) return 'Do not put your email name inside the password.';
  return null;
}
