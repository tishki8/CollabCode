import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

// Reuse one client per process (Next.js dev hot reload would otherwise open many).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
