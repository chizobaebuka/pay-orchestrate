// A plain options object (not an ioredis instance) — BullMQ bundles its own pinned
// ioredis version, which conflicts at the type level with our top-level ioredis.
// Passing a plain object lets BullMQ construct its connections internally.
const redisUrl = new URL(process.env.REDIS_URL as string);

export const bullConnection = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port),
    username: redisUrl.username || undefined,
    password: redisUrl.password || undefined,
    tls: redisUrl.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
};
