export { NexusCryptoError, ERROR_CODES, type NexusCryptoErrorCode } from "./errors.js";
export { FORMAT_VERSION, PASSWORD_KDF, PASSWORD_KDF_LIMITS, RECOVERY_ALPHABET } from "./constants.js";
export type { NoteContext, VaultContext } from "./associated-data.js";
export { generateVaultKey, encryptNote, decryptNote, type NoteRecord } from "./note.js";
export { padmeLength } from "./padme.js";
export { noteIdFromKey } from "./note-id.js";
export { generateRecoveryKey, formatRecoveryKey, parseRecoveryKey, normalise as normaliseRecoveryText } from "./recovery-key.js";
export {
  wrapVaultKeyWithRecoveryKey,
  unwrapVaultKeyWithRecoveryKey,
  createPasswordWrap,
  openPasswordWrap,
  type PasswordKdfParameters,
} from "./wraps.js";
export {
  generateDeviceKeyPair,
  devicePublicKey,
  sealApproval,
  openApproval,
  approvalCode,
  deviceKeyCode,
  readApprovalCode,
  type ApprovalCodeInput,
  type DeviceKeyPair,
  type OpenedApproval,
} from "./approval.js";
