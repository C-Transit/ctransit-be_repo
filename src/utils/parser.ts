"use strict";

// Utility type for strict error handling across all parsers
export type ParseResult<T> = 
  | { error: string; data?: undefined }
  | { data: T; error?: undefined };

export const PAYLOAD_TYPE = {
  TRANSACTION_BATCH: "TRANSACTION_BATCH",
  PENDING_LINK: "PENDING_LINK",
  SYS_FULL_SYNC: "SYS_FULL_SYNC",
  DRIVER_EVENT: "DRIVER_EVENT",
  DRIVER_REGISTER: "DRIVER_REGISTER",
  UNKNOWN: "UNKNOWN",
} as const;

export type PayloadType = typeof PAYLOAD_TYPE[keyof typeof PAYLOAD_TYPE];

export interface ParsedTransaction {
  transaction_id: string;
  terminal_id: string;
  student_uid: string;
  amount: number;
  driver_uid: string | null;
  synced_at: Date;
  location?: string | null;
  card_uid?: string | null;
  raw_amount?: string | null;
  timestamp?: number | null;
  tapped_at?: Date | null;
}

export interface TransactionBatchResult {
  valid: ParsedTransaction[];
  invalid: Array<{ line: string; reason: string }>;
}

export interface DriverEventData {
  action: "LOGIN" | "LOGOUT";
  driverUid: string;
}

export interface PendingLinkData {
  uid: string;
  otp: string;
  agent_uid: string;
}

export interface DriverRegisterData {
  firstname: string;
  lastname: string;
  matricNumber: string;
}

export function detectPayloadType(raw: string): PayloadType {
  const trimmed = raw.trim();
  if (trimmed.startsWith("PENDING_LINK:")) return PAYLOAD_TYPE.PENDING_LINK;
  if (trimmed === "SYS:REQ_FULL_SYNC") return PAYLOAD_TYPE.SYS_FULL_SYNC;
  if (trimmed.startsWith("DRV:REG,")) return PAYLOAD_TYPE.DRIVER_REGISTER;
  if (trimmed.startsWith("DRV:")) return PAYLOAD_TYPE.DRIVER_EVENT;
  
  if (
    trimmed.startsWith("SYS:") ||
    trimmed.startsWith("ACK:") ||
    trimmed.startsWith("ERR:") ||
    trimmed.startsWith("REG:")
  ) {
    return PAYLOAD_TYPE.UNKNOWN;
  }
  return PAYLOAD_TYPE.TRANSACTION_BATCH;
}

export function parseDriverEvent(raw: string): ParseResult<DriverEventData> {
  const body = raw.replace("DRV:", "").trim();
  const parts = body.split(",").map((p) => p.trim());

  if (parts.length !== 2) {
    return { error: `DRV event expects 2 fields, got ${parts.length}` };
  }

  const [action, driverUid] = parts;

  if (action !== "LOGIN" && action !== "LOGOUT") {
    return {
      error: `Unknown DRV action: "${action}". Expected LOGIN or LOGOUT`,
    };
  }

  if (!driverUid || driverUid.length === 0) {
    return { error: "driver_uid is empty" };
  }

  return { data: { action, driverUid } };
}

export function parseTransactionBatch(raw: string, terminalId: string): TransactionBatchResult {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const valid: ParsedTransaction[] = [];
  const invalid: Array<{ line: string; reason: string }> = [];

  for (const line of lines) {
    // Split by pipes to handle multiple transactions on a single line
    const transactions = line.split("|").map((t) => t.trim()).filter((t) => t.length > 0);

    for (const transaction of transactions) {
      const parsed = parseSingleTransaction(transaction, terminalId);
      if (parsed.error) {
        invalid.push({ line: transaction, reason: parsed.error });
      } else if (parsed.data) {
        valid.push(parsed.data);
      }
    }
  }

  return { valid, invalid };
}

export function parseSingleTransaction(line: string, terminalId: string): ParseResult<ParsedTransaction> {
  let transaction_id: string | undefined;
  let student_uid: string | undefined;
  let amountRaw: string | undefined;
  let timestampRaw: string | undefined;
  let driver_uid: string | undefined;
  let location: string | undefined;
  let effectiveTerminalId = terminalId;

  if (line.includes(":") && !line.startsWith("PENDING_LINK")) {
    const colonIdx = line.indexOf(":");
    const prefix = line.slice(0, colonIdx).trim();
    if (prefix && (!terminalId || terminalId === "UNKNOWN")) {
      effectiveTerminalId = prefix;
    }

    const rest = line.slice(colonIdx + 1); 
    const parts = rest.split(",").map((p) => p.trim());

    if (parts.length < 3 || parts.length > 5) {
      return {
        error: `Format B expects 3-5 fields after colon, got ${parts.length}`,
      };
    }

    if (parts.length === 5) {
      [student_uid, amountRaw, timestampRaw, driver_uid, location] = parts;
    } else if (parts.length === 4) {
      [student_uid, amountRaw, timestampRaw, driver_uid] = parts;
    } else {
      [student_uid, amountRaw, timestampRaw] = parts;
    }

    if (!timestampRaw) return { error: "Missing timestamp field" };
    const ts = parseInt(timestampRaw, 10);
    transaction_id = `${effectiveTerminalId || terminalId}-${ts}-${Math.random()
      .toString(36)
      .slice(2, 7)
      .toUpperCase()}`;
  } else {
    const parts = line.split(",").map((p) => p.trim());

    if (parts.length >= 3 && parts.length <= 4) {
      // Format B: student_uid, amount, timestamp, [driver_uid]
      [student_uid, amountRaw, timestampRaw, driver_uid] = parts;

      if (!timestampRaw) return { error: "Missing timestamp field" };
      const ts = parseInt(timestampRaw, 10);
      transaction_id = `${terminalId}-${ts}-${Math.random()
        .toString(36)
        .slice(2, 7)
        .toUpperCase()}`;
    } else if (parts.length === 5) {
      // Distinguish Format A (tx_id, student, amount, ts, driver) vs Format B with location (student, amount, ts, driver, location)
      const p1Num = parseFloat(parts[1]);
      const p2Num = parseInt(parts[2], 10);
      const isFormatBLocation = !isNaN(p1Num) && !isNaN(p2Num) && p2Num > 100000000;

      if (isFormatBLocation) {
        [student_uid, amountRaw, timestampRaw, driver_uid, location] = parts;
        if (!timestampRaw) return { error: "Missing timestamp field" };
        const ts = parseInt(timestampRaw, 10);
        transaction_id = `${terminalId}-${ts}-${Math.random()
          .toString(36)
          .slice(2, 7)
          .toUpperCase()}`;
      } else {
        // Format A: transaction_id, student_uid, amount, timestamp, driver_uid
        [transaction_id, student_uid, amountRaw, timestampRaw, driver_uid] = parts;
      }
    } else if (parts.length === 6) {
      // Format A with location: transaction_id, student_uid, amount, timestamp, driver_uid, location
      [transaction_id, student_uid, amountRaw, timestampRaw, driver_uid, location] = parts;
    } else {
      return { error: `Expected 3-6 CSV fields, got ${parts.length}` };
    }
  }

  // Validate transaction_id
  if (!transaction_id || transaction_id.length === 0) {
    return { error: "transaction_id is empty" };
  }

  // Validate student_uid
  if (!student_uid || student_uid.length === 0) {
    return { error: "student_uid is empty" };
  }

  // Validate amount
  if (!amountRaw) return { error: "amount is missing" };
  const parsedAmount = parseFloat(amountRaw);
  if (isNaN(parsedAmount) || parsedAmount === 0) {
    return { error: `Invalid amount: "${amountRaw}"` };
  }
  const amount = Math.abs(parsedAmount);

  // Validate timestamp
  if (!timestampRaw) return { error: "timestamp is missing" };
  const epochSeconds = parseInt(timestampRaw, 10);
  if (isNaN(epochSeconds) || epochSeconds <= 0) {
    return { error: `Invalid timestamp: "${timestampRaw}"` };
  }
  const tapped_at = new Date(epochSeconds * 1000);
  const synced_at = new Date();

  return {
    data: {
      transaction_id,
      terminal_id: effectiveTerminalId || terminalId,
      student_uid,
      amount,
      driver_uid: driver_uid || null,
      synced_at,
      location: location || null,
      card_uid: student_uid,
      raw_amount: amountRaw,
      timestamp: epochSeconds,
      tapped_at,
    },
  };
}

export function parsePendingLink(raw: string): ParseResult<PendingLinkData> {
  const body = raw.replace("PENDING_LINK:", "").trim();
  const parts = body.split(",");

  if (parts.length !== 3) {
    return {
      error: `PENDING_LINK expects 3 fields after prefix, got ${parts.length}`,
    };
  }

  const [uid, otp, agent_uid] = parts.map((p) => p.trim());

  if (!uid || uid.length === 0)
    return { error: "UID is empty in PENDING_LINK" };
  if (!otp || !/^\d{6}$/.test(otp))
    return { error: `OTP must be 6 digits, got "${otp}"` };
  if (!agent_uid || agent_uid.length === 0)
    return { error: "agent_uid is empty in PENDING_LINK" };

  return { data: { uid, otp, agent_uid } };
}

export function parseDriverRegister(raw: string): ParseResult<DriverRegisterData> {
  const body = raw.replace("DRV:REG,", "").trim();
  const parts = body.split(",").map((p) => p.trim());

  if (parts.length !== 3) {
    return {
      error: `DRV:REG expects 3 fields (firstname,lastname,matricNumber), got ${parts.length}`,
    };
  }

  const [firstname, lastname, matricNumber] = parts;

  if (!firstname) return { error: "firstname is empty" };
  if (!lastname) return { error: "lastname is empty" };
  if (!matricNumber) return { error: "matricNumber is empty" };

  return { data: { firstname, lastname, matricNumber } };
}

export function buildDeltaCommand(action: string, target: string, uid: string, extra: string | null = null): string {
  const base = `${action}:${target},${uid}`;
  return extra ? `${base},${extra}` : base;
}