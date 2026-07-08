import "reflect-metadata";
import http from "http";
import path from "path";
import express from "express";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
import { AppDataSource } from "./db/data-source";
import { redisClient } from "./db/redis-client";
import orchestrationRoutes from "./orchestration/orchestration.routes";
import webhooksRoutes from "./webhooks/webhooks.routes";
import { startReconciliationWorker } from "./queues/reconciliation.worker";
import { initSocketServer } from "./realtime/socket";
import { openApiSpec } from "./docs/openapi";

dotenv.config();

const app = express();
const httpServer = http.createServer(app);

// Mounted before express.json() so webhook signature verification gets the raw body.
app.use("/webhooks", webhooksRoutes);

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", async (_req, res) => {
    const redisStatus = await redisClient.ping().then(() => "ok").catch(() => "down");
    res.json({ status: "ok", db: "ok", redis: redisStatus });
});

app.get("/api-docs.json", (_req, res) => res.json(openApiSpec));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

app.use("/api", orchestrationRoutes);

const PORT = process.env.PORT || 4000;

const waitForRedis = () =>
    new Promise<void>((resolve, reject) => {
        if (redisClient.status === "ready") return resolve();
        redisClient.once("ready", () => resolve());
        redisClient.once("error", reject);
    });

Promise.all([AppDataSource.initialize(), waitForRedis()])
    .then(() => {
        console.log("Database connected");
        startReconciliationWorker();
        initSocketServer(httpServer);
        httpServer.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch((err) => {
        console.error("Startup failed:", err);
        process.exit(1);
    });