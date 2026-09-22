import prisma from "../lib/prisma.js";
import env from "../config/env.js";
import logger from "../config/logger.js";
import { Prisma } from "@prisma/client";

export interface LocationFareDefinition {
  code: string;
  locationName: string;
  amount: number;
}

export const INITIAL_FARE_CONFIGS: Record<string, LocationFareDefinition> = {
  A: { code: "A", locationName: "Bus Park", amount: 150 },
  B: { code: "B", locationName: "Department", amount: 200 },
  C: { code: "C", locationName: "Hostel/Clinic", amount: 300 },
};

export const INITIAL_FARES_LIST: LocationFareDefinition[] = Object.values(INITIAL_FARE_CONFIGS);

export interface FareConfigRecord {
  id: string;
  code: string;
  location_name: string;
  amount: number;
  updated_by?: string | null;
  created_at: Date;
  updated_at: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

export async function getFareConfigs(dbClient: DbClient = prisma): Promise<FareConfigRecord[]> {
  const configs = await dbClient.fareConfig.findMany({
    orderBy: { code: "asc" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return configs.map((c: any) => ({
    id: c.id,
    code: c.code || c.location_code,
    location_name: c.location_name,
    amount: parseFloat(c.amount.toString()),
    updated_by: c.updated_by,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));
}


export async function getFareByCode(
  code: string,
  dbClient: DbClient = prisma
): Promise<FareConfigRecord | null> {
  const upperCode = code.toUpperCase();
  const config = await dbClient.fareConfig.findUnique({
    where: { code: upperCode, location_code: upperCode },
  });

  if (config) {
    return {
      id: config.id,
      code: config.code || config.location_code,
      location_name: config.location_name,
      amount: parseFloat(config.amount.toString()),
      updated_by: config.updated_by,
      created_at: config.created_at,
      updated_at: config.updated_at,
    };
  }

  // Safe fallback if database row is not present yet
  const defaultDef = INITIAL_FARE_CONFIGS[upperCode];
  if (defaultDef) {
    return {
      id: `fallback-${upperCode}`,
      code: defaultDef.code,
      location_name: defaultDef.locationName,
      amount: defaultDef.amount,
      updated_by: "SYSTEM_FALLBACK",
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  return null;
}


export async function getEffectiveFareAmount(
  location?: string | null,
  fallbackBaseFare: number = env.ledger.baseFare,
  dbClient: DbClient = prisma
): Promise<number> {
  if (!location) {
    return fallbackBaseFare;
  }
  const fareRecord = await getFareByCode(location, dbClient);
  if (fareRecord) {
    return fareRecord.amount;
  }
  return fallbackBaseFare;
}

export async function upsertFareConfig(
  params: {
    code?: string;
    locationCode?: string;
    locationName: string;
    amount: number;
    updatedBy?: string;
    description?: string;
  },
  dbClient: DbClient = prisma
): Promise<FareConfigRecord> {
  const rawCode = params.code || params.locationCode || "";
  const upperCode = rawCode.toUpperCase();

  const decimalAmount = new Prisma.Decimal(params.amount);

  const saved = await dbClient.fareConfig.upsert({
    where: { code: upperCode, location_code: upperCode },
    update: {
      location_name: params.locationName,
      amount: decimalAmount,
      updated_by: params.updatedBy || null,
    },
    create: {
      code: upperCode,
      location_name: params.locationName,
      amount: decimalAmount,
      updated_by: params.updatedBy || null,
    },
  });

  logger.info(
    { code: upperCode, amount: params.amount, locationName: params.locationName, updatedBy: params.updatedBy },
    "fare_config.upserted"
  );

  return {
    id: saved.id,
    code: saved.code || saved.location_code || upperCode,
    location_name: saved.location_name,
    amount: parseFloat(saved.amount.toString()),
    updated_by: saved.updated_by,
    created_at: saved.created_at,
    updated_at: saved.updated_at,
  };
}


export async function seedInitialFares(dbClient: DbClient = prisma): Promise<number> {
  let count = 0;
  for (const def of Object.values(INITIAL_FARE_CONFIGS)) {
    if (dbClient.fareConfig.upsert) {
      await dbClient.fareConfig.upsert({
        where: { code: def.code, location_code: def.code },
        update: {
          location_name: def.locationName,
          amount: new Prisma.Decimal(def.amount),
        },
        create: {
          code: def.code,
          location_name: def.locationName,
          amount: new Prisma.Decimal(def.amount),
          updated_by: "SYSTEM_INIT",
        },
      });
      count++;
    } else {
      const existing = await dbClient.fareConfig.findUnique({
        where: { code: def.code, location_code: def.code },
      });
      if (!existing) {
        await dbClient.fareConfig.create({
          data: {
            code: def.code,
            location_name: def.locationName,
            amount: new Prisma.Decimal(def.amount),
            updated_by: "SYSTEM_INIT",
          },
        });
        count++;
        logger.info({ code: def.code, amount: def.amount }, "fare_config.seeded");
      }
    }
  }
  return count;
}
