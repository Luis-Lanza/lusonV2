export function validPassword(value: string): boolean {
  const bytes = new TextEncoder().encode(value).length;
  return value.isWellFormed() && !value.includes('\0') && bytes >= 12 && bytes <= 128;
}
export function generateTemporaryPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[byte & 63]).join('');
}
