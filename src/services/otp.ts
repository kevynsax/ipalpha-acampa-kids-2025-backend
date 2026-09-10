import { config } from "../config";
import { sha256 } from "../utils";

export interface GeneratedOtp {
  provider: "comtele" | "local";
  /** only present in local mode (dev mock) */
  codeHash?: string;
}

export function generateLocalCode(): string {
  let code = "";
  for (let i = 0; i < config.otp.length; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

export function hashCode(code: string): string {
  return sha256(code);
}

export function verifyLocalCode(code: string, codeHash: string): boolean {
  return hashCode(code) === codeHash;
}
