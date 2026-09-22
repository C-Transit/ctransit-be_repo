// src/routes/internal.routes.ts
//
// Internal service-to-service routes — not exposed to end users.
// All routes here require the X-Internal-Secret header.
//
// Mounted at /internal in app.ts.

import { Router } from "express";
import { requireInternalSecret, handleSettle } from "../controller/settlement.controller.js";

const router = Router();

// Apply secret guard to all /internal/* routes
router.use(requireInternalSecret);

// POST /internal/settle
// Called by the MQTT microservice after a successful card tap.
// Triggers atomic ride settlement: student debit, driver credit, platform credit.
router.post("/settle", handleSettle);

export default router;
