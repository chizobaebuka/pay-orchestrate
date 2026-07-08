import "reflect-metadata";
import path from "path";
import { DataSource } from "typeorm";
import dotenv from "dotenv";

dotenv.config();

// __dirname-relative with both extensions so this resolves correctly whether running
// under ts-node (src/db/*.ts, dev) or the compiled output (dist/db/*.js, production) —
// a hardcoded "src/**/*.ts" glob only works under ts-node and silently breaks `node dist/index.js`.
export const AppDataSource = new DataSource({
    type: "postgres",
    url: process.env.DATABASE_URL,
    ssl:
        process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
            ? { rejectUnauthorized: false } // Neon and other remote hosts require SSL
            : false,
    synchronize: false, // we'll use migrations, not auto-sync
    logging: true,
    entities: [path.join(__dirname, "entities", "**", "*.{ts,js}")],
    migrations: [path.join(__dirname, "migrations", "**", "*.{ts,js}")],
});