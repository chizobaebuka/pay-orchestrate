import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { Transaction } from "../db/entities/transaction";

let io: SocketIOServer | undefined;

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
    io = new SocketIOServer(httpServer, {
        cors: { origin: "*" },
    });

    io.on("connection", (socket) => {
        console.log(`Dashboard client connected: ${socket.id}`);
    });

    return io;
}

export function broadcastTransactionUpdate(transaction: Transaction) {
    io?.emit("transaction:update", {
        id: transaction.id,
        provider: transaction.provider,
        providerReference: transaction.providerReference,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        customerEmail: transaction.customerEmail,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
    });
}
