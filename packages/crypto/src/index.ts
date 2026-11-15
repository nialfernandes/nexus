export { NexusCryptoError, ERROR_CODES, type NexusCryptoErrorCode } from "./errors.js";
export { FORMAT_VERSION, PASSWORD_KDF, PASSWORD_KDF_LIMITS, RECOVERY_ALPHABET } from "./constants.js";
export type { NoteContext, VaultContext } from "./associated-data.js";
export { generateVaultKey, encryptNote, decryptNote, type NoteRecord } from "./note.js";
export { padmeLength } from "./padme.js";
export { generateRecoveryKey, formatRecoveryKey, parseRecoveryKey } from "./recovery-key.js";
export {
  wrapVaultKeyWithRecoveryKey,
  unwrapVaultKeyWithRecoveryKey,
  createPasswordWrap,
  openPasswordWrap,
  type PasswordKdfParameters,
} from "./wraps.js";
export {
  generateDeviceKeyPair,
  sealApproval,
  openApproval,
  approvalCode,
  readApprovalCode,
  type ApprovalCodeInput,
  type DeviceKeyPair,
  type OpenedApproval,
} from "./approval.js";
