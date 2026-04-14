/**
 * @openconnectors/runtime — Public API
 *
 * Exports for programmatic use of the connector loader, credential vault,
 * and MCP server.
 */

export { ConnectorLoader, type LoadedConnector } from "./lib/connector-loader.js";
export {
  ConnectorSchema,
  InstitutionSchema,
  ActionSchema,
  StepSchema,
  CredentialSpecSchema,
  type Connector,
  type ConnectorAction,
  type ConnectorCredential,
  type ConnectorStep,
} from "./lib/connector-schema.js";
export { CredentialVault } from "./lib/vault.js";
export { startMcpServer } from "./lib/mcp-server.js";
