import { UserError } from "fastmcp";
import { getPrisma } from "../db/client.ts";

export async function assertToolAllowed(tenantId: string, toolName: string): Promise<void> {
  const prisma = getPrisma();
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

  if (!tenant.writeToolsEnabled) {
    throw new UserError(`Write tools disabled for tenant ${tenantId}`);
  }

  if (tenant.allowedWriteTools.length > 0 && !tenant.allowedWriteTools.includes(toolName)) {
    throw new UserError(`Tool ${toolName} not in allowed list for tenant ${tenantId}`);
  }
}
