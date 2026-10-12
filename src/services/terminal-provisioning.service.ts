import { enqueueRoute, enqueueBroadcast, type BroadcastResult } from "../utils/bridge.js";
import { buildDeltaCommand } from "../utils/parser.js";
import logger from "../config/logger.js";

// Terminal firmware lists: WL student cards, BL blacklisted cards,
// DR driver cards (+ PIN), AD admin cards (+ PIN). There is no AGENT list.
export type TerminalList = "WL" | "BL" | "DR" | "AD";

export interface ProvisionCredentialParams {
  cardUid: string;
  pin: string;
  list: "DR" | "AD";
  originTerminalId?: string | null;
}

type Result = { success: boolean; broadcastResult?: BroadcastResult };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Origin terminal first (fast path), then the fleet so every terminal converges.
// success is false if the broadcast failed or any terminal could be neither reached nor queued.
// `logCommand` is what gets logged: commands with a PIN must never be logged as-is.
async function deliver(command: string, logCommand: string, originTerminalId?: string | null): Promise<Result> {
  if (originTerminalId) {
    await enqueueRoute(originTerminalId, command).catch((err) =>
      logger.warn(
        { originTerminalId, command: logCommand, err: errMsg(err) },
        "terminal_provisioning.origin_route_failed — continuing with broadcast"
      )
    );
  }

  try {
    const broadcastResult = await enqueueBroadcast(command);
    const failed = broadcastResult.failedTerminals ?? [];
    if (failed.length > 0) {
      logger.warn({ command: logCommand, failedTerminals: failed }, "terminal_provisioning.broadcast_partial");
    }
    return { success: failed.length === 0, broadcastResult };
  } catch (err) {
    logger.warn({ command: logCommand, err: errMsg(err) }, "terminal_provisioning.broadcast_failed");
    return { success: false };
  }
}

export const terminalProvisioningService = {
  // DR/AD entries need the card UID and PIN in one command; call only once both are known.
  async provisionCredential({ cardUid, pin, list, originTerminalId }: ProvisionCredentialParams): Promise<Result> {
    const command = buildDeltaCommand("ADD", list, cardUid, pin);
    return deliver(command, `ADD:${list},${cardUid},****`, originTerminalId);
  },

  // Which list to clear depends on the card owner's role (resolved by the caller).
  async deprovisionCard(cardUid: string, list: TerminalList): Promise<Result> {
    const command = buildDeltaCommand("REM", list, cardUid);
    return deliver(command, command);
  },
};