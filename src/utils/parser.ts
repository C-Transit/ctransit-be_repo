// Builds downlink commands for terminals. Fields are comma-separated, so a separator or
// line break inside any field would inject extra fields or commands: reject them.
const FORBIDDEN = /[,|\r\n]/;

export function buildDeltaCommand(action: string, target: string, uid: string, extra: string | null = null): string {
  for (const part of [action, target, uid, extra]) {
    if (part && FORBIDDEN.test(part)) throw new Error("INVALID_COMMAND_FIELD");
  }
  const base = `${action}:${target},${uid}`;
  return extra ? `${base},${extra}` : base;
}

// Splits UIDs into `prefix + uid|uid|...` chunks of at most maxBytes each.
export function buildChunks(prefix: string, uids: string[], maxBytes: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = prefix.length;

  for (const uid of uids) {
    const added = current.length === 0 ? uid.length : uid.length + 1;
    if (size + added > maxBytes && current.length > 0) {
      chunks.push(prefix + current.join("|"));
      current = [];
      size = prefix.length;
    }
    size += current.length === 0 ? uid.length : uid.length + 1;
    current.push(uid);
  }

  if (current.length > 0) chunks.push(prefix + current.join("|"));
  return chunks;
}