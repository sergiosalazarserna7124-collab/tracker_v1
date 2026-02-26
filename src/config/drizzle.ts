import { drizzle } from "drizzle-orm/node-postgres";
import { db as pgPool } from "./database.js";
import * as schema from "../db/schema.js";

export const drizzleDb = drizzle(pgPool, { schema });
