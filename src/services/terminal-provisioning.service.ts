// src/services/terminal-provisioning.service.ts
//
// Hardware-isolated provisioning service for C-Transit terminals.
//
// NOTE ON HARDWARE DEPENDENCY:
// The hardware developer will provide the exact downlink/broadcast payload type
// for driver-card + PIN provisioning to physical terminals.
// DO NOT invent a fake protocol or pretend it is final.
//
// This service cleanly encapsulates:
// 1. Physical card whitelist delta distribution (ADD:WL, DEL:WL).
// 2. Terminal-specific and fleet broadcast routing.
// 3. Driver PIN provisioning placeholder pending final hardware downlink contract.

import { enqueueRoute, enqueueBroadcast, BroadcastResult } from "../utils/bridge.js";
import { buildDeltaCommand } from "../utils/parser.js";
import logger from "../config/logger.js";

export interface ProvisionDriverCardParams {
  cardUid: string;
  driverUid: string;
  originTerminalId?: string | null;
}

export interface ProvisionDriverPinParams {
  cardUid: string;
  driverUid: string;
  terminalId?: string | null;
}

export interface ITerminalProvisioningService {
  provisionDriverCard(params: ProvisionDriverCardParams): Promise<{ success: boolean; broadcastResult?: BroadcastResult }>;
  provisionDriverPin(params: ProvisionDriverPinParams): Promise<{ success: boolean; pendingHardwareContract: boolean }>;
  deprovisionCard(cardUid: string): Promise<{ success: boolean; broadcastResult?: BroadcastResult }>;
}

export class TerminalProvisioningService implements ITerminalProvisioningService {
  /**
   * Provisions a driver physical card to the origin terminal and fleet whitelist.
   * Sends ADD:WL delta command to the origin terminal first (if available) and
   * broadcasts to all fleet terminals.
   */
  async provisionDriverCard(params: ProvisionDriverCardParams): Promise<{ success: boolean; broadcastResult?: BroadcastResult }> {
    const { cardUid, driverUid, originTerminalId } = params;
    const addWlCommand = buildDeltaCommand("ADD", "WL", cardUid);

    logger.info(
      { cardUid, driverUid, originTerminalId, command: addWlCommand },
      "terminal_provisioning.provision_driver_card"
    );

    // 1. Targeted downlink to origin terminal if available
    if (originTerminalId) {
      try {
        await enqueueRoute(originTerminalId, addWlCommand);
        logger.info(
          { originTerminalId, cardUid },
          "terminal_provisioning.origin_terminal_routed"
        );
      } catch (routeErr) {
        logger.warn(
          { originTerminalId, cardUid, err: routeErr instanceof Error ? routeErr.message : String(routeErr) },
          "terminal_provisioning.origin_terminal_route_failed_continuing_broadcast"
        );
      }
    }

    // 2. Fleet-wide broadcast for card whitelist synchronization
    let broadcastResult: BroadcastResult | undefined;
    try {
      broadcastResult = await enqueueBroadcast(addWlCommand);
    } catch (broadcastErr) {
      logger.warn(
        { cardUid, err: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr) },
        "terminal_provisioning.fleet_broadcast_failed"
      );
    }

    return { success: true, broadcastResult };
  }

  /**
   * Provisions driver PIN credentials to the active terminal.
   *
   * ARCHITECTURAL BOUNDARY:
   * The exact downlink payload specification (e.g., DRV:PIN_PROV,<cardUid>,<encrypted_pin>)
   * is pending confirmation from the terminal hardware engineering team.
   * The backend domain logic securely hashes and persists the PIN, and this method
   * isolates the terminal downlink operation until that hardware protocol is finalized.
   */
  async provisionDriverPin(params: ProvisionDriverPinParams): Promise<{ success: boolean; pendingHardwareContract: boolean }> {
    const { cardUid, driverUid, terminalId } = params;

    logger.info(
      {
        cardUid,
        driverUid,
        terminalId: terminalId || "all",
        pendingContract: "DRIVER_PIN_DOWNLINK_PROTOCOL",
      },
      "terminal_provisioning.pin_provisioning_dispatched_awaiting_hardware_payload_spec"
    );

    // Hardware payload stub: When hardware team defines downlink format (e.g. `CMD:DRV_PIN`),
    // it will be routed here via enqueueRoute(terminalId, cmd) or enqueueBroadcast(cmd).
    return {
      success: true,
      pendingHardwareContract: true,
    };
  }

  /**
   * Deprovisions a card from all terminals by broadcasting DEL:WL.
   */
  async deprovisionCard(cardUid: string): Promise<{ success: boolean; broadcastResult?: BroadcastResult }> {
    const delWlCommand = buildDeltaCommand("DEL", "WL", cardUid);

    logger.info({ cardUid, command: delWlCommand }, "terminal_provisioning.deprovision_card");

    try {
      const broadcastResult = await enqueueBroadcast(delWlCommand);
      return { success: true, broadcastResult };
    } catch (err) {
      logger.warn(
        { cardUid, err: err instanceof Error ? err.message : String(err) },
        "terminal_provisioning.deprovision_broadcast_failed"
      );
      return { success: false };
    }
  }
}

export const terminalProvisioningService = new TerminalProvisioningService();
