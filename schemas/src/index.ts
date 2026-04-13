/**
 * @openconnectors/schemas
 *
 * Normalized data schemas shared across all plugins and consumer apps.
 * Every plugin emits data conforming to these schemas so that downstream
 * tools (tax prep, net-worth trackers, document vaults) can consume
 * data from any institution without custom parsing.
 */

export {
  TransactionSchema,
  type Transaction,
  TransactionCategory,
} from "./transaction.js";

export {
  DocumentSchema,
  type Document,
  DocumentType,
} from "./document.js";

export {
  Form106Schema,
  type Form106,
  Form106ToIRSMapping,
  type Form106FieldMapping,
} from "./form106.js";
