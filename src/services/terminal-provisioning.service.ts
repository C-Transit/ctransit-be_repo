// src/services/terminal-provisioning.service.ts
//
// Hardware-facing provisioning service for C-Transit terminals.
//
// Terminal firmware maintains four independent lists, confirmed against the
// firmware command reference (2026-09-28):
//   WL  — student payment cards            ADD:WL,{uid}          REM:WL,{uid}
//   BL  — blacklisted (low-balance) cards   ADD:BL,{uid}          REM:BL,{uid}
//   DR  — driver cards (card + login PIN)   ADD:DR,{uid},{pin}    REM:DR,{uid}
//   AD  — admin cards (card + login PIN)    ADD:AD,{uid},{pin}    REM:AD,{uid}
//
// DR/AD entries require BOTH the card UID and the PIN in the same command —
// the firmware has no concept of a "card without a PIN yet" for those two
// lists, so we only ever call provisionCredential() once both pieces are
// known. There is no AGENT list; agents authenticate through the web/app
// portal, not by tapping a card at a terminal.

import {
  enqueueRoute,
  enqueueBroadcast,
  BroadcastResult,
} from "../utils/bridge.js";
import { buildDeltaCommand } from "../utils/parser.js";
import logger from "../config/logger.js";

export type TerminalList = "WL" | "BL" | "DR" | "AD";

export interface ProvisionCardParams {
  cardUid: string;
  list: TerminalList;
  originTerminalId?: string | null;
}

export interface ProvisionCredentialParams {
  cardUid: string;
  pin: string;
  list: "DR" | "AD";
  originTerminalId?: string | null;
}

export interface ITerminalProvisioningService {
  provisionCard(
    params: ProvisionCardParams
  ): Promise<{ success: boolean; broadcastResult?: BroadcastResult }>;
  provisionCredential(
    params: ProvisionCredentialParams
  ): Promise<{ success: boolean; broadcastResult?: BroadcastResult }>;
  deprovisionCard(
    cardUid: string,
    list: TerminalList
  ): Promise<{ success: boolean; broadcastResult?: BroadcastResult }>;
}

export class TerminalProvisioningService
  implements ITerminalProvisioningService
{
  /**
   * Adds a card to a UID-only list (currently just WL — student payment
   * cards). Sends the delta to the origin terminal first (if known), then
   * broadcasts to the fleet so every terminal converges on the same list.
   */
  async provisionCard(
    params: ProvisionCardParams
  ): Promise<{ success: boolean; broadcastResult?: BroadcastResult }> {
    const { cardUid, list, originTerminalId } = params;
    const addCommand = buildDeltaCommand("ADD", list, cardUid);

    logger.info(
      { cardUid, list, originTerminalId, command: addCommand },
      "terminal_provisioning.provision_card"
    );

    if (originTerminalId) {
      try {
        await enqueueRoute(originTerminalId, addCommand);
        logger.info(
          { originTerminalId, cardUid, list },
          "terminal_provisioning.origin_terminal_routed"
        );
      } catch (routeErr) {
        logger.warn(
          {
            originTerminalId,
            cardUid,
            list,
            err:
              routeErr instanceof Error ? routeErr.message : String(routeErr),
          },
          "terminal_provisioning.origin_terminal_route_failed_continuing_broadcast"
        );
      }
    }

    let broadcastResult: BroadcastResult | undefined;
    try {
      broadcastResult = await enqueueBroadcast(addCommand);
    } catch (broadcastErr) {
      logger.warn(
        {
          cardUid,
          list,
          err:
            broadcastErr instanceof Error
              ? broadcastErr.message
              : String(broadcastErr),
        },
        "terminal_provisioning.fleet_broadcast_failed"
      );
    }

    return { success: true, broadcastResult };
  }

  /**
   * Provisions a driver or admin card + terminal login PIN in one downlink
   * command (ADD:DR,{uid},{pin} or ADD:AD,{uid},{pin}). Only call this once
   * both the card UID and PIN are known — the firmware list has no
   * card-only intermediate state for DR/AD.
   */
  async provisionCredential(
    params: ProvisionCredentialParams
  ): Promise<{ success: boolean; broadcastResult?: BroadcastResult }> {
    const { cardUid, pin, list, originTerminalId } = params;
    const addCommand = buildDeltaCommand("ADD", list, cardUid, pin);

    logger.info(
      {
        cardUid,
        list,
        originTerminalId,
        command: `ADD:${list},${cardUid},****`,
      },
      "terminal_provisioning.provision_credential"
    );

    if (originTerminalId) {
      try {
        await enqueueRoute(originTerminalId, addCommand);
        logger.info(
          { originTerminalId, cardUid, list },
          "terminal_provisioning.origin_terminal_routed"
        );
      } catch (routeErr) {
        logger.warn(
          {
            originTerminalId,
            cardUid,
            list,
            err:
              routeErr instanceof Error ? routeErr.message : String(routeErr),
          },
          "terminal_provisioning.origin_terminal_route_failed_continuing_broadcast"
        );
      }
    }

    let broadcastResult: BroadcastResult | undefined;
    try {
      broadcastResult = await enqueueBroadcast(addCommand);
    } catch (broadcastErr) {
      logger.warn(
        {
          cardUid,
          list,
          err:
            broadcastErr instanceof Error
              ? broadcastErr.message
              : String(broadcastErr),
        },
        "terminal_provisioning.fleet_broadcast_failed"
      );
    }

    return { success: true, broadcastResult };
  }

  /**
   * Removes a card from the given list by broadcasting REM:{list},{uid} to
   * the fleet. Which list to target depends on the card owner's role —
   * callers must resolve that before calling this (see card.service.ts).
   */
  async deprovisionCard(
    cardUid: string,
    list: TerminalList
  ): Promise<{ success: boolean; broadcastResult?: BroadcastResult }> {
    const remCommand = buildDeltaCommand("REM", list, cardUid);

    logger.info(
      { cardUid, list, command: remCommand },
      "terminal_provisioning.deprovision_card"
    );

    try {
      const broadcastResult = await enqueueBroadcast(remCommand);
      return { success: true, broadcastResult };
    } catch (err) {
      logger.warn(
        {
          cardUid,
          list,
          err: err instanceof Error ? err.message : String(err),
        },
        "terminal_provisioning.deprovision_broadcast_failed"
      );
      return { success: false };
    }
  }
}

export const terminalProvisioningService = new TerminalProvisioningService();
