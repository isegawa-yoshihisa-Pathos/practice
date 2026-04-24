export function avatarInitials(displayName: string, userId: string): string {
  const raw = (displayName || userId || '?').trim();
  if (!raw) {
    return '?';
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0].charAt(0);
    const b = parts[parts.length - 1].charAt(0);
    return (a + b).toUpperCase();
  }
  return raw.slice(0, 2).toUpperCase();
}

export function avatarFallbackHue(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}
